import type { TranscriptDocument } from "../domain/transcript.js";

export const SUPPORTED_OPENCLAW_VERSION = "2026.6.11";

export interface CreatedSession { sessionId: string; sessionKey: string; transcriptPath: string }
export interface SessionOverrides {
  modelOverride?: string;
  thinkingLevel?: string;
  reasoningLevel?: "on" | "off" | "stream";
}

export interface CommandChoice { value: string; label?: string }
export interface CommandArgument {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
  dynamic?: boolean;
  choices?: CommandChoice[];
}
export interface GatewayCommand {
  name: string;
  nativeName?: string;
  textAliases: string[];
  description?: string;
  category?: string;
  source?: string;
  scope?: string;
  acceptsArgs: boolean;
  args?: CommandArgument[];
}
export interface CommandsCatalog { commands: GatewayCommand[] }

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type GatewayStatus = { [key: string]: JsonValue };

export interface OpenClawModel {
  key: string;
  name: string;
  input: string;
  contextWindow: number;
  available: boolean;
  tags: string[];
  missing: boolean;
}
export interface ModelsCatalog { count: number; models: OpenClawModel[] }

export interface GatewayClient {
  version(): Promise<string>;
  createSession(runtimeAgentId: string): Promise<CreatedSession>;
  send(sessionKey: string, message: string, idempotencyKey: string): Promise<{ runId: string }>;
  waitForCompletion(sessionId: string, runId: string, signal?: AbortSignal): Promise<void>;
  abort(sessionKey: string, runId?: string, sessionId?: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
  applySessionOverrides?(sessionKey: string, overrides: SessionOverrides): Promise<void>;
  listCommands?(): Promise<CommandsCatalog>;
  status?(): Promise<GatewayStatus>;
  listModels?(): Promise<ModelsCatalog>;
}

export interface BridgeRequest {
  runtimeAgentId: string;
  historyThroughPreviousRun: TranscriptDocument;
  latestUserMessage: string;
  latestUserEntryId: string;
  idempotencyKey: string;
  overrides?: SessionOverrides;
  signal?: AbortSignal;
  lifecycle?: BridgeLifecycleCallback;
  cleanupFailed?: () => Promise<void>;
}

export interface BridgeResult { runId: string; sessionId: string; entries: TranscriptDocument["entries"] }

// These events are persistence boundaries, not a diagnostic log. In particular,
// message content is only exposed by entries_materialized, whose payload is the
// completed result that the caller must durably save before bridge cleanup begins.
export type BridgeLifecycleEvent =
  | { type: "temporary_session_created"; runtimeAgentId: string; sessionId: string; sessionKey: string; transcriptPath: string }
  | { type: "history_materialized"; previousEntryCount: number }
  | { type: "gateway_send_accepted"; gatewayRunId: string }
  | { type: "entries_materialized"; entries: TranscriptDocument["entries"] };

export type BridgeLifecycleCallback = (event: BridgeLifecycleEvent) => Promise<void>;

export interface BridgeOrphanCleanupRequest {
  runtimeAgentId: string;
  sessionId: string;
  sessionKey: string;
  gatewayRunId?: string;
}

export function assertSupportedVersion(actual: string): void {
  if (actual !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(`OPENCLAW_VERSION_UNSUPPORTED: 只支持 ${SUPPORTED_OPENCLAW_VERSION}，实际为 ${actual}`);
  }
}

// 实际 RPC 和临时 transcript 物化由具体客户端实现。本接口明确规定顺序，
// 使服务层不能绕过 create，也不能把最新用户消息提前写进历史。
export interface BridgeMaterializer {
  replaceCreatedTranscript(created: CreatedSession, history: TranscriptDocument): Promise<number>;
  readNewEntries(created: CreatedSession, previousEntryCount: number): Promise<TranscriptDocument["entries"]>;
  verifyAndStripSubmittedUser(entries: TranscriptDocument["entries"], expectedMessage: string, panelUserEntryId: string): TranscriptDocument["entries"];
}

export async function runBridge(client: GatewayClient, materializer: BridgeMaterializer, request: BridgeRequest): Promise<BridgeResult> {
  assertSupportedVersion(await client.version());
  const created = await client.createSession(request.runtimeAgentId);
  await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: request.runtimeAgentId,
    sessionId: created.sessionId, sessionKey: created.sessionKey, transcriptPath: created.transcriptPath });
  const previousCount = await materializer.replaceCreatedTranscript(created, request.historyThroughPreviousRun);
  await request.lifecycle?.({ type: "history_materialized", previousEntryCount: previousCount });
  if (request.overrides && Object.keys(request.overrides).length > 0) {
    if (!client.applySessionOverrides) throw new Error("GATEWAY_SESSION_OVERRIDES_UNSUPPORTED");
    await client.applySessionOverrides(created.sessionKey, request.overrides);
  }
  const { runId } = await client.send(created.sessionKey, request.latestUserMessage, request.idempotencyKey);
  await request.lifecycle?.({ type: "gateway_send_accepted", gatewayRunId: runId });
  const abort = () => {
    void client.abort(created.sessionKey, runId, created.sessionId).catch(() => undefined);
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
    await client.waitForCompletion(created.sessionId, runId, request.signal);
    if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
  } finally { request.signal?.removeEventListener("abort", abort); }
  const added = await materializer.readNewEntries(created, previousCount);
  const entries = materializer.verifyAndStripSubmittedUser(added, request.latestUserMessage, request.latestUserEntryId);
  await request.lifecycle?.({ type: "entries_materialized", entries });
  return { runId, sessionId: created.sessionId, entries };
}
