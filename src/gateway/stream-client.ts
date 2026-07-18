import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { GatewayAttachment } from "./adapter.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_URL = "ws://127.0.0.1:18789";

export type GatewayStreamEvent =
  | { type: "connection"; state: "connected" | "disconnected" }
  | { type: "assistant_text"; runId: string; sessionKey: string; upstreamSeq: number; text: string; deltaText: string; replace: boolean }
  | { type: "tool"; runId: string; sessionKey: string; upstreamSeq: number; callId: string; name: string; phase: "started" | "completed" | "failed"; args?: unknown };
type GatewayDataStreamEvent = Exclude<GatewayStreamEvent, { type: "connection" }>;

export type GatewayStreamListener = (event: GatewayStreamEvent) => void;

interface WebSocketMessageEvent { data: unknown }
interface WebSocketCloseEvent { code: number; reason: string }
interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: WebSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

interface ObserverOptions {
  url: string;
  token?: string;
  password?: string;
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
  onDiagnostic?: (message: string) => void;
}

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }

function contentText(message: unknown): string | undefined {
  const raw = object(message), content = raw?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map(item => { const block = object(item); return block?.type === "text" && typeof block.text === "string" ? block.text : ""; }).join("");
  return text || undefined;
}

function safeArgs(value: unknown): unknown {
  if (value === undefined) return undefined;
  try { const encoded = JSON.stringify(value); return Buffer.byteLength(encoded, "utf8") <= 64 * 1024 ? value : { omitted: true, reason: "arguments too large" }; }
  catch { return { omitted: true, reason: "arguments are not serializable" }; }
}

export function normalizeGatewayStreamEvent(eventName: string, rawPayload: unknown): GatewayDataStreamEvent | undefined {
  const payload = object(rawPayload), runId = nonEmpty(payload?.runId), sessionKey = nonEmpty(payload?.sessionKey);
  const upstreamSeq = typeof payload?.seq === "number" && Number.isInteger(payload.seq) && payload.seq >= 0 ? payload.seq : 0;
  if (!payload || !runId || !sessionKey) return undefined;
  if (eventName === "chat" && payload.state === "delta") {
    const text = contentText(payload.message), deltaText = typeof payload.deltaText === "string" ? payload.deltaText : "";
    if (text === undefined || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return undefined;
    return { type: "assistant_text", runId, sessionKey, upstreamSeq, text, deltaText, replace: payload.replace === true };
  }
  if ((eventName === "agent" || eventName === "session.tool") && payload.stream === "tool") {
    const data = object(payload.data), rawPhase = nonEmpty(data?.phase), callId = nonEmpty(data?.toolCallId) ?? nonEmpty(data?.callId), name = nonEmpty(data?.name) ?? nonEmpty(data?.toolName);
    if (!data || !rawPhase || !callId || !name) return undefined;
    const phase = rawPhase === "start" ? "started" : rawPhase === "result" || rawPhase === "end" ? data.isError === true ? "failed" : "completed" : rawPhase === "error" ? "failed" : undefined;
    if (!phase) return undefined;
    const args = safeArgs(data.args ?? data.input);
    return { type: "tool", runId, sessionKey, upstreamSeq, callId, name, phase, ...(args !== undefined ? { args } : {}) };
  }
  return undefined;
}

export class OpenClawStreamObserver {
  private socket: WebSocketLike | undefined;
  private stopped = true;
  private connected = false;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<GatewayStreamListener>>();
  private readonly subscribed = new Set<string>();
  private readonly requestTimeoutMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly factory: (url: string) => WebSocketLike;

  constructor(private readonly options: ObserverOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.reconnectDelay = this.reconnectMinMs;
    this.factory = options.webSocketFactory ?? (url => new WebSocket(url) as unknown as WebSocketLike);
  }

  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    this.rejectPending(new Error("gateway stream observer stopped")); this.socket?.close(1000, "stopped"); this.socket = undefined; this.connected = false;
  }

  async observe(sessionKey: string, listener: GatewayStreamListener): Promise<() => void> {
    const values = this.listeners.get(sessionKey) ?? new Set<GatewayStreamListener>(); values.add(listener); this.listeners.set(sessionKey, values);
    listener({ type: "connection", state: this.connected ? "connected" : "disconnected" });
    this.start();
    try { await this.waitUntilConnected(); await this.subscribe(sessionKey); }
    catch (error) { values.delete(listener); if (!values.size) this.listeners.delete(sessionKey); throw error; }
    return () => {
      values.delete(listener); if (values.size) return; this.listeners.delete(sessionKey); this.subscribed.delete(sessionKey);
      if (this.connected) void this.request("sessions.messages.unsubscribe", { key: sessionKey }).catch(() => undefined);
    };
  }

  /** Write RPC path used for attachment payloads that cannot safely fit in a CLI argv element. */
  async send(sessionKey: string, message: string, idempotencyKey: string, attachments: readonly GatewayAttachment[]): Promise<{ runId: string }> {
    this.start(); await this.waitUntilConnected();
    const result = object(await this.request("sessions.send", { key: sessionKey, agentId: sessionKey.split(":")[1], message,
      idempotencyKey, attachments }));
    const runId = nonEmpty(result?.runId); if (!runId) throw new Error("sessions.send 未返回 runId"); return { runId };
  }

  private async waitUntilConnected(): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    while (!this.connected) {
      if (this.stopped) throw new Error("gateway stream observer stopped");
      if (Date.now() >= deadline) throw new Error("gateway stream observer connection timeout");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    let socket: WebSocketLike;
    try { socket = this.factory(this.options.url); }
    catch (error) { this.diagnostic(`connect failed: ${error instanceof Error ? error.message : String(error)}`); this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.addEventListener("message", event => this.handleMessage(event.data));
    socket.addEventListener("close", event => this.handleClose(socket, event));
    socket.addEventListener("error", () => this.diagnostic("gateway stream websocket error"));
  }

  private handleMessage(value: unknown): void {
    let frame: Record<string, unknown> | undefined;
    try {
      const raw = typeof value === "string" ? value : value instanceof ArrayBuffer ? Buffer.from(value).toString("utf8") : String(value);
      if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) { this.diagnostic("ignored oversized gateway stream frame"); return; }
      frame = object(JSON.parse(raw));
    }
    catch { this.diagnostic("ignored malformed gateway stream frame"); return; }
    if (!frame) return;
    if (frame.type === "event") {
      const eventName = nonEmpty(frame.event);
      if (eventName === "connect.challenge") { const nonce = nonEmpty(object(frame.payload)?.nonce); if (nonce) void this.connectHandshake(nonce); return; }
      if (!eventName) return;
      const normalized = normalizeGatewayStreamEvent(eventName, frame.payload); if (!normalized) return;
      for (const listener of this.listeners.get(normalized.sessionKey) ?? []) listener(normalized);
      return;
    }
    if (frame.type !== "res" || typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); clearTimeout(pending.timer);
    if (frame.ok === true) pending.resolve(frame.payload); else pending.reject(new Error(nonEmpty(object(frame.error)?.message) ?? "gateway request failed"));
  }

  private async connectHandshake(nonce: string): Promise<void> {
    try {
      const auth = this.options.token || this.options.password ? { ...(this.options.token ? { token: this.options.token } : {}), ...(this.options.password ? { password: this.options.password } : {}) } : undefined;
      const hello = object(await this.request("connect", { minProtocol: 4, maxProtocol: 4,
        client: { id: "gateway-client", displayName: "ark-panel-stream", version: "0.1.0", platform: process.platform, mode: "backend", instanceId: randomUUID() },
        caps: ["tool-events"], ...(auth ? { auth } : {}), role: "operator", scopes: ["operator.read", "operator.write"] }));
      const server = object(hello?.server), version = nonEmpty(server?.version);
      if (version !== "2026.6.11") throw new Error(`unsupported gateway version ${String(version ?? "unknown")}`);
      const helloAuth = object(hello?.auth); this.diagnostic(`connected with scopes ${Array.isArray(helloAuth?.scopes) ? helloAuth.scopes.join(",") : "unknown"}`);
      this.connected = true; this.reconnectDelay = this.reconnectMinMs; this.subscribed.clear(); this.broadcastConnection("connected");
      await this.request("sessions.subscribe", {});
      for (const key of this.listeners.keys()) await this.subscribe(key);
    } catch (error) { this.diagnostic(`handshake failed: ${error instanceof Error ? error.message : String(error)}`); this.socket?.close(4001, "handshake failed"); }
  }

  private async subscribe(sessionKey: string): Promise<void> {
    if (!this.connected || this.subscribed.has(sessionKey)) return;
    await this.request("sessions.messages.subscribe", { key: sessionKey }); this.subscribed.add(sessionKey);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket; if (!socket || socket.readyState !== 1) return Promise.reject(new Error("gateway stream is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`gateway request timeout for ${method}`)); }, this.requestTimeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ type: "req", id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private handleClose(socket: WebSocketLike, event: WebSocketCloseEvent): void {
    if (this.socket !== socket) return; this.socket = undefined; this.rejectPending(new Error(`gateway stream closed (${event.code}): ${event.reason}`));
    if (this.connected) { this.connected = false; this.subscribed.clear(); this.broadcastConnection("disconnected"); }
    if (!this.stopped) this.scheduleReconnect();
  }

  private rejectPending(error: Error): void { for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); } this.pending.clear(); }
  private broadcastConnection(state: "connected" | "disconnected"): void { for (const values of this.listeners.values()) for (const listener of values) listener({ type: "connection", state }); }
  private scheduleReconnect(): void { if (this.stopped || this.reconnectTimer) return; this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, this.reconnectDelay); this.reconnectTimer.unref(); this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs); }
  private diagnostic(message: string): void { this.options.onDiagnostic?.(message); }
}

interface GatewayAuth { url: string; token?: string; password?: string }

export async function loadGatewayStreamAuth(env: NodeJS.ProcessEnv = process.env, allowWhenStreamingDisabled = false): Promise<GatewayAuth | undefined> {
  if (!allowWhenStreamingDisabled && env.PANEL_OPENCLAW_STREAMING === "0") return undefined;
  const explicitUrl = nonEmpty(env.PANEL_OPENCLAW_GATEWAY_URL), explicitToken = nonEmpty(env.PANEL_OPENCLAW_GATEWAY_TOKEN), explicitPassword = nonEmpty(env.PANEL_OPENCLAW_GATEWAY_PASSWORD);
  if (explicitToken || explicitPassword) return { url: explicitUrl ?? DEFAULT_URL, ...(explicitToken ? { token: explicitToken } : {}), ...(explicitPassword ? { password: explicitPassword } : {}) };
  const path = resolve(env.OPENCLAW_CONFIG_PATH ?? env.OPENCLAW_CONFIG ?? `${env.HOME ?? homedir()}/.openclaw/openclaw.json`);
  try {
    const config = object(JSON.parse(await readFile(path, "utf8"))), gateway = object(config?.gateway), remote = object(gateway?.remote), auth = object(gateway?.auth);
    const remoteMode = gateway?.mode === "remote", url = explicitUrl ?? (remoteMode ? nonEmpty(remote?.url) : undefined) ?? DEFAULT_URL;
    const token = nonEmpty(remoteMode ? remote?.token : auth?.token), password = nonEmpty(remoteMode ? remote?.password : auth?.password);
    if (!token && !password && auth?.mode !== "none") return undefined;
    return { url, ...(token ? { token } : {}), ...(password ? { password } : {}) };
  } catch { return undefined; }
}
