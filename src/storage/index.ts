import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { externalRecordId } from "../domain/record-id.js";
import { parseTranscript, TranscriptError, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin } from "./atomic.js";
import { assertPanelSessionDataRoot, inspectPanelSession, loadIndexedPanelSession, scanPanelSessionLocators,
  type PanelMetadata, type PanelSessionDiagnosticSink, type PanelSessionLocator } from "./panel-sessions.js";
import { loadReadonlyMetadata, type ReadonlyMetadata, type ReadonlySourceIdentity } from "./readonly-metadata.js";

export interface SessionIndexAgent { agentId: string; sessionsRoot?: string }

interface IndexedSessionBase {
  recordId: string; agentId: string; sourceKey: string; revision: string; updatedAt: string;
  document: TranscriptDocument; fingerprint: string;
}

export type IndexedSession =
  | (IndexedSessionBase & { sourceKind: "active" | "reset"; identity: ReadonlySourceIdentity; metadata: ReadonlyMetadata })
  | (IndexedSessionBase & { sourceKind: "panel"; metadata: PanelMetadata });

export type SessionReadIndexEvent =
  | { type: "transcript_loaded" | "record_skipped"; agentId: string; recordId: string; sourceKind: "active" | "reset" | "panel" }
  | { type: "agent_scanned"; agentId: string };

export interface SessionReadIndexOptions {
  onEvent?: (event: SessionReadIndexEvent) => void;
  onPanelDiagnostic?: PanelSessionDiagnosticSink;
}

interface ExternalLocator {
  agentId: string; name: string; recordId: string; sourceKind: "active" | "reset"; sourceKey: string;
  identity: ReadonlySourceIdentity; revision: string; updatedAt: string; fingerprint: string;
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

function fingerprint(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");
}

async function safeExternalRead(path: string, allowAppend: boolean): Promise<{ text: string; stat: Stats }> {
  const candidate = await lstat(path);
  if (!candidate.isFile() || candidate.isSymbolicLink()) throw new Error("会话来源不安全");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== candidate.dev || before.ino !== candidate.ino) throw new Error("会话来源不安全");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const stableSnapshot = after.size === before.size && after.mtimeMs === before.mtimeMs;
    const appendOnlyGrowth = allowAppend && after.size > before.size;
    if (after.dev !== before.dev || after.ino !== before.ino || offset !== before.size ||
      (!stableSnapshot && !appendOnlyGrowth)) throw new Error("会话来源读取期间发生变化");
    // Index the prefix represented by `before`. If OpenClaw appended while it was
    // read, the next fingerprint check observes `after` and refreshes that tail.
    return { text: bytes.toString("utf8"), stat: before };
  } finally { await handle.close(); }
}

export class SessionReadIndex {
  private readonly agents: ReadonlyMap<string, { agentId: string; sessionsRoot?: string }>;
  private readonly entries = new Map<string, IndexedSession>();
  private readonly byAgent = new Map<string, Set<string>>();
  private readonly failed = new Map<string, string>();
  private readonly built = new Set<string>();
  private readonly refreshing = new Map<string, { promise: Promise<void>; full: boolean }>();
  private generation = 0;
  private readonly dataRoot: string;

  constructor(agents: readonly SessionIndexAgent[], dataRoot: string, private readonly options: SessionReadIndexOptions = {}) {
    const normalized = agents.map(agent => {
      if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) throw new Error("agentId 格式无效");
      return [agent.agentId, { agentId: agent.agentId,
        ...(agent.sessionsRoot ? { sessionsRoot: resolve(agent.sessionsRoot) } : {}) }] as const;
    });
    if (new Set(normalized.map(([agentId]) => agentId)).size !== normalized.length) throw new Error("agentId 重复");
    this.agents = new Map(normalized); this.dataRoot = resolve(dataRoot);
  }

  private event(event: SessionReadIndexEvent): void {
    try { this.options.onEvent?.(event); } catch { /* Read-model instrumentation must not affect storage. */ }
  }

  private panelDiagnostic(): PanelSessionDiagnosticSink | undefined {
    return this.options.onPanelDiagnostic;
  }

  private async assertExternalRoot(root: string): Promise<void> {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("sessions 根目录不安全");
  }

  private externalLocator(agent: { agentId: string; sessionsRoot: string }, name: string, stat: Stats): ExternalLocator | undefined {
    const active = ACTIVE.exec(name), reset = RESET.exec(name); if (!active && !reset) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const sourceKind = active ? "active" as const : "reset" as const;
    const sourceKey = active ? active[1]! : name;
    const identity: ReadonlySourceIdentity = { sourceKind, agentId: agent.agentId,
      sourceSessionId: (active ?? reset)![1]!, ...(reset ? { resetTimestamp: reset[2]! } : {}) };
    return { agentId: agent.agentId, name, sourceKind, sourceKey, identity,
      recordId: externalRecordId(agent.agentId, sourceKind, sourceKey), revision: `${stat.size}:${stat.mtimeMs}`,
      updatedAt: stat.mtime.toISOString(), fingerprint: fingerprint(stat) };
  }

  private async inspectExternal(agent: { agentId: string; sessionsRoot: string }, name: string): Promise<ExternalLocator | undefined> {
    const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, name));
    try { return this.externalLocator(agent, name, await lstat(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async externalLocators(agent: { agentId: string; sessionsRoot: string }): Promise<ExternalLocator[]> {
    await this.assertExternalRoot(agent.sessionsRoot);
    const result: ExternalLocator[] = [];
    for (const name of (await readdir(agent.sessionsRoot)).sort()) {
      const locator = await this.inspectExternal(agent, name);
      if (locator) result.push(locator);
    }
    return result;
  }

  private failureKey(agentId: string, sourceKind: IndexedSession["sourceKind"], sourceKey: string): string {
    return `${agentId}\0${sourceKind}\0${sourceKey}`;
  }

  private async loadExternal(agent: { agentId: string; sessionsRoot: string }, locator: ExternalLocator): Promise<IndexedSession | undefined> {
    const key = this.failureKey(agent.agentId, locator.sourceKind, locator.sourceKey);
    if (this.failed.get(key) === locator.fingerprint) return undefined;
    try {
      const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, locator.name));
      const source = await safeExternalRead(path, locator.sourceKind === "active");
      const document = (locator.sourceKind === "active" ? parseActive : parseTranscript)(source.text);
      const metadata = await loadReadonlyMetadata(this.dataRoot, locator.identity);
      const actual = { ...locator, revision: `${source.stat.size}:${source.stat.mtimeMs}`,
        updatedAt: source.stat.mtime.toISOString(), fingerprint: fingerprint(source.stat) };
      this.failed.delete(key); this.event({ type: "transcript_loaded", agentId: agent.agentId,
        recordId: locator.recordId, sourceKind: locator.sourceKind });
      return { recordId: actual.recordId, agentId: actual.agentId, sourceKind: actual.sourceKind,
        sourceKey: actual.sourceKey, identity: actual.identity, revision: actual.revision,
        updatedAt: actual.updatedAt, fingerprint: actual.fingerprint, document, metadata };
    } catch (error) {
      const sourceRace = (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof Error && (error.message === "会话来源不安全" || error.message === "会话来源读取期间发生变化");
      if (!(error instanceof TranscriptError) && !sourceRace) throw error;
      this.failed.set(key, locator.fingerprint); this.event({ type: "record_skipped", agentId: agent.agentId,
        recordId: locator.recordId, sourceKind: locator.sourceKind });
      return undefined;
    }
  }

  private async loadPanel(agentId: string, locator: PanelSessionLocator): Promise<IndexedSession | undefined> {
    const key = this.failureKey(agentId, "panel", locator.recordId);
    if (this.failed.get(key) === locator.fingerprint) return undefined;
    const diagnostic = this.panelDiagnostic();
    const loaded = diagnostic === undefined ? await loadIndexedPanelSession(this.dataRoot, agentId, locator.recordId) :
      await loadIndexedPanelSession(this.dataRoot, agentId, locator.recordId, diagnostic);
    if (!loaded) {
      this.failed.set(key, locator.fingerprint); this.event({ type: "record_skipped", agentId,
        recordId: locator.recordId, sourceKind: "panel" }); return undefined;
    }
    this.failed.delete(key); this.event({ type: "transcript_loaded", agentId,
      recordId: locator.recordId, sourceKind: "panel" });
    return { recordId: loaded.metadata.recordId, agentId, sourceKind: "panel", sourceKey: loaded.metadata.recordId,
      revision: loaded.revision, updatedAt: loaded.updatedAt, fingerprint: loaded.fingerprint,
      document: loaded.document, metadata: loaded.metadata };
  }

  private async refreshAgentNow(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId); if (!agent) return;
    await assertPanelSessionDataRoot(this.dataRoot);
    const generation = this.generation;
    this.event({ type: "agent_scanned", agentId });
    const next = new Map<string, IndexedSession>();
    if (agent.sessionsRoot) {
      const externalAgent = { agentId, sessionsRoot: agent.sessionsRoot };
      for (const locator of await this.externalLocators(externalAgent)) {
        const cached = this.entries.get(locator.recordId);
        let entry: IndexedSession | undefined;
        if (cached?.sourceKind !== "panel" && cached?.agentId === agentId && cached.fingerprint === locator.fingerprint) {
          entry = { ...cached, metadata: await loadReadonlyMetadata(this.dataRoot, locator.identity) };
        } else entry = await this.loadExternal(externalAgent, locator);
        if (entry) next.set(entry.recordId, entry);
      }
    }
    const diagnostic = this.panelDiagnostic();
    const panelLocators = diagnostic === undefined ? await scanPanelSessionLocators(this.dataRoot, agentId) :
      await scanPanelSessionLocators(this.dataRoot, agentId, diagnostic);
    for (const locator of panelLocators) {
      const cached = this.entries.get(locator.recordId);
      const entry = cached?.sourceKind === "panel" && cached.agentId === agentId && cached.fingerprint === locator.fingerprint ?
        cached : await this.loadPanel(agentId, locator);
      if (entry && !next.has(entry.recordId)) next.set(entry.recordId, entry);
    }
    if (generation !== this.generation) return;
    for (const recordId of this.byAgent.get(agentId) ?? []) this.entries.delete(recordId);
    for (const [recordId, entry] of next) this.entries.set(recordId, entry);
    this.byAgent.set(agentId, new Set(next.keys())); this.built.add(agentId);
  }

  private async refreshAgent(agentId: string): Promise<void> {
    while (true) {
      const current = this.refreshing.get(agentId);
      if (!current) break;
      if (current.full) {
        await current.promise;
        if (this.built.has(agentId)) return;
        continue;
      }
      await current.promise;
    }
    const promise = this.refreshAgentNow(agentId), refresh = { promise, full: true };
    this.refreshing.set(agentId, refresh);
    try { await promise; }
    finally { if (this.refreshing.get(agentId) === refresh) this.refreshing.delete(agentId); }
  }

  private async exclusiveAgent(agentId: string, operation: () => Promise<void>): Promise<void> {
    while (this.refreshing.has(agentId)) await this.refreshing.get(agentId)!.promise;
    const promise = operation(), refresh = { promise, full: false }; this.refreshing.set(agentId, refresh);
    try { await promise; }
    finally { if (this.refreshing.get(agentId) === refresh) this.refreshing.delete(agentId); }
  }

  private async refreshKnown(entry: IndexedSession): Promise<void> {
    await this.exclusiveAgent(entry.agentId, async () => {
      let next: IndexedSession | undefined;
      if (entry.sourceKind === "panel") {
        const diagnostic = this.panelDiagnostic();
        const locator = diagnostic === undefined ? await inspectPanelSession(this.dataRoot, entry.agentId, entry.recordId) :
          await inspectPanelSession(this.dataRoot, entry.agentId, entry.recordId, diagnostic);
        if (locator) next = locator.fingerprint === entry.fingerprint ? entry : await this.loadPanel(entry.agentId, locator);
      } else {
        const agent = this.agents.get(entry.agentId);
        if (agent?.sessionsRoot) {
          await this.assertExternalRoot(agent.sessionsRoot);
          const name = entry.sourceKind === "active" ? `${entry.sourceKey}.jsonl` : entry.sourceKey;
          const externalAgent = { agentId: entry.agentId, sessionsRoot: agent.sessionsRoot };
          const locator = await this.inspectExternal(externalAgent, name);
          if (locator) next = locator.fingerprint === entry.fingerprint ?
            { ...entry, metadata: await loadReadonlyMetadata(this.dataRoot, locator.identity) } :
            await this.loadExternal(externalAgent, locator);
        }
      }
      if (next) this.entries.set(entry.recordId, next);
      else { this.entries.delete(entry.recordId); this.byAgent.get(entry.agentId)?.delete(entry.recordId); }
    });
  }

  async initialize(): Promise<void> {
    await Promise.all([...this.agents.keys()].filter(agentId => !this.built.has(agentId)).map(agentId => this.refreshAgent(agentId)));
  }

  hasAgent(agentId: string): boolean { return this.agents.has(agentId); }

  async snapshot(agentId?: string): Promise<readonly IndexedSession[]> {
    if (agentId && !this.agents.has(agentId)) return [];
    const selected = agentId ? [agentId] : [...this.agents.keys()];
    await Promise.all(selected.map(id => this.refreshAgent(id)));
    return [...this.entries.values()].filter(entry => !agentId || entry.agentId === agentId);
  }

  async lookup(recordId: string): Promise<IndexedSession | undefined> {
    await assertPanelSessionDataRoot(this.dataRoot);
    if (this.built.size !== this.agents.size) {
      await this.initialize();
    } else {
      await Promise.all([...this.agents.values()].flatMap(agent => agent.sessionsRoot ? [this.assertExternalRoot(agent.sessionsRoot)] : []));
    }
    const cached = this.entries.get(recordId);
    if (!cached) return undefined;
    await this.refreshKnown(cached); return this.entries.get(recordId);
  }

  async refreshPanel(agentId: string, recordId: string): Promise<IndexedSession | undefined> {
    if (!this.agents.has(agentId)) return undefined;
    await this.exclusiveAgent(agentId, async () => {
      const diagnostic = this.panelDiagnostic();
      const locator = diagnostic === undefined ? await inspectPanelSession(this.dataRoot, agentId, recordId) :
        await inspectPanelSession(this.dataRoot, agentId, recordId, diagnostic);
      const entry = locator ? await this.loadPanel(agentId, locator) : undefined;
      if (entry) { this.entries.set(recordId, entry); const ids = this.byAgent.get(agentId) ?? new Set<string>(); ids.add(recordId); this.byAgent.set(agentId, ids); }
      else { this.entries.delete(recordId); this.byAgent.get(agentId)?.delete(recordId); }
    });
    return this.entries.get(recordId);
  }

  forget(recordId: string): void {
    const entry = this.entries.get(recordId); if (entry) this.byAgent.get(entry.agentId)?.delete(recordId);
    this.entries.delete(recordId);
  }

  clear(): void {
    this.generation++; this.entries.clear(); this.byAgent.clear(); this.failed.clear(); this.built.clear();
  }
}
