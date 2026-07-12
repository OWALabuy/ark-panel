import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveFork } from "../domain/fork.js";
import { externalRecordId } from "../domain/record-id.js";
import { parseTranscript, TranscriptError, type JsonObject, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin } from "../storage/atomic.js";
import { createPanelSession, listPanelSessions, loadPanelSession } from "../storage/panel-sessions.js";

export interface ReadAgentConfig { agentId: string; sessionsRoot: string; label?: string }
export interface ConversationRecord {
  recordId: string; agentId: string; sourceKind: "active" | "reset" | "panel"; sourceKey: string;
  revision: string; updatedAt: string; messageCount: number; title: string;
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

export class SessionReadData {
  private readonly agentsById: ReadonlyMap<string, ReadAgentConfig>;
  constructor(readonly agentsConfig: readonly ReadAgentConfig[], readonly dataRoot: string) {
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
      records.push({ recordId: externalRecordId(agent.agentId, sourceKind, sourceKey), agentId: agent.agentId, sourceKind, sourceKey,
        revision: `${stat.size}:${stat.mtimeMs}`, updatedAt: stat.mtime.toISOString(), messageCount: document.entries.filter(entry => entry.type === "message").length, title: documentTitle(document) });
    }
    return records;
  }

  private async panelRecords(agentId: string): Promise<ConversationRecord[]> {
    const result: ConversationRecord[] = [];
    for (const metadata of await listPanelSessions(this.dataRoot, agentId)) {
      const loaded = await loadPanelSession(this.dataRoot, agentId, metadata.recordId);
      const path = assertWithin(this.dataRoot, join(this.dataRoot, "sessions", agentId, metadata.recordId, "transcript.jsonl")); const stat = await lstat(path);
      result.push({ recordId: metadata.recordId, agentId, sourceKind: "panel", sourceKey: metadata.recordId,
        revision: `${stat.size}:${stat.mtimeMs}`, updatedAt: stat.mtime.toISOString(), messageCount: loaded.document.entries.filter(entry => entry.type === "message").length, title: documentTitle(loaded.document) });
    }
    return result;
  }

  async sessions(agentId?: string): Promise<ConversationRecord[]> {
    const agents = agentId ? [this.agentsById.get(agentId)].filter((item): item is ReadAgentConfig => !!item) : [...this.agentsById.values()];
    if (agentId && agents.length === 0) return [];
    const records = (await Promise.all(agents.map(async agent => [...await this.externalRecords(agent), ...await this.panelRecords(agent.agentId)]))).flat();
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async load(recordId: string): Promise<{ record: ConversationRecord; document: TranscriptDocument } | undefined> {
    const record = (await this.sessions()).find(item => item.recordId === recordId); if (!record) return undefined;
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
    return { ...loaded.record, document: { header: safeHeader, entries: safeEntries } };
  }

  async createPanel(agentId: string, title?: string): Promise<unknown> {
    if (!this.agentsById.has(agentId)) throw new Error("AGENT_NOT_ALLOWED");
    const now = new Date().toISOString(), recordId = randomUUID();
    const metadata = await createPanelSession(this.dataRoot, agentId, { header: { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd: ".", panel: { recordId, createdAt: now, ...(title ? { title: title.slice(0, 120) } : {}) } }, entries: [] }, { recordId, createdAt: now });
    const record = (await this.panelRecords(agentId)).find(item => item.recordId === metadata.recordId);
    if (!record) throw new Error("PANEL_SESSION_CREATE_FAILED"); return record;
  }

  async search(query: string, agentId?: string): Promise<unknown[]> {
    const needle = query.trim().toLocaleLowerCase(); if (!needle) return [];
    const records = await this.sessions(agentId); const matches: unknown[] = [];
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
