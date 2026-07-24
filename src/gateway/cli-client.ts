import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertSupportedVersion, type CollectedOutput, type CommandArgument, type CommandsCatalog, type ConfiguredToolsCatalog, type CreatedSession, type EffectiveToolsInventory, type GatewayAttachment, type GatewayClient, type GatewayCommand, type GatewayCompactionResult, type GatewayStatus, type ModelsCatalog, type OpenClawModel, type SessionOverrides, type ToolCatalogEntry, type ToolCatalogGroup } from "./adapter.js";

interface CliOptions {
  executable?: string;
  sessionsRoots: ReadonlyMap<string, string>;
  requestTimeoutMs?: number;
  /** Maximum execution time passed to OpenClaw. */
  gatewayRunTimeoutMs?: number;
  /** Extra time for the terminal trajectory event to become visible. */
  watcherGraceMs?: number;
  /** Kept for integration tools compiled against the old option name. */
  runTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Maximum time for each local OpenClaw memory-index refresh. */
  memoryIndexTimeoutMs?: number;
  /** Trusted agent ids accepted by refreshMemoryIndex; defaults to sessionsRoots keys. */
  memoryIndexAgentIds?: ReadonlySet<string>;
  commandRunner?: (executable: string, args: string[], timeoutMs: number) => Promise<string>;
  /** Persistent gateway transport; CLI remains available for local-only commands. */
  rpc?: { request(method: string, params: unknown): Promise<unknown> };
}

export type GatewayRunErrorCode = "GATEWAY_RUN_TIMEOUT" | "GATEWAY_RUN_ABORTED" | "GATEWAY_RUN_FAILED" |
  "GATEWAY_RUN_NOT_STARTED" | "BRIDGE_WATCH_TIMEOUT" | "GATEWAY_ABORT_RELEASE_TIMEOUT";

export interface GatewayRunDiagnostics {
  sessionId: string;
  gatewayRunId: string;
  waitedMs: number;
  gatewayRunTimeoutMs: number;
  watcherGraceMs: number;
  lastObserved?: { type: string; status?: string; ts?: string; seq?: number; aborted?: boolean; timedOut?: boolean };
}

export class GatewayRunError extends Error {
  constructor(readonly code: GatewayRunErrorCode, readonly diagnostics: GatewayRunDiagnostics) { super(code); this.name = "GatewayRunError"; }
}

function runCommand(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env });
    const stdout: Buffer[] = []; let settled = false; let killTimer: NodeJS.Timeout | undefined;
    const finish = (action: () => void) => { if (settled) return; settled = true; action(); };
    const timer = setTimeout(() => {
      child.kill("SIGTERM"); killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000); killTimer.unref();
      finish(() => reject(new Error("OPENCLAW_CLI_TIMEOUT")));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", (error) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); finish(() => reject(error)); });
    child.once("close", (code) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (code === 0) finish(() => resolve(Buffer.concat(stdout).toString("utf8")));
      else finish(() => reject(new Error(`OPENCLAW_CLI_FAILED (${code})`)));
    });
  });
}

function payload(value: unknown): string { return JSON.stringify(value); }

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`OPENCLAW_INVALID_${context}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`OPENCLAW_INVALID_${context}`);
  return value;
}
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function parseArgument(value: unknown): CommandArgument {
  const raw = object(value, "COMMAND_ARGUMENT");
  const choices = Array.isArray(raw.choices) ? raw.choices.map((choice) => {
    const item = object(choice, "COMMAND_CHOICE");
    return { value: string(item.value, "COMMAND_CHOICE_VALUE"), ...(optionalString(item.label) ? { label: item.label as string } : {}) };
  }) : undefined;
  return { name: string(raw.name, "COMMAND_ARGUMENT_NAME"), ...(optionalString(raw.description) ? { description: raw.description as string } : {}),
    ...(optionalString(raw.type) ? { type: raw.type as string } : {}), ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
    ...(typeof raw.dynamic === "boolean" ? { dynamic: raw.dynamic } : {}),
    ...(choices ? { choices } : {}) };
}

export function parseCommandsCatalog(value: unknown): CommandsCatalog {
  const raw = object(value, "COMMANDS_LIST");
  if (!Array.isArray(raw.commands)) throw new Error("OPENCLAW_INVALID_COMMANDS_LIST");
  const commands: GatewayCommand[] = raw.commands.map((value) => {
    const item = object(value, "COMMAND");
    const args = Array.isArray(item.args) ? item.args.map(parseArgument) : undefined;
    return { name: string(item.name, "COMMAND_NAME"), textAliases: stringArray(item.textAliases), acceptsArgs: item.acceptsArgs === true,
      ...(optionalString(item.nativeName) ? { nativeName: item.nativeName as string } : {}),
      ...(optionalString(item.description) ? { description: item.description as string } : {}),
      ...(optionalString(item.category) ? { category: item.category as string } : {}),
      ...(optionalString(item.source) ? { source: item.source as string } : {}), ...(optionalString(item.scope) ? { scope: item.scope as string } : {}),
      ...(args ? { args } : {}) };
  });
  return { commands };
}

export function parseGatewayStatus(value: unknown): GatewayStatus {
  return object(value, "STATUS") as GatewayStatus;
}

export function parseModelsCatalog(value: unknown): ModelsCatalog {
  const raw = object(value, "MODELS_LIST");
  if (!Array.isArray(raw.models)) throw new Error("OPENCLAW_INVALID_MODELS_LIST");
  const models: OpenClawModel[] = raw.models.map((value) => {
    const item = object(value, "MODEL");
    if (typeof item.contextWindow !== "number" || !Number.isFinite(item.contextWindow) || typeof item.available !== "boolean" || typeof item.missing !== "boolean") {
      throw new Error("OPENCLAW_INVALID_MODEL");
    }
    return { key: string(item.key, "MODEL_KEY"), name: string(item.name, "MODEL_NAME"), input: string(item.input, "MODEL_INPUT"),
      contextWindow: item.contextWindow, available: item.available, tags: stringArray(item.tags), missing: item.missing };
  });
  return { count: models.length, models };
}

function parseTool(value: unknown): ToolCatalogEntry {
  const item = object(value, "TOOL_CATALOG_ENTRY"), source = string(item.source, "TOOL_CATALOG_SOURCE");
  if (source !== "core" && source !== "plugin") throw new Error("OPENCLAW_INVALID_TOOL_CATALOG_SOURCE");
  const risk = optionalString(item.risk); if (risk !== undefined && !["low", "medium", "high"].includes(risk)) throw new Error("OPENCLAW_INVALID_TOOL_CATALOG_RISK");
  return { id: string(item.id, "TOOL_CATALOG_ID"), label: string(item.label, "TOOL_CATALOG_LABEL"),
    description: string(item.description, "TOOL_CATALOG_DESCRIPTION"), source,
    defaultProfiles: stringArray(item.defaultProfiles), ...(optionalString(item.pluginId) ? { pluginId: item.pluginId as string } : {}),
    ...(typeof item.optional === "boolean" ? { optional: item.optional } : {}),
    ...(risk ? { risk: risk as "low" | "medium" | "high" } : {}), ...(Array.isArray(item.tags) ? { tags: stringArray(item.tags) } : {}) };
}

export function parseConfiguredToolsCatalog(value: unknown): ConfiguredToolsCatalog {
  const raw = object(value, "TOOLS_CATALOG"); if (!Array.isArray(raw.groups)) throw new Error("OPENCLAW_INVALID_TOOLS_CATALOG");
  const groups: ToolCatalogGroup[] = raw.groups.map(value => { const item = object(value, "TOOL_CATALOG_GROUP"), source = string(item.source, "TOOL_CATALOG_GROUP_SOURCE");
    if (source !== "core" && source !== "plugin" || !Array.isArray(item.tools)) throw new Error("OPENCLAW_INVALID_TOOL_CATALOG_GROUP");
    return { id: string(item.id, "TOOL_CATALOG_GROUP_ID"), label: string(item.label, "TOOL_CATALOG_GROUP_LABEL"), source,
      ...(optionalString(item.pluginId) ? { pluginId: item.pluginId as string } : {}), tools: item.tools.map(parseTool) }; });
  return { agentId: string(raw.agentId, "TOOLS_CATALOG_AGENT"), scope: "configured-runtime-catalog", groups };
}
export function parseEffectiveToolsInventory(value: unknown): EffectiveToolsInventory {
  const raw = object(value, "TOOLS_EFFECTIVE"); if (!Array.isArray(raw.groups)) throw new Error("OPENCLAW_INVALID_TOOLS_EFFECTIVE_GROUPS");
  const toolIds = raw.groups.flatMap(group => {
    const item = object(group, "TOOLS_EFFECTIVE_GROUP"); if (!Array.isArray(item.tools)) throw new Error("OPENCLAW_INVALID_TOOLS_EFFECTIVE_TOOLS");
    return item.tools.map(tool => string(object(tool, "TOOLS_EFFECTIVE_TOOL").id, "TOOLS_EFFECTIVE_TOOL_ID"));
  });
  return { agentId: string(raw.agentId, "TOOLS_EFFECTIVE_AGENT"), scope: "effective-session-tools", toolIds: [...new Set(toolIds)].sort() };
}

export function sessionPatchParams(sessionKey: string, overrides: SessionOverrides): Record<string, string> {
  return { key: sessionKey, ...(overrides.modelOverride ? { model: overrides.modelOverride } : {}),
    ...(overrides.thinkingLevel ? { thinkingLevel: overrides.thinkingLevel } : {}),
    ...(overrides.reasoningLevel ? { reasoningLevel: overrides.reasoningLevel } : {}) };
}

interface TrajectoryEntry {
  runId?: unknown;
  type?: unknown;
  ts?: unknown;
  seq?: unknown;
  data?: { status?: unknown; aborted?: unknown; externalAbort?: unknown; timedOut?: unknown; idleTimedOut?: unknown;
    timedOutDuringCompaction?: unknown; timedOutDuringToolExecution?: unknown };
}

export function completedRunStatus(jsonl: string, runId: string): string | undefined {
  return trajectoryRunState(jsonl, runId).terminalStatus;
}

export interface TrajectoryRunState {
  seen: boolean;
  terminalStatus?: string;
  lastObserved?: GatewayRunDiagnostics["lastObserved"];
}

interface TrajectoryTracker { offset: number; remainder: string; decoder: StringDecoder; state: TrajectoryRunState }

async function pollTrajectory(path: string, runId: string, tracker: TrajectoryTracker, includeRemainder = false): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r"); const stat = await handle.stat();
    if (stat.size < tracker.offset) { tracker.offset = 0; tracker.remainder = ""; tracker.decoder = new StringDecoder("utf8"); tracker.state = { seen: false }; }
    while (tracker.offset < stat.size) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - tracker.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tracker.offset); if (!bytesRead) break; tracker.offset += bytesRead;
      const chunks = (tracker.remainder + tracker.decoder.write(buffer.subarray(0, bytesRead))).split("\n"); tracker.remainder = chunks.pop() ?? "";
      for (const line of chunks) mergeTrajectoryState(tracker.state, trajectoryRunState(line, runId));
    }
    if (includeRemainder) { tracker.remainder += tracker.decoder.end(); if (tracker.remainder) mergeTrajectoryState(tracker.state, trajectoryRunState(tracker.remainder, runId)); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  finally { await handle?.close(); }
}

function mergeTrajectoryState(target: TrajectoryRunState, next: TrajectoryRunState): void {
  if (!next.seen) return; target.seen = true;
  if (next.lastObserved) target.lastObserved = next.lastObserved;
  if (next.terminalStatus) target.terminalStatus = next.terminalStatus;
}

export function trajectoryRunState(jsonl: string, runId: string): TrajectoryRunState {
  let seen = false; let lastObserved: GatewayRunDiagnostics["lastObserved"];
  for (const line of jsonl.trimEnd().split("\n").reverse()) {
    if (!line.trim()) continue;
    let entry: TrajectoryEntry;
    try { entry = JSON.parse(line) as TrajectoryEntry; } catch { continue; }
    if (entry.runId !== runId || typeof entry.type !== "string") continue;
    seen = true;
    const data = entry.data;
    lastObserved ??= { type: entry.type, ...(typeof data?.status === "string" ? { status: data.status } : {}),
      ...(typeof entry.ts === "string" ? { ts: entry.ts } : {}), ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
      ...([data?.aborted, data?.externalAbort].some(value => typeof value === "boolean") ? { aborted: data?.aborted === true || data?.externalAbort === true } : {}),
      ...([data?.timedOut, data?.idleTimedOut, data?.timedOutDuringCompaction, data?.timedOutDuringToolExecution].some(value => typeof value === "boolean") ?
        { timedOut: data?.timedOut === true || data?.idleTimedOut === true || data?.timedOutDuringCompaction === true || data?.timedOutDuringToolExecution === true } : {}) };
    if (entry.type === "session.ended" && typeof data?.status === "string") return { seen, terminalStatus: data.status, lastObserved };
  }
  return { seen, ...(lastObserved ? { lastObserved } : {}) };
}

export class OpenClawCliClient implements GatewayClient {
  readonly executable: string; readonly sessionsRoots: ReadonlyMap<string, string>; readonly requestTimeoutMs: number;
  readonly gatewayRunTimeoutMs: number; readonly watcherGraceMs: number; readonly pollIntervalMs: number;
  readonly memoryIndexTimeoutMs: number;
  private readonly keysBySessionId = new Map<string, string>();
  private readonly sessionIdsByKey = new Map<string, string>();
  private readonly memoryIndexAgentIds: ReadonlySet<string>;
  private readonly commandRunner: (executable: string, args: string[], timeoutMs: number) => Promise<string>;
  private readonly rpc: { request(method: string, params: unknown): Promise<unknown> } | undefined;
  constructor(options: CliOptions) {
    this.executable = options.executable ?? "openclaw"; this.sessionsRoots = options.sessionsRoots;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.commandRunner = options.commandRunner ?? runCommand;
    this.rpc = options.rpc;
    this.gatewayRunTimeoutMs = options.gatewayRunTimeoutMs ?? options.runTimeoutMs ?? 30 * 60_000;
    this.watcherGraceMs = options.watcherGraceMs ?? 30_000; this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.memoryIndexTimeoutMs = options.memoryIndexTimeoutMs ?? 5 * 60_000;
    this.memoryIndexAgentIds = options.memoryIndexAgentIds ?? new Set(options.sessionsRoots.keys());
    for (const [name, value] of [["gatewayRunTimeoutMs", this.gatewayRunTimeoutMs], ["watcherGraceMs", this.watcherGraceMs], ["pollIntervalMs", this.pollIntervalMs]] as const) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
    }
    if (!Number.isInteger(this.memoryIndexTimeoutMs) || this.memoryIndexTimeoutMs < 1) throw new Error("memoryIndexTimeoutMs 必须是正整数");
  }
  private async call<T>(method: string, params: unknown, timeout = this.requestTimeoutMs): Promise<T> {
    if (this.rpc) return await this.rpc.request(method, params) as T;
    const output = await this.commandRunner(this.executable, ["gateway", "call", method, "--json", "--timeout", String(timeout), "--params", payload(params)], timeout + 2_000);
    return JSON.parse(output) as T;
  }
  async version(): Promise<string> {
    const output = await this.commandRunner(this.executable, ["--version"], this.requestTimeoutMs);
    const match = /OpenClaw\s+(\d+\.\d+\.\d+)/.exec(output);
    if (!match) throw new Error("无法识别 OpenClaw 版本"); return match[1]!;
  }
  async refreshMemoryIndex(agentIds: readonly string[]): Promise<void> {
    const targets = [...new Set(agentIds)];
    if (!targets.length || targets.some(agentId => !this.memoryIndexAgentIds.has(agentId))) throw new Error("MEMORY_INDEX_AGENT_NOT_ALLOWED");
    assertSupportedVersion(await this.version());
    for (const agentId of targets) {
      await this.commandRunner(this.executable, ["memory", "index", "--agent", agentId], this.memoryIndexTimeoutMs);
    }
  }
  async createSession(runtimeAgentId: string): Promise<CreatedSession> {
    const root = this.sessionsRoots.get(runtimeAgentId); if (!root) throw new Error("runtime agent 不在 allowlist");
    const localKey = `panel-${randomUUID()}`; const sessionKey = `agent:${runtimeAgentId}:${localKey}`;
    const created = object(await this.call<unknown>("sessions.create", { key: localKey, agentId: runtimeAgentId,
      label: `panel bridge ${localKey.slice(-8)}` }), "SESSION_CREATE");
    const returnedKey = string(created.key, "SESSION_CREATE_KEY"), sessionId = string(created.sessionId, "SESSION_CREATE_ID");
    if (returnedKey !== sessionKey) throw new Error("OPENCLAW_SESSION_CREATE_KEY_MISMATCH");
    this.keysBySessionId.set(sessionId, sessionKey);
    this.sessionIdsByKey.set(sessionKey, sessionId);
    return { sessionId, sessionKey, transcriptPath: join(root, `${sessionId}.jsonl`) };
  }
  async compactSession(sessionKey: string): Promise<GatewayCompactionResult> {
    const agentId = sessionKey.split(":")[1];
    if (!agentId || !this.sessionsRoots.has(agentId)) throw new Error("RUNTIME_NOT_CONFIGURED");
    const response = object(await this.call<unknown>("sessions.compact", { key: sessionKey, agentId }, this.gatewayRunTimeoutMs), "COMPACTION_RESPONSE");
    if (response.ok !== true) throw new Error("OPENCLAW_COMPACTION_FAILED");
    if (response.compacted !== true) {
      const result = response.result === undefined ? undefined : object(response.result, "COMPACTION_RESULT");
      const details = result?.details === undefined ? undefined : object(result.details, "COMPACTION_DETAILS");
      if (details?.pending === true || details?.signal === "thread/compact/start") throw new Error("OPENCLAW_COMPACTION_ASYNC_UNSUPPORTED");
      return { compacted: false, ...(typeof response.reason === "string" ? { reason: response.reason } : {}) };
    }
    const result = object(response.result, "COMPACTION_RESULT");
    return { compacted: true,
      ...(typeof result?.sessionId === "string" ? { sessionId: result.sessionId } : {}),
      ...(typeof result?.sessionFile === "string" ? { sessionFile: result.sessionFile } : {}) };
  }
  async applySessionOverrides(sessionKey: string, overrides: SessionOverrides): Promise<void> {
    await this.call("sessions.patch", sessionPatchParams(sessionKey, overrides));
  }
  async listCommands(): Promise<CommandsCatalog> {
    return parseCommandsCatalog(await this.call<unknown>("commands.list", {}));
  }
  async status(): Promise<GatewayStatus> {
    return parseGatewayStatus(await this.call<unknown>("status", {}));
  }
  async listModels(): Promise<ModelsCatalog> {
    const output = await this.commandRunner(this.executable, ["models", "list", "--json"], this.requestTimeoutMs);
    return parseModelsCatalog(JSON.parse(output) as unknown);
  }
  async configuredTools(runtimeAgentId: string): Promise<ConfiguredToolsCatalog> {
    if (!this.sessionsRoots.has(runtimeAgentId)) throw new Error("RUNTIME_NOT_CONFIGURED");
    return parseConfiguredToolsCatalog(await this.call<unknown>("tools.catalog", { agentId: runtimeAgentId, includePlugins: true }));
  }
  async effectiveTools(runtimeAgentId: string, sessionKey: string): Promise<EffectiveToolsInventory> {
    if (!this.sessionsRoots.has(runtimeAgentId) || sessionKey.split(":")[1] !== runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
    const result = parseEffectiveToolsInventory(await this.call<unknown>("tools.effective", { agentId: runtimeAgentId, sessionKey }));
    if (result.agentId !== runtimeAgentId) throw new Error("OPENCLAW_TOOLS_EFFECTIVE_AGENT_MISMATCH"); return result;
  }
  async send(sessionKey: string, message: string, idempotencyKey: string, attachments?: readonly GatewayAttachment[]): Promise<{ runId: string }> {
    return await this.call("sessions.send", { key: sessionKey, agentId: sessionKey.split(":")[1], message,
      ...(attachments?.length ? { attachments } : {}), timeoutMs: this.gatewayRunTimeoutMs, idempotencyKey });
  }
  async collectRunArtifacts(sessionKey: string, runId: string): Promise<CollectedOutput[]> {
    const listed = object(await this.call<unknown>("artifacts.list", { sessionKey, runId }), "ARTIFACTS_LIST");
    if (!Array.isArray(listed.artifacts)) throw new Error("OPENCLAW_INVALID_ARTIFACTS_LIST");
    const outputs: CollectedOutput[] = [];
    for (const value of listed.artifacts) {
      const summary = object(value, "ARTIFACT");
      const id = string(summary.id, "ARTIFACT_ID"), fileName = string(summary.title, "ARTIFACT_TITLE");
      const download = object(summary.download, "ARTIFACT_DOWNLOAD");
      if (download.mode !== "bytes") continue;
      const result = object(await this.call<unknown>("artifacts.download", { sessionKey, runId, artifactId: id }), "ARTIFACT_DOWNLOAD_RESULT");
      if (result.encoding !== "base64" || typeof result.data !== "string") throw new Error("OPENCLAW_INVALID_ARTIFACT_BYTES");
      const bytes = Buffer.from(result.data, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== result.data.replace(/=+$/, "")) throw new Error("OPENCLAW_INVALID_ARTIFACT_BASE64");
      outputs.push({ source: "artifact", fileName, ...(typeof summary.mimeType === "string" ? { mimeType: summary.mimeType } : {}), bytes });
    }
    return outputs;
  }
  async waitForCompletion(sessionId: string, runId: string, signal?: AbortSignal): Promise<void> {
    const key = this.keysBySessionId.get(sessionId); if (!key) throw new Error("未知 sessionId");
    const agentId = key.split(":")[1];
    const root = agentId ? this.sessionsRoots.get(agentId) : undefined;
    if (!root) throw new Error("runtime agent 不在 allowlist");
    const trajectoryPath = join(root, `${sessionId}.trajectory.jsonl`);
    const started = Date.now(), deadline = started + this.gatewayRunTimeoutMs + this.watcherGraceMs;
    const tracker: TrajectoryTracker = { offset: 0, remainder: "", decoder: new StringDecoder("utf8"), state: { seen: false } };
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("BRIDGE_ABORTED");
      await pollTrajectory(trajectoryPath, runId, tracker);
      if (tracker.state.terminalStatus === "success") return;
      if (tracker.state.terminalStatus) throw this.runError(tracker.state, sessionId, runId, Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (signal?.aborted) throw new Error("BRIDGE_ABORTED");
    await pollTrajectory(trajectoryPath, runId, tracker, true);
    if (tracker.state.terminalStatus === "success") return;
    if (tracker.state.terminalStatus) throw this.runError(tracker.state, sessionId, runId, Date.now() - started);
    throw new GatewayRunError(tracker.state.seen ? "BRIDGE_WATCH_TIMEOUT" : "GATEWAY_RUN_NOT_STARTED",
      this.diagnostics(tracker.state, sessionId, runId, Date.now() - started));
  }
  async abort(sessionKey: string, runId?: string, persistedSessionId?: string): Promise<void> {
    const response = await this.abortRpc(sessionKey, runId);
    const sessionId = persistedSessionId ?? this.sessionIdsByKey.get(sessionKey);
    const effectiveRunId = runId ?? (typeof response.abortedRunId === "string" ? response.abortedRunId : undefined);
    if (sessionId && effectiveRunId && response.status === "aborted") {
      await this.waitForTerminalRelease(sessionId, effectiveRunId);
      await this.waitForInactive(sessionKey, effectiveRunId, sessionId);
    }
  }
  async deleteSession(sessionKey: string): Promise<void> {
    const pieces = sessionKey.split(":"); const agentId = pieces[1];
    await this.call("sessions.delete", { key: sessionKey, agentId, deleteTranscript: true, emitLifecycleHooks: false });
    const sessionId = this.sessionIdsByKey.get(sessionKey); if (sessionId) this.keysBySessionId.delete(sessionId); this.sessionIdsByKey.delete(sessionKey);
  }

  private diagnostics(state: TrajectoryRunState, sessionId: string, runId: string, waitedMs: number): GatewayRunDiagnostics {
    return { sessionId, gatewayRunId: runId, waitedMs, gatewayRunTimeoutMs: this.gatewayRunTimeoutMs,
      watcherGraceMs: this.watcherGraceMs, ...(state.lastObserved ? { lastObserved: state.lastObserved } : {}) };
  }
  private runError(state: TrajectoryRunState, sessionId: string, runId: string, waitedMs: number): GatewayRunError {
    const observed = state.lastObserved;
    const code: GatewayRunErrorCode = observed?.timedOut ? "GATEWAY_RUN_TIMEOUT" : observed?.aborted || ["aborted", "interrupted"].includes(state.terminalStatus ?? "") ?
      "GATEWAY_RUN_ABORTED" : "GATEWAY_RUN_FAILED";
    return new GatewayRunError(code, this.diagnostics(state, sessionId, runId, waitedMs));
  }
  private async waitForTerminalRelease(sessionId: string, runId: string): Promise<void> {
    const key = this.keysBySessionId.get(sessionId), agentId = key?.split(":")[1], root = agentId ? this.sessionsRoots.get(agentId) : undefined;
    if (!root) return;
    const path = join(root, `${sessionId}.trajectory.jsonl`), started = Date.now(), deadline = started + this.watcherGraceMs;
    const tracker: TrajectoryTracker = { offset: 0, remainder: "", decoder: new StringDecoder("utf8"), state: { seen: false } };
    while (Date.now() < deadline) {
      await pollTrajectory(path, runId, tracker); if (tracker.state.terminalStatus) return;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    await pollTrajectory(path, runId, tracker, true); if (tracker.state.terminalStatus) return;
    throw new GatewayRunError("GATEWAY_ABORT_RELEASE_TIMEOUT", this.diagnostics(tracker.state, sessionId, runId, Date.now() - started));
  }
  private async abortRpc(sessionKey: string, runId?: string): Promise<Record<string, unknown>> {
    const response = object(await this.call<unknown>("sessions.abort", { key: sessionKey, ...(runId ? { runId } : {}) }), "ABORT_RESPONSE");
    if (response.ok !== true || !["aborted", "no-active-run"].includes(String(response.status))) throw new Error("OPENCLAW_INVALID_ABORT_RESPONSE");
    if (response.status === "aborted" && runId && response.abortedRunId !== runId) throw new Error("OPENCLAW_ABORT_RUN_MISMATCH");
    return response;
  }
  private async waitForInactive(sessionKey: string, runId: string, sessionId: string): Promise<void> {
    const started = Date.now(), deadline = started + this.watcherGraceMs;
    while (Date.now() < deadline) {
      const response = await this.abortRpc(sessionKey, runId); if (response.status === "no-active-run") return;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new GatewayRunError("GATEWAY_ABORT_RELEASE_TIMEOUT", this.diagnostics({ seen: true }, sessionId, runId, Date.now() - started));
  }
}
