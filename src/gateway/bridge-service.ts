import type { TranscriptDocument } from "../domain/transcript.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { assertSupportedVersion, type BridgeMaterializer, type BridgeOrphanCleanupRequest, type BridgeRequest, type BridgeResult, type CreatedSession, type GatewayClient, type SessionOverrides } from "./adapter.js";
import type { GatewayStreamEvent, GatewayStreamListener } from "./stream-client.js";

interface StreamObserver { observe(sessionKey: string, listener: GatewayStreamListener): Promise<() => void> }

export class BridgeService {
  constructor(private readonly client: GatewayClient, private readonly materializer: BridgeMaterializer,
    private readonly allowedRuntimeRoots: ReadonlyMap<string, string>, private readonly streamObserver?: StreamObserver) {}

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

  async cleanupOrphanedSession(request: BridgeOrphanCleanupRequest): Promise<string[]> {
    await this.client.abort(request.sessionKey, request.gatewayRunId, request.sessionId);
    return await unregisterAndClean(this.client, { runtimeAgentId: request.runtimeAgentId, sessionId: request.sessionId,
      sessionKey: request.sessionKey, runtimeSessionsRoot: this.allowedRuntimeRoots.get(request.runtimeAgentId) ?? "",
      allowedRuntimeRoots: this.allowedRuntimeRoots });
  }

  async generate(request: BridgeRequest): Promise<BridgeResult> {
    assertSupportedVersion(await this.client.version());
    let created: CreatedSession | undefined; let runId: string | undefined; let primaryError: unknown;
    let abortPromise: Promise<void> | undefined; let entriesStaged = false; let cleanupSafe = true; let sendAttempted = false;
    let unsubscribeStream: (() => void) | undefined;
    const abortCreated = (): Promise<void> => abortPromise ??= created ? this.client.abort(created.sessionKey, runId, created.sessionId) : Promise.resolve();
    try {
      created = await this.client.createSession(request.runtimeAgentId);
      await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: request.runtimeAgentId,
        sessionId: created.sessionId, sessionKey: created.sessionKey, transcriptPath: created.transcriptPath });
      const before = await this.materializer.replaceCreatedTranscript(created, request.historyThroughPreviousRun);
      await request.lifecycle?.({ type: "history_materialized", previousEntryCount: before });
      if (request.overrides && Object.keys(request.overrides).length > 0) {
        if (!this.client.applySessionOverrides) throw new Error("GATEWAY_SESSION_OVERRIDES_UNSUPPORTED");
        await this.client.applySessionOverrides(created.sessionKey, request.overrides);
      }
      if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
      if (this.streamObserver && request.stream) {
        try {
          unsubscribeStream = await this.streamObserver.observe(created.sessionKey, (event: GatewayStreamEvent) => {
            if (event.type === "connection") request.stream?.(event);
            else if (event.runId === request.idempotencyKey) {
              const { runId: _runId, sessionKey: _sessionKey, ...visible } = event;
              request.stream?.(visible);
            }
          });
        } catch (error) {
          process.stderr.write(`[ark-panel] stream attach degraded: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      sendAttempted = true; ({ runId } = await this.client.send(created.sessionKey, request.latestUserMessage, request.idempotencyKey));
      const abort = () => { void abortCreated().catch(() => undefined); };
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (request.signal?.aborted) { await abortCreated().catch(() => undefined); throw new Error("BRIDGE_ABORTED"); }
        await request.lifecycle?.({ type: "gateway_send_accepted", gatewayRunId: runId });
        if (request.signal?.aborted) { await abortCreated().catch(() => undefined); throw new Error("BRIDGE_ABORTED"); }
        await this.client.waitForCompletion(created.sessionId, runId, request.signal);
      }
      finally { request.signal?.removeEventListener("abort", abort); }
      if (request.signal?.aborted) throw new Error("BRIDGE_ABORTED");
      const added = await this.materializer.readNewEntries(created, before);
      const entries = this.materializer.verifyAndStripSubmittedUser(added, request.latestUserMessage, request.latestUserEntryId);
      await request.lifecycle?.({ type: "entries_materialized", entries });
      entriesStaged = true;
      return { runId, sessionId: created.sessionId, entries };
    } catch (error) {
      primaryError = error;
      if (created) {
        try { await abortCreated(); }
        catch (abortError) {
          cleanupSafe = !sendAttempted;
          if (!cleanupSafe) await request.cleanupFailed?.().catch(() => undefined);
          if (error instanceof Error && error.message === "BRIDGE_ABORTED") {
            if (abortError instanceof Error && abortError.message === "GATEWAY_ABORT_RELEASE_TIMEOUT") throw abortError;
            throw new Error("RUN_ABORT_UNCONFIRMED");
          }
        }
      }
      throw error;
    } finally {
      unsubscribeStream?.();
      if (created && cleanupSafe) {
        try {
          await unregisterAndClean(this.client, { runtimeAgentId: request.runtimeAgentId, sessionId: created.sessionId,
            sessionKey: created.sessionKey, runtimeSessionsRoot: this.allowedRuntimeRoots.get(request.runtimeAgentId) ?? "",
            allowedRuntimeRoots: this.allowedRuntimeRoots });
        } catch (cleanupError) {
          await request.cleanupFailed?.().catch(() => undefined);
          if (!primaryError && !entriesStaged) throw cleanupError;
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
