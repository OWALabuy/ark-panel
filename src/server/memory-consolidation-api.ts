import { randomUUID } from "node:crypto";
import type { TranscriptDocument, JsonObject } from "../domain/transcript.js";
import type { BridgeService } from "../gateway/bridge-service.js";
import type { EffectiveToolsInventory } from "../gateway/adapter.js";
import { workspaceSnapshot } from "../gateway/runtime-acceptance.js";
import { MemoryConsolidationStore, type MemoryCandidate, type MemoryLedgerEntry } from "../storage/memory-consolidation.js";
import type { MemoryConversationSource } from "./read-data.js";

const READ_ONLY_TOOLS = new Set(["memory_search", "memory_get"]);
export interface MemorySourceProvider { memorySource(recordId: string): Promise<MemoryConversationSource | undefined> }
export interface MemoryRuntime { runtimeAgentId: string; workspaceRoot: string; indexAgentIds: readonly string[] }
export interface MemoryToolProvider {
  effectiveTools(runtimeAgentId: string, sessionKey: string): Promise<EffectiveToolsInventory>;
  refreshMemoryIndex(agentIds: readonly string[]): Promise<void>;
}

function messageText(entry: JsonObject): string {
  const message = entry.message; if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as JsonObject).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block && typeof block === "object" && !Array.isArray(block) && typeof (block as JsonObject).text === "string" ? [(block as JsonObject).text as string] : []).join("\n");
}
function assistantCandidate(entries: TranscriptDocument["entries"]): string {
  for (const entry of [...entries].reverse()) {
    const message = entry.message;
    if (message && typeof message === "object" && !Array.isArray(message) && (message as JsonObject).role === "assistant") {
      const text = messageText(entry).trim(); if (text) return text;
    }
  }
  throw new Error("MEMORY_CANDIDATE_EMPTY");
}
function fixedRange(document: TranscriptDocument, checkpoint?: string): { document: TranscriptDocument; fromEntryId: string; throughEntryId: string } {
  const entries = document.entries.filter(entry => typeof entry.id === "string"); let start = 0;
  if (checkpoint) { const index = entries.findIndex(entry => entry.id === checkpoint); if (index < 0) throw new Error("MEMORY_CHECKPOINT_INVALID"); start = index + 1; }
  const selected = entries.slice(start); if (!selected.length) throw new Error("MEMORY_NOTHING_TO_CONSOLIDATE");
  const ids = new Set(selected.map(entry => entry.id as string));
  const normalized: TranscriptDocument["entries"] = selected.map((entry, index) => ({ ...entry, ...(index === 0 || typeof entry.parentId === "string" && !ids.has(entry.parentId) ? { parentId: null } : {}) }));
  return { document: { header: document.header, entries: normalized }, fromEntryId: normalized[0]!.id as string, throughEntryId: normalized.at(-1)!.id as string };
}
function rangeIsCurrent(document: TranscriptDocument, previousCheckpointEntryId: string | undefined, fromEntryId: string, throughEntryId: string): boolean {
  const ids = document.entries.flatMap(entry => typeof entry.id === "string" ? [entry.id] : []);
  const start = previousCheckpointEntryId ? ids.indexOf(previousCheckpointEntryId) + 1 : 0;
  if (previousCheckpointEntryId && start === 0 || ids[start] !== fromEntryId) return false;
  return ids.indexOf(throughEntryId, start) >= start;
}
function meaningfulMessage(entry: JsonObject): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message) ||
    !["user", "assistant"].includes(String((message as JsonObject).role))) return false;
  const content = (message as JsonObject).content;
  if (typeof content === "string") return Boolean(content.trim());
  return Array.isArray(content) && content.some(block => typeof block === "string" ? Boolean(block.trim()) :
    Boolean(block && typeof block === "object" && !Array.isArray(block) &&
      (typeof (block as JsonObject).text === "string" ? ((block as JsonObject).text as string).trim() : true)));
}

export class PanelMemoryConsolidationApi {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly indexQueues = new Map<string, Promise<void>>();
  constructor(private readonly store: MemoryConsolidationStore, private readonly sources: MemorySourceProvider,
    private readonly runtimes: ReadonlyMap<string, MemoryRuntime>, private readonly bridge: BridgeService,
    private readonly tools: MemoryToolProvider) {}

  agents(): string[] { return [...this.runtimes.keys()].sort(); }

  async status(recordId: string): Promise<{ available: boolean; eligible: boolean; pending: boolean }> {
    const source = await this.sources.memorySource(recordId); if (!source) throw new Error("SESSION_NOT_FOUND");
    const available = this.runtimes.has(source.record.agentId), eligible = source.record.memoryDisposition === "eligible";
    if (!available || !eligible) return { available, eligible, pending: false };
    const checkpoint = await this.store.checkpoint(recordId), entries = source.document.entries;
    const checkpointIndex = checkpoint ? entries.findIndex(entry => entry.id === checkpoint) : -1;
    const start = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
    const pending = entries.slice(start).some(meaningfulMessage);
    return { available, eligible, pending };
  }

  private runtime(agentId: string): MemoryRuntime {
    const runtime = this.runtimes.get(agentId); if (!runtime) throw new Error("MEMORY_CONSOLIDATION_NOT_CONFIGURED"); return runtime;
  }
  private async assertRestricted(runtimeAgentId: string, sessionKey: string): Promise<void> {
    const inventory = await this.tools.effectiveTools(runtimeAgentId, sessionKey);
    if (inventory.toolIds.some(id => !READ_ONLY_TOOLS.has(id))) throw new Error("MEMORY_RUNTIME_NOT_RESTRICTED");
  }
  private async serialized<T>(recordId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(recordId) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current); this.queues.set(recordId, queued); await previous;
    try { return await operation(); } finally { release(); if (this.queues.get(recordId) === queued) this.queues.delete(recordId); }
  }
  private async refreshIndex(agentId: string, targets: readonly string[]): Promise<void> {
    const previous = this.indexQueues.get(agentId) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current);
    this.indexQueues.set(agentId, queued); await previous;
    try {
      await this.tools.refreshMemoryIndex(targets);
    } catch {
      throw new Error("MEMORY_INDEX_REFRESH_FAILED");
    } finally {
      release(); if (this.indexQueues.get(agentId) === queued) this.indexQueues.delete(agentId);
    }
  }
  async candidate(recordId: string): Promise<MemoryCandidate> {
    return await this.serialized(recordId, async () => {
      const source = await this.sources.memorySource(recordId); if (!source) throw new Error("SESSION_NOT_FOUND");
      if (source.record.memoryDisposition !== "eligible") throw new Error("MEMORY_SOURCE_NOT_ELIGIBLE");
      const runtime = this.runtime(source.record.agentId);
      const context = await this.store.context(recordId, runtime.workspaceRoot), range = fixedRange(source.document, context.checkpointEntryId), before = await workspaceSnapshot(runtime.workspaceRoot);
      const instruction = context.baseContent
        ? `整理上面的 checkpoint 后固定会话范围，并基于下面的上一版已确认会话记忆，生成一份供用户整份审阅的更新版短期记忆 Markdown。输出必须是合并后的完整会话记忆，不是增量片段；保留仍有效的信息，合并重复项，更新已变化的项目状态和决定，删除已失效的待办。只保留未来对话真正有帮助的稳定事实、偏好、决定、项目状态和待办；不写推理过程，不声称已保存，不调用任何工具。仅输出 Markdown 正文。\n\n<previous_confirmed_memory>\n${context.baseContent}\n</previous_confirmed_memory>`
        : "整理上面的固定会话范围，生成一份供用户整份审阅的完整短期记忆 Markdown。只保留未来对话真正有帮助的稳定事实、偏好、决定、项目状态和待办；去重，不写推理过程，不声称已保存，不调用任何工具。仅输出 Markdown 正文。";
      const result = await this.bridge.generate({ runtimeAgentId: runtime.runtimeAgentId, historyThroughPreviousRun: range.document,
        latestUserMessage: instruction,
        latestUserEntryId: randomUUID(), idempotencyKey: randomUUID(), overrides: source.overrides,
        lifecycle: async event => { if (event.type === "temporary_session_created") await this.assertRestricted(runtime.runtimeAgentId, event.sessionKey); } });
      const after = await workspaceSnapshot(runtime.workspaceRoot); if (before.hash !== after.hash) throw new Error("MEMORY_WORKSPACE_CHANGED_DURING_PREVIEW");
      const latest = await this.sources.memorySource(recordId); if (!latest || latest.record.memoryDisposition !== "eligible") throw new Error("MEMORY_SOURCE_NOT_ELIGIBLE");
      if (latest.record.agentId !== source.record.agentId || !rangeIsCurrent(latest.document, context.checkpointEntryId, range.fromEntryId, range.throughEntryId)) throw new Error("MEMORY_SOURCE_CHANGED_DURING_PREVIEW");
      const current = await this.store.context(recordId, runtime.workspaceRoot);
      if (current.checkpointEntryId !== context.checkpointEntryId || current.baseContentHash !== context.baseContentHash || current.targetPath !== context.targetPath) throw new Error("MEMORY_SOURCE_CHANGED_DURING_PREVIEW");
      return await this.store.createCandidate({ agentId: source.record.agentId, recordId, sourceKind: source.record.sourceKind,
        sourceRevision: source.record.revision, ...(context.checkpointEntryId ? { previousCheckpointEntryId: context.checkpointEntryId } : {}),
        ...(context.baseContentHash ? { baseContentHash: context.baseContentHash } : {}),
        fromEntryId: range.fromEntryId, throughEntryId: range.throughEntryId, content: assistantCandidate(result.entries) });
    });
  }
  async getCandidate(batchId: string): Promise<MemoryCandidate> { return await this.store.loadCandidate(batchId); }
  async confirm(batchId: string, contentHash: string): Promise<MemoryLedgerEntry> {
    const candidate = await this.store.loadCandidate(batchId);
    return await this.serialized(candidate.recordId, async () => {
      const source = await this.sources.memorySource(candidate.recordId);
      if (!source) throw new Error("SESSION_NOT_FOUND"); if (source.record.memoryDisposition !== "eligible") throw new Error("MEMORY_SOURCE_NOT_ELIGIBLE");
      if (source.record.agentId !== candidate.agentId) throw new Error("MEMORY_CANDIDATE_CORRUPT");
      if (!rangeIsCurrent(source.document, candidate.previousCheckpointEntryId, candidate.fromEntryId, candidate.throughEntryId)) throw new Error("MEMORY_CANDIDATE_STALE");
      const runtime = this.runtime(candidate.agentId);
      const ledger = await this.store.confirm(batchId, contentHash, runtime.workspaceRoot);
      await this.refreshIndex(candidate.agentId, runtime.indexAgentIds);
      return ledger;
    });
  }
}
