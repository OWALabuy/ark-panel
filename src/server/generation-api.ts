import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";
import type { BridgeRequest, BridgeResult } from "../gateway/adapter.js";
import type { GenerationApi } from "./app.js";
import { ConservativeContextBudget, type ContextBudgetEstimator } from "../domain/context-budget.js";
import { SessionOperationCoordinator } from "./session-operation.js";

interface BridgeRunner { generate(request: BridgeRequest): Promise<BridgeResult> }
export interface GenerationConfig { dataRoot: string; runtimeByAgent: ReadonlyMap<string, string>; completedCacheLimit?: number; contextBudget?: ContextBudgetEstimator; operations?: SessionOperationCoordinator }

function latestEntryId(document: TranscriptDocument): string | null {
  for (let index = document.entries.length - 1; index >= 0; index--) if (typeof document.entries[index]!.id === "string") return document.entries[index]!.id as string;
  return null;
}

export class PanelGenerationApi implements GenerationApi {
  private static readonly MAX_COMPLETED = 512;
  private readonly operations: SessionOperationCoordinator;
  private readonly completed = new Map<string, { recordId: string; message: string; value: { runId: string; entries: unknown[]; revision?: string } }>();
  private readonly inflight = new Map<string, { recordId: string; message: string; promise: Promise<{ runId: string; entries: unknown[]; revision?: string }> }>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly bridge: BridgeRunner, private readonly config: GenerationConfig) {
    if (config.completedCacheLimit !== undefined && (!Number.isInteger(config.completedCacheLimit) || config.completedCacheLimit < 1)) throw new Error("completedCacheLimit 必须是正整数");
    this.operations = config.operations ?? new SessionOperationCoordinator();
  }
  completedCacheSize(): number { return this.completed.size; }

  // 显式停止：按 runId 中断正在进行的推理。与 HTTP 连接解耦，连接断开不会触发这里，
  // 只有用户主动点“停止”才走这条路径。返回是否命中一个进行中的 run。
  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async generate(recordId: string, message: string, signal: AbortSignal, runId: string = randomUUID(), expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string }> {
    const done = this.completed.get(runId); if (done) {
      if (done.recordId !== recordId || done.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return done.value;
    }
    const running = this.inflight.get(runId); if (running) {
      if (running.recordId !== recordId || running.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return await running.promise;
    }
    // 每个 run 拥有自己的 AbortController，按 runId 登记，供显式 abort() 中断。
    // 外部传入的 signal（HTTP 连接、测试）转发进来，但连接断开本身已不再触发 abort。
    const controller = new AbortController(); const forward = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", forward, { once: true });
    this.controllers.set(runId, controller);
    const promise = this.generateOnce(recordId, message, controller.signal, runId, expectedRevision);
    this.inflight.set(runId, { recordId, message, promise });
    try {
      const value = await promise; this.completed.set(runId, { recordId, message, value });
      while (this.completed.size > (this.config.completedCacheLimit ?? PanelGenerationApi.MAX_COMPLETED)) this.completed.delete(this.completed.keys().next().value as string);
      return value;
    }
    finally { this.inflight.delete(runId); this.controllers.delete(runId); signal?.removeEventListener("abort", forward); }
  }

  private async generateOnce(recordId: string, message: string, signal: AbortSignal, runId: string, expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string }> {
    if (message.trimStart().startsWith("/")) throw new Error("SLASH_COMMANDS_UNSUPPORTED");
    return await this.operations.runGeneration(recordId, async () => {
      let agentId: string | undefined;
      for (const candidate of this.config.runtimeByAgent.keys()) {
        if ((await listPanelSessions(this.config.dataRoot, candidate)).some((metadata) => metadata.recordId === recordId)) { agentId = candidate; break; }
      }
      if (!agentId) throw new Error("PANEL_SESSION_NOT_FOUND");
      const runtimeAgentId = this.config.runtimeByAgent.get(agentId); if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
      const { metadata, document } = await loadPanelSession(this.config.dataRoot, agentId, recordId);
      const transcriptPath = join(this.config.dataRoot, "sessions", agentId, recordId, "transcript.jsonl");
      const beforeStat = await lstat(transcriptPath); const beforeRevision = `${beforeStat.size}:${beforeStat.mtimeMs}`;
      if (expectedRevision && expectedRevision !== beforeRevision) throw new Error("REVISION_CONFLICT");
      (this.config.contextBudget ?? new ConservativeContextBudget()).assertWithinBudget(document, message);
      const userId = randomUUID(); const now = new Date().toISOString();
      const userEntry: JsonObject = { type: "message", id: userId, parentId: latestEntryId(document), timestamp: now,
        message: { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() } };
      const result = await this.bridge.generate({ runtimeAgentId, historyThroughPreviousRun: document, latestUserMessage: message,
        latestUserEntryId: userId, idempotencyKey: runId,
        overrides: { ...(metadata.modelOverride ? { modelOverride: metadata.modelOverride } : {}),
          ...(metadata.thinkingLevel ? { thinkingLevel: metadata.thinkingLevel } : {}),
          ...(metadata.reasoningLevel ? { reasoningLevel: metadata.reasoningLevel } : {}) }, signal });
      const committed: TranscriptDocument = { header: document.header, entries: [...document.entries, userEntry, ...result.entries] };
      await commitPanelTranscript(this.config.dataRoot, metadata, committed);
      const afterStat = await lstat(transcriptPath); return { runId, entries: result.entries, revision: `${afterStat.size}:${afterStat.mtimeMs}` };
    });
  }
}
