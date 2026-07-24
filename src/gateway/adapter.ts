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

export interface ToolCatalogEntry {
  id: string; label: string; description: string; source: "core" | "plugin";
  pluginId?: string; optional?: boolean; risk?: "low" | "medium" | "high"; tags?: string[]; defaultProfiles: string[];
}
export interface ToolCatalogGroup { id: string; label: string; source: "core" | "plugin"; pluginId?: string; tools: ToolCatalogEntry[] }
export interface ConfiguredToolsCatalog { agentId: string; scope: "configured-runtime-catalog"; groups: ToolCatalogGroup[] }
export interface EffectiveToolsInventory { agentId: string; scope: "effective-session-tools"; toolIds: string[] }

export interface GatewayAttachment {
  fileName: string;
  mimeType: string;
  /** Base64-encoded file bytes. Office documents are passed through unchanged. */
  content: string;
}

export interface CollectedOutput {
  source: "artifact" | "output-directory";
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
}

export interface OutputCaptureRequest {
  /** Trusted, server-configured workspace root; never take this from an HTTP parameter. */
  workspaceRoot: string;
  /** Trusted server-owned directory used to quarantine a capture before recursive deletion. */
  cleanupRoot: string;
  maxFiles?: number;
  maxTotalBytes?: number;
}

export interface GatewayClient {
  version(): Promise<string>;
  /** Refreshes the file-backed memory index for trusted, server-configured OpenClaw agents. */
  refreshMemoryIndex?(agentIds: readonly string[]): Promise<void>;
  createSession(runtimeAgentId: string): Promise<CreatedSession>;
  compactSession?(sessionKey: string): Promise<GatewayCompactionResult>;
  send(sessionKey: string, message: string, idempotencyKey: string, attachments?: readonly GatewayAttachment[]): Promise<{ runId: string }>;
  waitForCompletion(sessionId: string, runId: string, signal?: AbortSignal): Promise<void>;
  abort(sessionKey: string, runId?: string, sessionId?: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
  applySessionOverrides?(sessionKey: string, overrides: SessionOverrides): Promise<void>;
  listCommands?(): Promise<CommandsCatalog>;
  status?(): Promise<GatewayStatus>;
  listModels?(): Promise<ModelsCatalog>;
  configuredTools?(runtimeAgentId: string): Promise<ConfiguredToolsCatalog>;
  effectiveTools?(runtimeAgentId: string, sessionKey: string): Promise<EffectiveToolsInventory>;
  collectRunArtifacts?(sessionKey: string, runId: string): Promise<CollectedOutput[]>;
}

export interface GatewayCompactionResult {
  compacted: boolean;
  reason?: string;
  sessionId?: string;
  sessionFile?: string;
}

export interface BridgeCompactionRequest {
  runtimeAgentId: string;
  history: TranscriptDocument;
  overrides?: SessionOverrides;
}

export interface BridgeCompactionResult {
  compacted: boolean;
  reason?: string;
  entry?: TranscriptDocument["entries"][number];
}

export interface BridgeRequest {
  runtimeAgentId: string;
  historyThroughPreviousRun: TranscriptDocument;
  latestUserMessage: string;
  latestUserEntryId: string;
  idempotencyKey: string;
  overrides?: SessionOverrides;
  attachments?: readonly GatewayAttachment[];
  outputCapture?: OutputCaptureRequest;
  signal?: AbortSignal;
  lifecycle?: BridgeLifecycleCallback;
  stream?: BridgeStreamCallback;
  cleanupFailed?: () => Promise<void>;
  /** Caller durably stages entries and owns post-commit cleanup recovery. */
  deferSuccessfulCleanup?: boolean;
}

export interface BridgeResult { runId: string; sessionId: string; entries: TranscriptDocument["entries"]; outputs?: CollectedOutput[] }

// These events are persistence boundaries, not a diagnostic log. In particular,
// message content is only exposed by entries_materialized, whose payload is the
// completed result that the caller must durably save before bridge cleanup begins.
export type BridgeLifecycleEvent =
  | { type: "temporary_session_created"; runtimeAgentId: string; sessionId: string; sessionKey: string; transcriptPath: string }
  | { type: "history_materialized"; previousEntryCount: number }
  | { type: "gateway_send_accepted"; gatewayRunId: string }
  | { type: "entries_materialized"; entries: TranscriptDocument["entries"]; outputs?: CollectedOutput[] };

export type BridgeLifecycleCallback = (event: BridgeLifecycleEvent) => Promise<void>;

// Stream events are deliberately ephemeral. Callers may project them to a live
// preview, but must never use them as the durable result of a generation.
export type BridgeStreamEvent =
  | { type: "connection"; state: "connected" | "disconnected" }
  | { type: "assistant_text"; upstreamSeq: number; text: string; deltaText: string; replace: boolean }
  | { type: "tool"; upstreamSeq: number; callId: string; name: string; phase: "started" | "completed" | "failed"; args?: unknown };
export type BridgeStreamCallback = (event: BridgeStreamEvent) => void;

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
  readAndVerifyCompaction?(created: CreatedSession, history: TranscriptDocument): Promise<TranscriptDocument["entries"][number]>;
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
  const { runId } = await client.send(created.sessionKey, request.latestUserMessage, request.idempotencyKey, request.attachments);
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
