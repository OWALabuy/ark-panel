import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveFork } from "../domain/fork.js";
import { externalRecordId } from "../domain/record-id.js";
import { parseTranscript, TranscriptError, type JsonObject, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin } from "../storage/atomic.js";
import { createPanelSession, deletePanelSession, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";
import { loadReadonlyMetadata, updateReadonlyMetadata, type ReadonlySourceIdentity } from "../storage/readonly-metadata.js";
import { updatePanelMetadata } from "../storage/panel-sessions.js";
import { exportTranscriptMarkdown, markdownFilename } from "../domain/markdown-export.js";
import { ConservativeContextBudget, type ContextBudgetEstimator } from "../domain/context-budget.js";

export interface ReadAgentConfig { agentId: string; sessionsRoot: string; label?: string }
export interface ConversationRecord {
  recordId: string; agentId: string; sourceKind: "active" | "reset" | "panel"; sourceKey: string;
  revision: string; updatedAt: string; messageCount: number; title: string;
  archived: boolean; hidden: boolean; pinned: boolean; project?: string;
}

export interface ConversationStatus {
  modelOverride: string | null; thinkingLevel: string | null; reasoningLevel: string | null;
  contextBudget: { estimatedTokens: number; budgetTokens: number; percentage: number; method: "utf8-bytes-upper-bound-v2" };
  lastActiveAt: string;
}

const ACTIVE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const RESET = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl\.reset\.(.+)$/i;

function parseActive(input: string): TranscriptDocument {
  try { return parseTranscript(input); }
  catch (error) {
    if (!(error instanceof TranscriptError) || input.endsWith("\n")) throw error;
    const boundary = input.lastIndexOf("\n");
    if (boundary < 0) throw error;
    return parseTranscript(input.slice(0, boundary + 1));
  }
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

function currentBranch(document: TranscriptDocument): TranscriptDocument {
  const byId = new Map(document.entries.flatMap(entry => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  let current = [...document.entries].reverse().find(entry => typeof entry.id === "string" && entry.message);
  const ids = new Set<string>();
  while (current && typeof current.id === "string" && !ids.has(current.id)) {
    ids.add(current.id); current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return ids.size ? { header: document.header, entries: document.entries.filter(entry => typeof entry.id === "string" && ids.has(entry.id)) } : document;
}

export class SessionReadData {
  private readonly agentsById: ReadonlyMap<string, ReadAgentConfig>;
  constructor(readonly agentsConfig: readonly ReadAgentConfig[], readonly dataRoot: string,
    private readonly contextBudget: ContextBudgetEstimator = new ConservativeContextBudget()) {
    const entries = agentsConfig.map(agent => {
      if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) throw new Error("agentId 格式无效");
      return [agent.agentId, { ...agent, sessionsRoot: resolve(agent.sessionsRoot) }] as const;
    });
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("agentId 重复");
    this.agentsById = new Map(entries); this.dataRoot = resolve(dataRoot);
  }

  private async assertRoot(agent: ReadAgentConfig): Promise<void> {
    const stat = await lstat(agent.sessionsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("sessions 根目录不安全");
  }

  async agents(): Promise<unknown[]> {
    return Promise.all([...this.agentsById.values()].map(async agent => {
      await this.assertRoot(agent);
      const sessions = await this.sessions(agent.agentId);
      return { id: agent.agentId, label: agent.label ?? agent.agentId, sessionCount: sessions.length };
    }));
  }

  private async externalRecords(agent: ReadAgentConfig): Promise<ConversationRecord[]> {
    await this.assertRoot(agent); const records: ConversationRecord[] = [];
    for (const name of (await readdir(agent.sessionsRoot)).sort()) {
      const active = ACTIVE.exec(name), reset = RESET.exec(name); if (!active && !reset) continue;
      const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, name)); const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      let document: TranscriptDocument;
      try { document = (active ? parseActive : parseTranscript)(await readFile(path, "utf8")); }
      catch (error) { if (active && (error instanceof TranscriptError)) continue; throw error; }
      const sourceKind = active ? "active" as const : "reset" as const; const sourceKey = active ? active[1]! : name;
      const identity: ReadonlySourceIdentity = { sourceKind, agentId: agent.agentId, sourceSessionId: (active ?? reset)![1]!, ...(reset ? { resetTimestamp: reset[2]! } : {}) };
      const metadata = await loadReadonlyMetadata(this.dataRoot, identity);
      records.push({ recordId: externalRecordId(agent.agentId, sourceKind, sourceKey), agentId: agent.agentId, sourceKind, sourceKey,
        revision: `${stat.size}:${stat.mtimeMs}`, updatedAt: stat.mtime.toISOString(), messageCount: document.entries.filter(entry => entry.type === "message").length,
        title: metadata.title ?? documentTitle(document), archived: metadata.archived, hidden: metadata.hidden,
        pinned: metadata.pinned ?? false, ...(metadata.project ? { project: metadata.project } : {}) });
    }
    return records;
  }

  private async panelRecords(agentId: string): Promise<ConversationRecord[]> {
    const result: ConversationRecord[] = [];
    for (const metadata of await listPanelSessions(this.dataRoot, agentId)) {
      const loaded = await loadPanelSession(this.dataRoot, agentId, metadata.recordId);
      const path = assertWithin(this.dataRoot, join(this.dataRoot, "sessions", agentId, metadata.recordId, "transcript.jsonl")); const stat = await lstat(path);
      result.push({ recordId: metadata.recordId, agentId, sourceKind: "panel", sourceKey: metadata.recordId,
        revision: `${stat.size}:${stat.mtimeMs}`, updatedAt: stat.mtime.toISOString(), messageCount: loaded.document.entries.filter(entry => entry.type === "message").length,
        title: metadata.title ?? documentTitle(loaded.document), archived: metadata.archived ?? false, hidden: metadata.hidden ?? false,
        pinned: metadata.pinned ?? false, ...(metadata.project ? { project: metadata.project } : {}) });
    }
    return result;
  }

  async sessions(agentId?: string, archived: boolean | null = false, includeHidden = false): Promise<ConversationRecord[]> {
    const agents = agentId ? [this.agentsById.get(agentId)].filter((item): item is ReadAgentConfig => !!item) : [...this.agentsById.values()];
    if (agentId && agents.length === 0) return [];
    const records = (await Promise.all(agents.map(async agent => [...await this.externalRecords(agent), ...await this.panelRecords(agent.agentId)]))).flat();
    return records.filter(record => (includeHidden || !record.hidden) && (archived === null || record.archived === archived))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async projects(agentId: string): Promise<string[]> {
    const canonical = new Map<string, string>();
    for (const record of await this.sessions(agentId, null)) {
      const project = record.project?.trim(); if (!project) continue;
      const key = project.toLocaleLowerCase(); if (!canonical.has(key)) canonical.set(key, project);
    }
    return [...canonical.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  }

  private async load(recordId: string): Promise<{ record: ConversationRecord; document: TranscriptDocument } | undefined> {
    const record = (await this.sessions(undefined, null, true)).find(item => item.recordId === recordId); if (!record) return undefined;
    if (record.sourceKind === "panel") return { record, document: (await loadPanelSession(this.dataRoot, record.agentId, record.recordId)).document };
    const agent = this.agentsById.get(record.agentId)!; await this.assertRoot(agent);
    const name = record.sourceKind === "active" ? `${record.sourceKey}.jsonl` : record.sourceKey;
    const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, name)); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("会话来源不安全");
    return { record, document: (record.sourceKind === "active" ? parseActive : parseTranscript)(await readFile(path, "utf8")) };
  }

  async conversation(recordId: string): Promise<unknown | null> {
    const loaded = await this.load(recordId);
    if (!loaded) return null;
    const header = loaded.document.header;
    const safeHeader = { type: header.type, version: header.version, id: header.id, timestamp: header.timestamp,
      ...(header.panel && typeof header.panel === "object" && !Array.isArray(header.panel) ? { panel: header.panel } : {}) };
    const safeEntries = loaded.document.entries.map(entry => ({
      type: entry.type, ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(entry.parentId === null || typeof entry.parentId === "string" ? { parentId: entry.parentId } : {}),
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      ...(entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? { message: entry.message } : {})
    }));
    const estimate = this.contextBudget.estimate(currentBranch(loaded.document), "");
    let modelOverride: string | null = null, thinkingLevel: string | null = null, reasoningLevel: string | null = null;
    if (loaded.record.sourceKind === "panel") {
      const metadata = (await loadPanelSession(this.dataRoot, loaded.record.agentId, loaded.record.recordId)).metadata;
      modelOverride = metadata.modelOverride ?? null; thinkingLevel = metadata.thinkingLevel ?? null; reasoningLevel = metadata.reasoningLevel ?? null;
    }
    const status: ConversationStatus = { modelOverride, thinkingLevel, reasoningLevel,
      contextBudget: { estimatedTokens: estimate.estimatedTokens, budgetTokens: estimate.budgetTokens,
        percentage: Math.round(estimate.estimatedTokens / estimate.budgetTokens * 100), method: estimate.method },
      lastActiveAt: loaded.record.updatedAt };
    return { ...loaded.record, status, document: { header: safeHeader, entries: safeEntries } };
  }

  async exportMarkdown(recordId: string): Promise<{ filename: string; markdown: string } | null> {
    const loaded = await this.load(recordId); if (!loaded) return null;
    return { filename: markdownFilename(loaded.record.title), markdown: exportTranscriptMarkdown(loaded.document, loaded.record.title, loaded.record.agentId) };
  }

  async createPanel(agentId: string, title?: string): Promise<unknown> {
    if (!this.agentsById.has(agentId)) throw new Error("AGENT_NOT_ALLOWED");
    const now = new Date().toISOString(), recordId = randomUUID();
    const safeTitle = title?.slice(0, 120);
    const metadata = await createPanelSession(this.dataRoot, agentId, { header: { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: ".", panel: { recordId, createdAt: now, ...(safeTitle ? { title: safeTitle } : {}) } }, entries: [] }, { recordId, createdAt: now, ...(safeTitle ? { title: safeTitle } : {}) });
    const record = (await this.panelRecords(agentId)).find(item => item.recordId === metadata.recordId);
    if (!record) throw new Error("PANEL_SESSION_CREATE_FAILED"); return record;
  }

  async search(query: string, agentId?: string): Promise<unknown[]> {
    const needle = query.trim().toLocaleLowerCase(); if (!needle) return [];
    const records = await this.sessions(agentId, null); const matches: unknown[] = [];
    for (const record of records) {
      const loaded = await this.load(record.recordId); if (!loaded) continue;
      const hits = loaded.document.entries.flatMap(entry => {
        const value = text(entry); const at = value.toLocaleLowerCase().indexOf(needle);
        return at < 0 ? [] : [{ entryId: typeof entry.id === "string" ? entry.id : null, role: role(entry) ?? null, snippet: value.slice(Math.max(0, at - 40), at + needle.length + 80) }];
      });
      if (hits.length) matches.push({ ...record, hits });
    }
    return matches;
  }

  async updateSession(recordId: string, patch: { title?: string; archived?: boolean; pinned?: boolean; project?: string | null }): Promise<ConversationRecord> {
    if (patch.title === undefined && patch.archived === undefined && patch.pinned === undefined && patch.project === undefined) throw new Error("SESSION_UPDATE_EMPTY");
    const title = patch.title?.trim(); if (patch.title !== undefined && (!title || title.length > 120)) throw new Error("SESSION_TITLE_INVALID");
    const project = patch.project?.trim(); if (patch.project !== undefined && patch.project !== null && (!project || project.length > 60 || /[\u0000-\u001f\u007f]/.test(project))) throw new Error("SESSION_PROJECT_INVALID");
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    if (loaded.record.sourceKind === "panel") {
      await updatePanelMetadata(this.dataRoot, loaded.record.agentId, recordId, current => { const next = { ...current, ...(title ? { title } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(project ? { project } : {}) }; if (patch.project === null) delete next.project; return next; });
    } else {
      const match = loaded.record.sourceKind === "active" ? [loaded.record.sourceKey, undefined] : (() => { const parsed = RESET.exec(loaded.record.sourceKey); return [parsed?.[1], parsed?.[2]]; })();
      if (!match[0]) throw new Error("SESSION_SOURCE_INVALID");
      const identity: ReadonlySourceIdentity = { sourceKind: loaded.record.sourceKind, agentId: loaded.record.agentId, sourceSessionId: match[0], ...(match[1] ? { resetTimestamp: match[1] } : {}) };
      await updateReadonlyMetadata(this.dataRoot, identity, current => { const next = { ...current, ...(title ? { title } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}), ...(project ? { project } : {}) }; if (patch.project === null) delete next.project; return next; });
    }
    const updated = (await this.sessions(undefined, null, true)).find(item => item.recordId === recordId); if (!updated) throw new Error("SESSION_NOT_FOUND"); return updated;
  }

  async deleteSession(recordId: string, confirmed: boolean): Promise<{ action: "deleted" | "hidden" }> {
    if (!confirmed) throw new Error("SESSION_DELETE_CONFIRMATION_REQUIRED");
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    if (loaded.record.sourceKind === "panel") {
      if (!loaded.record.archived) throw new Error("SESSION_NOT_ARCHIVED");
      await deletePanelSession(this.dataRoot, loaded.record.agentId, recordId); return { action: "deleted" };
    }
    const match = loaded.record.sourceKind === "active" ? [loaded.record.sourceKey, undefined] : (() => { const parsed = RESET.exec(loaded.record.sourceKey); return [parsed?.[1], parsed?.[2]]; })();
    if (!match[0]) throw new Error("SESSION_SOURCE_INVALID");
    const identity: ReadonlySourceIdentity = { sourceKind: loaded.record.sourceKind, agentId: loaded.record.agentId, sourceSessionId: match[0], ...(match[1] ? { resetTimestamp: match[1] } : {}) };
    await updateReadonlyMetadata(this.dataRoot, identity, current => ({ ...current, hidden: true })); return { action: "hidden" };
  }

  async fork(recordId: string, messageId: string): Promise<unknown> {
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    const createdAt = new Date().toISOString(); const newId = randomUUID();
    const document = deriveFork(loaded.document, messageId, { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt });
    const metadata = await createPanelSession(this.dataRoot, loaded.record.agentId, document, { parentRecordId: recordId, forkedFromMessageId: messageId, recordId: newId, createdAt });
    return { recordId: metadata.recordId, agentId: metadata.agentId, sourceKind: "panel" };
  }

  async editAndFork(recordId: string, messageId: string, replacement: string): Promise<unknown> {
    const loaded = await this.load(recordId); if (!loaded) throw new Error("SESSION_NOT_FOUND");
    const index = loaded.document.entries.findIndex(entry => entry.id === messageId); const target = loaded.document.entries[index];
    if (!target || role(target) !== "user") throw new Error("EDIT_TARGET_NOT_USER");
    const parent = typeof target.parentId === "string" ? target.parentId : null; const createdAt = new Date().toISOString(), newId = randomUUID();
    let base: TranscriptDocument;
    if (parent) base = deriveFork(loaded.document, parent, { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt });
    else base = { header: { ...loaded.document.header, id: randomUUID(), timestamp: createdAt,
      panel: { recordId: newId, parentRecordId: recordId, forkedFromMessageId: messageId, createdAt } }, entries: [] };
    const message = target.message as JsonObject;
    const edited: JsonObject = { ...target, id: randomUUID(), parentId: parent, timestamp: createdAt,
      message: { ...message, content: replacement, timestamp: Date.now() } };
    const metadata = await createPanelSession(this.dataRoot, loaded.record.agentId, { ...base, entries: [...base.entries, edited] }, { parentRecordId: recordId, forkedFromMessageId: messageId, recordId: newId, createdAt });
    return { recordId: metadata.recordId, agentId: metadata.agentId, sourceKind: "panel" };
  }
}
