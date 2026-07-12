import type { TranscriptDocument } from "../domain/transcript.js";

export const SUPPORTED_OPENCLAW_VERSION = "2026.6.11";

export interface CreatedSession { sessionId: string; sessionKey: string; transcriptPath: string }
export interface GatewayClient {
  version(): Promise<string>;
  createSession(runtimeAgentId: string): Promise<CreatedSession>;
  send(sessionKey: string, message: string, idempotencyKey: string): Promise<{ runId: string }>;
  waitForCompletion(sessionId: string, runId: string): Promise<void>;
  abort(sessionKey: string, runId?: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
}

export interface BridgeRequest {
  runtimeAgentId: string;
  historyThroughPreviousRun: TranscriptDocument;
  latestUserMessage: string;
  latestUserEntryId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface BridgeResult { runId: string; sessionId: string; entries: TranscriptDocument["entries"] }

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
  const previousCount = await materializer.replaceCreatedTranscript(created, request.historyThroughPreviousRun);
  const { runId } = await client.send(created.sessionKey, request.latestUserMessage, request.idempotencyKey);
  const abort = () => { void client.abort(created.sessionKey, runId); };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
    await client.waitForCompletion(created.sessionId, runId);
    if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
  } finally { request.signal?.removeEventListener("abort", abort); }
  const added = await materializer.readNewEntries(created, previousCount);
  return { runId, sessionId: created.sessionId, entries: materializer.verifyAndStripSubmittedUser(added, request.latestUserMessage, request.latestUserEntryId) };
}
