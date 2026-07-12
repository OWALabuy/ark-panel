import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";
import type { BridgeRequest, BridgeResult } from "../gateway/adapter.js";
import type { GenerationApi } from "./app.js";
import { ConservativeContextBudget, type ContextBudgetEstimator } from "../domain/context-budget.js";

interface BridgeRunner { generate(request: BridgeRequest): Promise<BridgeResult> }
export interface GenerationConfig { dataRoot: string; runtimeByAgent: ReadonlyMap<string, string>; completedCacheLimit?: number; contextBudget?: ContextBudgetEstimator }

function latestEntryId(document: TranscriptDocument): string | null {
  for (let index = document.entries.length - 1; index >= 0; index--) if (typeof document.entries[index]!.id === "string") return document.entries[index]!.id as string;
  return null;
}

export class PanelGenerationApi implements GenerationApi {
  private static readonly MAX_COMPLETED = 512;
  private readonly busy = new Set<string>();
  private readonly completed = new Map<string, { recordId: string; message: string; value: { runId: string; entries: unknown[]; revision?: string } }>();
  private readonly inflight = new Map<string, { recordId: string; message: string; promise: Promise<{ runId: string; entries: unknown[]; revision?: string }> }>();
  constructor(private readonly bridge: BridgeRunner, private readonly config: GenerationConfig) {
    if (config.completedCacheLimit !== undefined && (!Number.isInteger(config.completedCacheLimit) || config.completedCacheLimit < 1)) throw new Error("completedCacheLimit 必须是正整数");
  }
  completedCacheSize(): number { return this.completed.size; }

  async generate(recordId: string, message: string, signal: AbortSignal, runId: string = randomUUID(), expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string }> {
    const done = this.completed.get(runId); if (done) {
      if (done.recordId !== recordId || done.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return done.value;
    }
    const running = this.inflight.get(runId); if (running) {
      if (running.recordId !== recordId || running.message !== message) throw new Error("IDEMPOTENCY_KEY_REUSED"); return await running.promise;
    }
    const promise = this.generateOnce(recordId, message, signal, runId, expectedRevision);
    this.inflight.set(runId, { recordId, message, promise });
    try {
      const value = await promise; this.completed.set(runId, { recordId, message, value });
      while (this.completed.size > (this.config.completedCacheLimit ?? PanelGenerationApi.MAX_COMPLETED)) this.completed.delete(this.completed.keys().next().value as string);
      return value;
    }
    finally { this.inflight.delete(runId); }
  }

  private async generateOnce(recordId: string, message: string, signal: AbortSignal, runId: string, expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string }> {
    if (message.trimStart().startsWith("/")) throw new Error("SLASH_COMMANDS_UNSUPPORTED");
    if (this.busy.has(recordId)) throw new Error("SESSION_BUSY"); this.busy.add(recordId);
    try {
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
        latestUserEntryId: userId, idempotencyKey: runId, signal });
      const committed: TranscriptDocument = { header: document.header, entries: [...document.entries, userEntry, ...result.entries] };
      await commitPanelTranscript(this.config.dataRoot, metadata, committed);
      const afterStat = await lstat(transcriptPath); return { runId, entries: result.entries, revision: `${afterStat.size}:${afterStat.mtimeMs}` };
    } finally { this.busy.delete(recordId); }
  }
}
