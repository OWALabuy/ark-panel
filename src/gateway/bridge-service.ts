import type { TranscriptDocument } from "../domain/transcript.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { assertSupportedVersion, type BridgeMaterializer, type BridgeRequest, type BridgeResult, type CreatedSession, type GatewayClient, type SessionOverrides } from "./adapter.js";

export class BridgeService {
  constructor(private readonly client: GatewayClient, private readonly materializer: BridgeMaterializer,
    private readonly allowedRuntimeRoots: ReadonlyMap<string, string>) {}

  async validateOverrides(runtimeAgentId: string, overrides: SessionOverrides): Promise<void> {
    assertSupportedVersion(await this.client.version());
    const created = await this.client.createSession(runtimeAgentId); let primaryError: unknown;
    try {
      if (!this.client.applySessionOverrides) throw new Error("GATEWAY_SESSION_OVERRIDES_UNSUPPORTED");
      await this.client.applySessionOverrides(created.sessionKey, overrides);
    } catch (error) { primaryError = error; throw error; }
    finally {
      try {
        await unregisterAndClean(this.client, { runtimeAgentId, sessionId: created.sessionId, sessionKey: created.sessionKey,
          runtimeSessionsRoot: this.allowedRuntimeRoots.get(runtimeAgentId) ?? "", allowedRuntimeRoots: this.allowedRuntimeRoots });
      } catch (cleanupError) { if (!primaryError) throw cleanupError; }
    }
  }

  async generate(request: BridgeRequest): Promise<BridgeResult> {
    assertSupportedVersion(await this.client.version());
    let created: CreatedSession | undefined; let runId: string | undefined; let primaryError: unknown;
    try {
      created = await this.client.createSession(request.runtimeAgentId);
      const before = await this.materializer.replaceCreatedTranscript(created, request.historyThroughPreviousRun);
      if (request.overrides && Object.keys(request.overrides).length > 0) {
        if (!this.client.applySessionOverrides) throw new Error("GATEWAY_SESSION_OVERRIDES_UNSUPPORTED");
        await this.client.applySessionOverrides(created.sessionKey, request.overrides);
      }
      if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
      ({ runId } = await this.client.send(created.sessionKey, request.latestUserMessage, request.idempotencyKey));
      const abort = () => { void this.client.abort(created!.sessionKey, runId).catch(() => undefined); };
      request.signal?.addEventListener("abort", abort, { once: true });
      try { await this.client.waitForCompletion(created.sessionId, runId); }
      finally { request.signal?.removeEventListener("abort", abort); }
      if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
      const added = await this.materializer.readNewEntries(created, before);
      const entries = this.materializer.verifyAndStripSubmittedUser(added, request.latestUserMessage, request.latestUserEntryId);
      return { runId, sessionId: created.sessionId, entries };
    } catch (error) {
      primaryError = error;
      if (created) await this.client.abort(created.sessionKey, runId).catch(() => undefined);
      throw error;
    } finally {
      if (created) {
        try {
          await unregisterAndClean(this.client, { runtimeAgentId: request.runtimeAgentId, sessionId: created.sessionId,
            sessionKey: created.sessionKey, runtimeSessionsRoot: this.allowedRuntimeRoots.get(request.runtimeAgentId) ?? "",
            allowedRuntimeRoots: this.allowedRuntimeRoots });
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
    }
  }
}

export function historyEndingBeforeLatestUser(document: TranscriptDocument): TranscriptDocument {
  const last = document.entries.at(-1); if (!last) throw new Error("会话没有最新用户消息");
  const message = last.message;
  if (!message || typeof message !== "object" || Array.isArray(message) || (message as { role?: unknown }).role !== "user") {
    throw new Error("会话末尾不是待提交的 user entry");
  }
  return { header: document.header, entries: document.entries.slice(0, -1) };
}
