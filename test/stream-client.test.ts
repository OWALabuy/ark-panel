import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGatewayStreamEvent, OpenClawStreamObserver, type GatewayStreamEvent } from "../src/gateway/stream-client.js";

test("stream parser accepts full text snapshots and tool lifecycle while rejecting malformed or oversized payloads", () => {
  assert.deepEqual(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", seq: 2, state: "delta",
    message: { content: [{ type: "text", text: "你好" }] }, deltaText: "好" }),
    { type: "assistant_text", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 2, text: "你好", deltaText: "好", replace: false });
  assert.deepEqual(normalizeGatewayStreamEvent("session.tool", { runId: "run", sessionKey: "agent:a:s", seq: 3, stream: "tool",
    data: { phase: "start", toolCallId: "call", name: "exec", args: { command: "true" } } }),
    { type: "tool", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 3, callId: "call", name: "exec", phase: "started", args: { command: "true" } });
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", state: "delta", message: {} }), undefined);
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", state: "delta", message: { content: "x".repeat(2 * 1024 * 1024 + 1) } }), undefined);
});

class FakeSocket {
  readyState = 1; sent: Record<string, unknown>[] = []; private listeners = new Map<string, Set<(event: never) => void>>();
  constructor(private readonly onRequest: (socket: FakeSocket, frame: Record<string, unknown>) => void) {}
  addEventListener(type: string, listener: (event: never) => void): void { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  send(data: string): void { const frame = JSON.parse(data) as Record<string, unknown>; this.sent.push(frame); this.onRequest(this, frame); }
  close(code = 1000, reason = ""): void { this.readyState = 3; this.emit("close", { code, reason }); }
  error(): void { this.emit("error", {}); }
  message(frame: unknown): void { this.emit("message", { data: JSON.stringify(frame) }); }
  challenge(): void { this.message({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
}

test("observer uses backend identity, routes sessions independently, and resubscribes after reconnect", async () => {
  const sockets: FakeSocket[] = [], methods: string[] = [];
  const factory = () => {
    const socket = new FakeSocket((current, frame) => {
      const method = String(frame.method), id = String(frame.id); methods.push(method);
      if (method === "sessions.send") {
        const params = frame.params as Record<string, unknown>;
        const allowed = new Set(["key", "agentId", "message", "thinking", "attachments", "timeoutMs", "idempotencyKey"]);
        const unexpected = Object.keys(params).filter(key => !allowed.has(key));
        if (unexpected.length) {
          queueMicrotask(() => current.message({ type: "res", id, ok: false,
            error: { message: `invalid sessions.send params: unexpected property '${unexpected[0]}'` } }));
          return;
        }
      }
      const payload = method === "connect" ? { server: { version: "2026.6.11" }, auth: { scopes: ["operator.read", "operator.write"] } } :
        method === "sessions.send" ? { runId: "attachment-run" } : { subscribed: true };
      queueMicrotask(() => current.message({ type: "res", id, ok: true, payload }));
    });
    sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 500,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  const first: GatewayStreamEvent[] = [], second: GatewayStreamEvent[] = [];
  const unobserveFirst = await observer.observe("agent:a:first", event => first.push(event));
  const unobserveSecond = await observer.observe("agent:a:second", event => second.push(event));
  const connect = sockets[0]!.sent.find(frame => frame.method === "connect")!.params as { client: { id: string; mode: string }; scopes: string[] };
  assert.equal(connect.client.id, "gateway-client"); assert.equal(connect.client.mode, "backend");
  assert.deepEqual(connect.scopes, ["operator.read", "operator.write", "operator.admin"]);
  assert.deepEqual(await observer.send("agent:a:first", "附件", "11111111-1111-4111-8111-111111111111",
    [{ fileName: "input.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "UEs=" }]), { runId: "attachment-run" });
  const sent = sockets[0]!.sent.find(frame => frame.method === "sessions.send")!.params as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["agentId", "attachments", "idempotencyKey", "key", "message"]);
  assert.equal((sent.attachments as unknown[]).length, 1);
  sockets[0]!.message({ type: "event", event: "chat", payload: { runId: "r1", sessionKey: "agent:a:first", seq: 1, state: "delta", message: { content: "one" } } });
  assert.equal(first.some(event => event.type === "assistant_text" && event.text === "one"), true);
  assert.equal(second.some(event => event.type === "assistant_text"), false);
  sockets[0]!.close(1006, "dropped");
  for (let index = 0; index < 100 && sockets.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 2));
  for (let index = 0; index < 100 && methods.filter(value => value === "sessions.messages.subscribe").length < 4; index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(sockets.length, 2); assert.equal(methods.filter(value => value === "sessions.subscribe").length, 2);
  assert.equal(methods.filter(value => value === "sessions.messages.subscribe").length, 4);
  assert.equal(first.some(event => event.type === "connection" && event.state === "disconnected"), true);
  unobserveFirst(); unobserveSecond(); observer.stop();
});

test("observer replaces a socket that emits error without close", async () => {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
      payload: frame.method === "connect" ? { server: { version: "2026.6.11" } } : { subscribed: true } })));
    sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", requestTimeoutMs: 100,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  await observer.request("sessions.list", {});
  sockets[0]!.error();
  for (let index = 0; index < 100 && sockets.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(sockets.length, 2);
  assert.deepEqual(await observer.request("sessions.list", {}), { subscribed: true });
  observer.stop();
});

test("observer replaces a socket after an RPC timeout", async () => {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const socketIndex = sockets.length;
    const socket = new FakeSocket((current, frame) => {
      if (frame.method === "sessions.create" && socketIndex === 0) return;
      queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { server: { version: "2026.6.11" } } : { key: "agent:a:new" } }));
    });
    sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", requestTimeoutMs: 20,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(observer.request("sessions.create", {}), /gateway request timeout for sessions.create/); }
  finally { clearTimeout(keepAlive); }
  for (let index = 0; index < 100 && sockets.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(sockets.length, 2);
  assert.deepEqual(await observer.request("sessions.create", {}), { key: "agent:a:new" });
  observer.stop();
});
