import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveFork } from "../domain/fork.js";
import { type JsonObject, type TranscriptDocument } from "../domain/transcript.js";
import { createPanelSessionFork, createPanelSessionWithSnapshot, deletePanelSession } from "../storage/panel-sessions.js";
import { updateReadonlyMetadata } from "../storage/readonly-metadata.js";
import { updatePanelMetadata } from "../storage/panel-sessions.js";
import { currentTranscriptBranch } from "../domain/branch.js";
import { exportTranscriptMarkdown, markdownFilename } from "../domain/markdown-export.js";
import { ConservativeContextBudget, type ContextBudgetEstimator } from "../domain/context-budget.js";
import { contextUsageAtCurrentTip, type OpenClawContextUsage } from "../domain/context-usage.js";
import { garbageCollectAttachments } from "../storage/attachments.js";
import { SessionReadIndex, sessionIdentityKey, type IndexedSession } from "../storage/index.js";

export interface ReadAgentConfig { agentId: string; sessionsRoot: string; label?: string }
export interface ConversationRecord {
  recordId: string; agentId: string; sourceKind: "active" | "reset" | "panel"; sourceKey: string;
  revision: string; updatedAt: string; messageCount: number; title: string;
  archived: boolean; hidden: boolean; pinned: boolean; project?: string;
  memoryDisposition: "eligible" | "scratch";
}

export interface ConversationStatus {
  modelOverride: string | null; thinkingLevel: string | null; reasoningLevel: string | null;
  contextBudget: { estimatedTokens: number; budgetTokens: number; percentage: number; method: "utf8-bytes-upper-bound-v3" };
  contextUsage: (OpenClawContextUsage & { percentage: number | null }) | null;
  lastActiveAt: string;
}
export interface MemoryConversationSource {
  record: ConversationRecord; document: TranscriptDocument;
  overrides: { modelOverride?: string; thinkingLevel?: string; reasoningLevel?: "on" | "off" | "stream" };
}

function nativeOverrides(document: TranscriptDocument): MemoryConversationSource["overrides"] {
  const overrides: MemoryConversationSource["overrides"] = {};
  for (const entry of document.entries) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") overrides.modelOverride = `${entry.provider}/${entry.modelId}`;
    if (entry.type === "thinking_level_change") {
      const level = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : typeof entry.level === "string" ? entry.level : undefined;
      if (level) overrides.thinkingLevel = level;
    }
    if (entry.type === "reasoning_level_change" && ["on", "off", "stream"].includes(String(entry.reasoningLevel))) overrides.reasoningLevel = entry.reasoningLevel as "on" | "off" | "stream";
  }
  return overrides;
}

function text(entry: JsonObject): string {
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as JsonObject).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block && typeof block === "object" && !Array.isArray(block) && typeof (block as JsonObject).text === "string" ? [(block as JsonObject).text as string] : []).join("\n");
}

function role(entry: JsonObject): string | undefined {
  const message = entry.message;
  return message && typeof message === "object" && !Array.isArray(message) && typeof (message as JsonObject).role === "string" ? (message as JsonObject).role as string : undefined;
}
function documentTitle(document: TranscriptDocument): string {
  const panel = document.header.panel;
  if (panel && typeof panel === "object" && !Array.isArray(panel) && typeof (panel as JsonObject).title === "string") return (panel as JsonObject).title as string;
  const firstUser = document.entries.find(entry => role(entry) === "user"); const value = firstUser ? text(firstUser).trim().replace(/\s+/g, " ") : "";
  return value ? value.slice(0, 48) : "未命名会话";
}

export class SessionReadData {
  private readonly agentsById: ReadonlyMap<string, ReadAgentConfig>;
  constructor(readonly agentsConfig: readonly ReadAgentConfig[], readonly dataRoot: string,
    private readonly readIndex: SessionReadIndex,
    private readonly contextBudget: ContextBudgetEstimator = new ConservativeContextBudget()) {
    const entries = agentsConfig.map(agent => {
      if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) throw new Error("agentId 格式无效");
      return [agent.agentId, { ...agent, sessionsRoot: resolve(agent.sessionsRoot) }] as const;
    });
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("agentId 重复");
    this.agentsById = new Map(entries); this.dataRoot = resolve(dataRoot);
    if (!this.readIndex.hasDataRoot(this.dataRoot) || !entries.every(([agentId]) => this.readIndex.hasAgent(agentId))) {
      throw new Error("READ_INDEX_CONFIGURATION_MISMATCH");
    }
  }

  sessionIndex(): SessionReadIndex { return this.readIndex; }
  async initialize(): Promise<void> { await this.readIndex.initialize(this.agentsById.keys()); }

  private record(entry: IndexedSession): ConversationRecord {
    const metadata = entry.metadata;
    return { recordId: entry.recordId, agentId: entry.agentId, sourceKind: entry.sourceKind, sourceKey: entry.sourceKey,
      revision: entry.revision, updatedAt: entry.updatedAt,
      messageCount: entry.document.entries.filter(item => item.type === "message").length,
      title: metadata.title ?? documentTitle(entry.document), archived: metadata.archived ?? false,
      hidden: metadata.hidden ?? false, pinned: metadata.pinned ?? false,
      memoryDisposition: metadata.memoryDisposition ?? "scratch",
      ...(metadata.project ? { project: metadata.project } : {}) };
  }

  private async indexedSessions(agentId?: string, archived: boolean | null = false,
    includeHidden = false): Promise<Array<{ entry: IndexedSession; record: ConversationRecord }>> {
    const snapshot = agentId ? await this.readIndex.snapshot(agentId) : await this.readIndex.snapshotAgents(this.agentsById.keys());
    const pairs = snapshot.map(entry => ({ entry, record: this.record(entry) }));
    return pairs.filter(({ record }) => (includeHidden || !record.hidden) && (archived === null || record.archived === archived))
      .sort((a, b) => Number(b.record.pinned) - Number(a.record.pinned) || b.record.updatedAt.localeCompare(a.record.updatedAt) ||
        this.readIndex.compare(a.entry, b.entry));
  }

  async agents(): Promise<unknown[]> {
    return Promise.all([...this.agentsById.values()].map(async agent => {
      const sessions = await this.sessions(agent.agentId);
      return { id: agent.agentId, label: agent.label ?? agent.agentId, sessionCount: sessions.length };
    }));
  }

  async sessions(agentId?: string, archived: boolean | null = false, includeHidden = false): Promise<ConversationRecord[]> {
    if (agentId && !this.agentsById.has(agentId)) return [];
    return (await this.indexedSessions(agentId, archived, includeHidden)).map(({ record }) => record);
  }

  async projects(agentId: string): Promise<string[]> {
    const canonical = new Map<string, string>();
    const records = await this.sessions(agentId, null);
    // When archived and active conversations differ only in casing, prefer the active spelling
    // instead of letting filesystem timestamp resolution decide which label wins.
    records.sort((left, right) => Number(left.archived) - Number(right.archived) || right.updatedAt.localeCompare(left.updatedAt));
    for (const record of records) {
      const project = record.project?.trim(); if (!project) continue;
      const key = project.toLocaleLowerCase(); if (!canonical.has(key)) canonical.set(key, project);
    }
    return [...canonical.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }

  private async load(recordId: string): Promise<{ record: ConversationRecord; document: TranscriptDocument; entry: IndexedSession } | undefined> {
    const entry = await this.readIndex.lookup(recordId, this.agentsById.keys()); if (!entry) return undefined;
    return { record: this.record(entry), document: entry.document, entry };
  }

  async conversation(recordId: string): Promise<unknown | null> {
    const loaded = await this.load(recordId);
    if (!loaded) return null;
    const header = loaded.document.header;
    const safeHeader = { type: header.type, version: header.version, id: header.id, timestamp: header.timestamp,
      ...(header.panel && typeof header.panel === "object" && !Array.isArray(header.panel) ? { panel: header.panel } : {}) };
    const safeEntries = currentTranscriptBranch(loaded.document).entries.map(entry => ({
      type: entry.type, ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(entry.parentId === null || typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      ...(entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? { message: entry.message } : {}),
      ...(entry.type === "compaction" && typeof entry.summary === "string" && typeof entry.firstKeptEntryId === "string" &&
        typeof entry.tokensBefore === "number" ? { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore } : {})
    }));
    const estimate = this.contextBudget.estimate(currentTranscriptBranch(loaded.document), "");
    const nativeUsage = loaded.record.sourceKind === "panel" ? contextUsageAtCurrentTip(loaded.document) : null;
    let modelOverride: string | null = null, thinkingLevel: string | null = null, reasoningLevel: string | null = null;
    if (loaded.entry.sourceKind === "panel") {
      const metadata = loaded.entry.metadata;
      modelOverride = metadata.modelOverride ?? null; thinkingLevel = metadata.thinkingLevel ?? null; reasoningLevel = metadata.reasoningLevel ?? null;
    }
    const status: ConversationStatus = { modelOverride, thinkingLevel, reasoningLevel,
      contextBudget: { estimatedTokens: estimate.estimatedTokens, budgetTokens: estimate.budgetTokens,
        percentage: Math.round(estimate.estimatedTokens / estimate.budgetTokens * 100), method: estimate.method },
      contextUsage: nativeUsage ? { ...nativeUsage,
        percentage: nativeUsage.totalTokens !== null && nativeUsage.contextTokens !== null ?
          Math.round(nativeUsage.totalTokens / nativeUsage.contextTokens * 100) : null } : null,
      lastActiveAt: loaded.record.updatedAt };
    return { ...loaded.record, status, document: { header: safeHeader, entries: safeEntries } };
  }

  async memorySource(recordId: string): Promise<MemoryConversationSource | undefined> {
    const loaded = await this.load(recordId); if (!loaded) return undefined;
    const document = currentTranscriptBranch(loaded.document), overrides: MemoryConversationSource["overrides"] = loaded.record.sourceKind === "panel" ? {} : nativeOverrides(document);
    if (loaded.entry.sourceKind === "panel") {
      const metadata = loaded.entry.metadata;
      if (metadata.modelOverride) overrides.modelOverride = metadata.modelOverride;
      if (metadata.thinkingLevel) overrides.thinkingLevel = metadata.thinkingLevel;
      if (metadata.reasoningLevel) overrides.reasoningLevel = metadata.reasoningLevel;
    }
    return { record: loaded.record, document, overrides };
  }

  async exportMarkdown(recordId: string): Promise<{ filename: string; markdown: string } | null> {
    const loaded = await this.load(recordId); if (!loaded) return null;
    return { filename: markdownFilename(loaded.record.title), markdown: exportTranscriptMarkdown(loaded.document, loaded.record.title, loaded.record.agentId) };
  }

  async createPanel(agentId: string, title?: string): Promise<unknown> {
    if (!this.agentsById.has(agentId)) throw new Error("AGENT_NOT_ALLOWED");
    const now = new Date().toISOString(), recordId = randomUUID();
    const safeTitle = title?.slice(0, 120);
    const published = await createPanelSessionWithSnapshot(this.dataRoot, agentId, { header: { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: ".", panel: { recordId, createdAt: now, ...(safeTitle ? { title: safeTitle } : {}) } }, entries: [] }, { recordId, createdAt: now, ...(safeTitle ? { title: safeTitle } : {}) });
    const entry: IndexedSession = { agentId, sourceKind: "panel", sourceKey: published.metadata.recordId,
      recordId: published.metadata.recordId, identityKey: sessionIdentityKey({ agentId, sourceKind: "panel", sourceKey: published.metadata.recordId }),
      revision: published.revision, updatedAt: published.updatedAt, fingerprint: published.fingerprint,
      document: published.document, metadata: published.metadata };
    this.refreshPanelAfterCommit(agentId, published.metadata.recordId); return this.record(entry);
  }

  async search(query: string, agentId?: string): Promise<unknown[]> {
    const needle = query.trim().toLocaleLowerCase(); if (!needle) return [];
    const sessions = await this.indexedSessions(agentId, null); const matches: unknown[] = [];
    for (const { entry: indexed, record } of sessions) {
      const hits = indexed.document.entries.flatMap(entry => {
        const value = text(entry); const at = value.toLocaleLowerCase().indexOf(needle);
        return at < 0 ? [] : [{ entryId: typeof entry.id === "string" ? entry.id : null, role: role(entry) ?? null, snippet: value.slice(Math.max(0, at - 40), at + needle.length + 80) }];
      });
      if (hits.length) matches.push({ ...record, hits });
    }
    return matches;
  }

  async updateSession(recordId: string, patch: { title?: string; archived?: boolean; pinned?: boolean; project?: string | null; memoryDisposition?: "eligible" | "scratch" }): Promise<ConversationRecord> {
    if (patch.title === undefined && patch.archived === undefined && patch.pinned === undefined && patch.project === undefined && patch.memoryDisposition === undefined) throw new Error("SESSION_UPDATE_EMPTY");
    const title = patch.title?.trim(); if (patch.title !== undefined && (!title || title.length > 120)) throw new Error("SESSION_TITLE_INVALID");
    const project = patch.project?.trim(); if (patch.project !== undefined && patch.project !== null && (!project || project.length > 60 || /[\u0000-\u001f\u007f]/.test(project))) throw new Error("SESSION_PROJECT_INVALID");
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    let updated: IndexedSession;
    if (loaded.entry.sourceKind === "panel") {
      const metadata = await updatePanelMetadata(this.dataRoot, loaded.record.agentId, recordId, current => { const next = { ...current, ...(title ? { title } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(patch.memoryDisposition ? { memoryDisposition: patch.memoryDisposition } : {}), ...(project ? { project } : {}) }; if (patch.project === null) delete next.project; return next; });
      updated = { ...loaded.entry, metadata }; this.refreshPanelAfterCommit(loaded.entry.agentId, loaded.entry.recordId);
    } else {
      const metadata = await updateReadonlyMetadata(this.dataRoot, loaded.entry.identity, current => { const next = { ...current, ...(title ? { title } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(patch.memoryDisposition ? { memoryDisposition: patch.memoryDisposition } : {}), ...(project ? { project } : {}) }; if (patch.project === null) delete next.project; return next; });
      updated = { ...loaded.entry, metadata }; this.refreshEntryAfterCommit(updated);
    }
    return this.record(updated);
  }

  async deleteSession(recordId: string, confirmed: boolean): Promise<{ action: "deleted" | "hidden" }> {
    if (!confirmed) throw new Error("SESSION_DELETE_CONFIRMATION_REQUIRED");
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    if (loaded.record.sourceKind === "panel") {
      if (!loaded.record.archived) throw new Error("SESSION_NOT_ARCHIVED");
      await deletePanelSession(this.dataRoot, loaded.record.agentId, recordId);
      this.readIndex.forget(loaded.entry);
      await garbageCollectAttachments(this.dataRoot);
      return { action: "deleted" };
    }
    if (loaded.entry.sourceKind === "panel") throw new Error("SESSION_SOURCE_INVALID");
    const metadata = await updateReadonlyMetadata(this.dataRoot, loaded.entry.identity, current => ({ ...current, hidden: true }));
    this.refreshEntryAfterCommit({ ...loaded.entry, metadata }); return { action: "hidden" };
  }

  async fork(recordId: string, messageId: string): Promise<unknown> {
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    const createdAt = new Date().toISOString(); const newId = randomUUID();
    const inherited = { title: loaded.record.title, ...(loaded.record.project ? { project: loaded.record.project } : {}) };
    const document = deriveFork(loaded.document, messageId, { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt, ...inherited });
    const metadata = await createPanelSessionFork(this.dataRoot, loaded.record.agentId, document,
      { parentRecordId: recordId, forkedFromMessageId: messageId, recordId: newId, createdAt, ...inherited },
      loaded.record.sourceKind === "panel" ? { agentId: loaded.record.agentId, recordId } : undefined);
    this.refreshPanelAfterCommit(metadata.agentId, metadata.recordId);
    return { recordId: metadata.recordId, agentId: metadata.agentId, sourceKind: "panel" };
  }

  async editAndFork(recordId: string, messageId: string, _replacement: string): Promise<unknown> {
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    const index = loaded.document.entries.findIndex(entry => entry.id === messageId); const target = loaded.document.entries[index];
    if (!target || role(target) !== "user") throw new Error("EDIT_TARGET_NOT_USER");
    const parent = typeof target.parentId === "string" ? target.parentId : null; const createdAt = new Date().toISOString(), newId = randomUUID();
    let base: TranscriptDocument;
    const inherited = { title: loaded.record.title, ...(loaded.record.project ? { project: loaded.record.project } : {}) };
    if (parent) base = deriveFork(loaded.document, parent, { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt, ...inherited });
    else base = { header: { ...loaded.document.header, id: randomUUID(), timestamp: createdAt,
      panel: { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt, ...inherited } }, entries: [] };
    const metadata = await createPanelSessionFork(this.dataRoot, loaded.record.agentId, base,
      { parentRecordId: recordId, forkedFromMessageId: messageId, recordId: newId, createdAt, ...inherited },
      loaded.record.sourceKind === "panel" ? { agentId: loaded.record.agentId, recordId } : undefined);
    this.refreshPanelAfterCommit(metadata.agentId, metadata.recordId);
    return { recordId: metadata.recordId, agentId: metadata.agentId, sourceKind: "panel" };
  }

  private refreshPanelAfterCommit(agentId: string, recordId: string): void {
    this.readIndex.invalidatePanel(agentId, recordId);
    void this.readIndex.refreshPanel(agentId, recordId).catch(() => undefined);
  }

  private refreshEntryAfterCommit(entry: IndexedSession): void {
    this.readIndex.invalidate(entry);
    void this.readIndex.refresh(entry).catch(() => undefined);
  }
}
