import { randomUUID } from "node:crypto";
import type { TranscriptDocument, JsonObject } from "../domain/transcript.js";
import type { BridgeService } from "../gateway/bridge-service.js";
import type { EffectiveToolsInventory } from "../gateway/adapter.js";
import { workspaceSnapshot } from "../gateway/runtime-acceptance.js";
import { MemoryConsolidationStore, type MemoryCandidate, type MemoryLedgerEntry } from "../storage/memory-consolidation.js";
import type { MemoryConversationSource } from "./read-data.js";

const READ_ONLY_TOOLS = new Set(["memory_search", "memory_get"]);
export interface MemorySourceProvider { memorySource(recordId: string): Promise<MemoryConversationSource | undefined> }
export interface MemoryRuntime { runtimeAgentId: string; workspaceRoot: string }
export interface MemoryToolProvider { effectiveTools(runtimeAgentId: string, sessionKey: string): Promise<EffectiveToolsInventory> }

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

export class PanelMemoryConsolidationApi {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly store: MemoryConsolidationStore, private readonly sources: MemorySourceProvider,
    private readonly runtimes: ReadonlyMap<string, MemoryRuntime>, private readonly bridge: BridgeService,
    private readonly tools: MemoryToolProvider) {}

  agents(): string[] { return [...this.runtimes.keys()].sort(); }

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
  async candidate(recordId: string): Promise<MemoryCandidate> {
    return await this.serialized(recordId, async () => {
      const source = await this.sources.memorySource(recordId); if (!source) throw new Error("SESSION_NOT_FOUND");
      if (source.record.memoryDisposition !== "eligible") throw new Error("MEMORY_SOURCE_NOT_ELIGIBLE");
      const runtime = this.runtime(source.record.agentId);
      const previousCheckpointEntryId = await this.store.checkpoint(recordId), range = fixedRange(source.document, previousCheckpointEntryId), before = await workspaceSnapshot(runtime.workspaceRoot);
      const result = await this.bridge.generate({ runtimeAgentId: runtime.runtimeAgentId, historyThroughPreviousRun: range.document,
        latestUserMessage: "整理上面的固定会话范围，生成一份供用户整份审阅的短期记忆 Markdown。只保留未来对话真正有帮助的稳定事实、偏好、决定、项目状态和待办；去重，不写推理过程，不声称已保存，不调用任何工具。仅输出 Markdown 正文。",
        latestUserEntryId: randomUUID(), idempotencyKey: randomUUID(), overrides: source.overrides,
        lifecycle: async event => { if (event.type === "temporary_session_created") await this.assertRestricted(runtime.runtimeAgentId, event.sessionKey); } });
      const after = await workspaceSnapshot(runtime.workspaceRoot); if (before.hash !== after.hash) throw new Error("MEMORY_WORKSPACE_CHANGED_DURING_PREVIEW");
      const latest = await this.sources.memorySource(recordId); if (!latest || latest.record.memoryDisposition !== "eligible") throw new Error("MEMORY_SOURCE_NOT_ELIGIBLE");
      if (latest.record.agentId !== source.record.agentId || !rangeIsCurrent(latest.document, previousCheckpointEntryId, range.fromEntryId, range.throughEntryId)) throw new Error("MEMORY_SOURCE_CHANGED_DURING_PREVIEW");
      return await this.store.createCandidate({ agentId: source.record.agentId, recordId, sourceKind: source.record.sourceKind,
        sourceRevision: source.record.revision, fromEntryId: range.fromEntryId, throughEntryId: range.throughEntryId, content: assistantCandidate(result.entries) });
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
      return await this.store.confirm(batchId, contentHash, this.runtime(candidate.agentId).workspaceRoot);
    });
  }
}
