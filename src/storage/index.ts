import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { externalRecordId } from "../domain/record-id.js";
import { parseTranscript, TranscriptError, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin } from "./atomic.js";
import { assertPanelSessionDataRoot, inspectPanelSession, loadIndexedPanelSession, scanPanelSessionLocators,
  type PanelMetadata, type PanelSessionDiagnosticSink, type PanelSessionLocator } from "./panel-sessions.js";
import { loadReadonlyMetadata, type ReadonlyMetadata, type ReadonlySourceIdentity } from "./readonly-metadata.js";

export interface SessionIndexAgent { agentId: string; sessionsRoot?: string }

export function mergeSessionIndexAgents(readAgents: readonly SessionIndexAgent[],
  panelAgentIds: Iterable<string>): SessionIndexAgent[] {
  const merged = new Map<string, SessionIndexAgent>();
  for (const agent of readAgents) merged.set(agent.agentId, agent);
  for (const agentId of panelAgentIds) if (!merged.has(agentId)) merged.set(agentId, { agentId });
  return [...merged.values()];
}

export type SessionIndexSourceKind = "active" | "reset" | "panel";

export interface SessionIdentity {
  agentId: string; sourceKind: SessionIndexSourceKind; sourceKey: string; recordId: string;
}

interface IndexedSessionBase extends SessionIdentity {
  identityKey: string; revision: string; updatedAt: string;
  document: TranscriptDocument; fingerprint: string;
}

export type IndexedSession =
  | (IndexedSessionBase & { sourceKind: "active" | "reset"; identity: ReadonlySourceIdentity; metadata: ReadonlyMetadata })
  | (IndexedSessionBase & { sourceKind: "panel"; metadata: PanelMetadata });

export type SessionReadIndexEvent =
  | { type: "transcript_loaded" | "record_skipped"; agentId: string; recordId: string; sourceKind: SessionIndexSourceKind }
  | { type: "agent_scanned"; agentId: string };

interface SessionIndexFileHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SessionReadIndexFileSystem {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number): Promise<SessionIndexFileHandle>;
}

export interface SessionReadIndexPublishProbe {
  type: "full" | "targeted"; agentId: string; identityKey?: string;
}

export interface SessionReadIndexOptions {
  onEvent?: (event: SessionReadIndexEvent) => void;
  onPanelDiagnostic?: PanelSessionDiagnosticSink;
  fileSystem?: SessionReadIndexFileSystem;
  beforeTargetRefresh?: (identity: Readonly<SessionIdentity>) => void | Promise<void>;
  beforePublish?: (probe: Readonly<SessionReadIndexPublishProbe>) => void | Promise<void>;
}

interface ExternalLocator extends SessionIdentity {
  name: string; sourceKind: "active" | "reset"; identity: ReadonlySourceIdentity;
  revision: string; updatedAt: string; fingerprint: string;
}

interface EpochToken { global: number; agent: number }

const ACTIVE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const RESET = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl\.reset\.(.+)$/i;
const SOURCE_RANK: Readonly<Record<SessionIndexSourceKind, number>> = { active: 0, reset: 1, panel: 2 };

const defaultFileSystem: SessionReadIndexFileSystem = {
  lstat: async path => await lstat(path),
  readdir: async path => await readdir(path),
  open: async (path, flags) => await open(path, flags) as FileHandle
};

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

export function sessionIdentityKey(identity: Pick<SessionIdentity, "agentId" | "sourceKind" | "sourceKey">): string {
  return JSON.stringify([identity.agentId, identity.sourceKind, identity.sourceKey]);
}

function identityOf(entry: IndexedSession): SessionIdentity {
  return { agentId: entry.agentId, sourceKind: entry.sourceKind, sourceKey: entry.sourceKey, recordId: entry.recordId };
}

function panelIdentity(agentId: string, recordId: string): SessionIdentity & { sourceKind: "panel" } {
  return { agentId, sourceKind: "panel", sourceKey: recordId, recordId };
}

export class SessionReadIndex {
  private readonly agents: ReadonlyMap<string, { agentId: string; sessionsRoot?: string }>;
  private readonly agentRank = new Map<string, number>();
  private readonly entries = new Map<string, IndexedSession>();
  private readonly known = new Map<string, SessionIdentity>();
  private readonly byRecord = new Map<string, Set<string>>();
  private readonly byAgent = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly built = new Set<string>();
  private readonly refreshing = new Map<string, Promise<boolean>>();
  private readonly agentEpoch = new Map<string, number>();
  private globalEpoch = 0;
  private readonly dataRoot: string;
  private readonly fileSystem: SessionReadIndexFileSystem;

  constructor(agents: readonly SessionIndexAgent[], dataRoot: string, private readonly options: SessionReadIndexOptions = {}) {
    const normalized = agents.map((agent, index) => {
      if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) throw new Error("agentId 格式无效");
      this.agentRank.set(agent.agentId, index); this.agentEpoch.set(agent.agentId, 0);
      return [agent.agentId, { agentId: agent.agentId,
        ...(agent.sessionsRoot ? { sessionsRoot: resolve(agent.sessionsRoot) } : {}) }] as const;
    });
    if (new Set(normalized.map(([agentId]) => agentId)).size !== normalized.length) throw new Error("agentId 重复");
    this.agents = new Map(normalized); this.dataRoot = resolve(dataRoot);
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  private event(event: SessionReadIndexEvent): void {
    try { this.options.onEvent?.(event); } catch { /* Read-model instrumentation must not affect storage. */ }
  }

  private panelDiagnostic(): PanelSessionDiagnosticSink | undefined {
    return this.options.onPanelDiagnostic;
  }

  private token(agentId: string): EpochToken {
    return { global: this.globalEpoch, agent: this.agentEpoch.get(agentId) ?? 0 };
  }

  private tokenCurrent(agentId: string, token: EpochToken): boolean {
    return token.global === this.globalEpoch && token.agent === (this.agentEpoch.get(agentId) ?? 0);
  }

  private bumpAgent(agentId: string): void {
    this.agentEpoch.set(agentId, (this.agentEpoch.get(agentId) ?? 0) + 1);
  }

  private ordered(values: Iterable<string>): Set<string> {
    return new Set([...values].sort());
  }

  private register(identity: SessionIdentity): string {
    const key = sessionIdentityKey(identity), previous = this.known.get(key);
    if (previous && previous.recordId !== identity.recordId) this.unregister(key);
    this.known.set(key, identity);
    const recordKeys = this.byRecord.get(identity.recordId) ?? new Set<string>();
    recordKeys.add(key); this.byRecord.set(identity.recordId, this.ordered(recordKeys));
    const agentKeys = this.byAgent.get(identity.agentId) ?? new Set<string>();
    agentKeys.add(key); this.byAgent.set(identity.agentId, this.ordered(agentKeys));
    return key;
  }

  private unregister(key: string): void {
    const identity = this.known.get(key); if (!identity) return;
    this.known.delete(key); this.entries.delete(key); this.dirty.delete(key);
    const recordKeys = this.byRecord.get(identity.recordId); recordKeys?.delete(key);
    if (recordKeys?.size) this.byRecord.set(identity.recordId, this.ordered(recordKeys));
    else this.byRecord.delete(identity.recordId);
    const agentKeys = this.byAgent.get(identity.agentId); agentKeys?.delete(key);
    if (agentKeys?.size) this.byAgent.set(identity.agentId, this.ordered(agentKeys));
    else this.byAgent.delete(identity.agentId);
  }

  private store(entry: IndexedSession): void {
    const key = this.register(identityOf(entry)); this.entries.set(key, entry); this.dirty.delete(key);
  }

  private replaceAgent(agentId: string, next: ReadonlyMap<string, IndexedSession>): void {
    for (const key of [...(this.byAgent.get(agentId) ?? [])]) this.unregister(key);
    for (const entry of [...next.values()].sort((left, right) => left.identityKey.localeCompare(right.identityKey))) this.store(entry);
  }

  private async assertExternalRoot(root: string): Promise<void> {
    const stat = await this.fileSystem.lstat(root);
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
    try { return this.externalLocator(agent, name, await this.fileSystem.lstat(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async externalLocators(agent: { agentId: string; sessionsRoot: string }): Promise<ExternalLocator[]> {
    await this.assertExternalRoot(agent.sessionsRoot);
    const result: ExternalLocator[] = [];
    for (const name of (await this.fileSystem.readdir(agent.sessionsRoot)).sort()) {
      const locator = await this.inspectExternal(agent, name);
      if (locator) result.push(locator);
    }
    return result;
  }

  private async safeExternalRead(path: string, allowAppend: boolean): Promise<{ text: string; stat: Stats }> {
    const candidate = await this.fileSystem.lstat(path);
    if (!candidate.isFile() || candidate.isSymbolicLink()) throw new Error("会话来源不安全");
    const handle = await this.fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
      return { text: bytes.toString("utf8"), stat: before };
    } finally { await handle.close(); }
  }

  private async loadExternal(agent: { agentId: string; sessionsRoot: string }, locator: ExternalLocator,
    token: EpochToken): Promise<IndexedSession | undefined> {
    const key = sessionIdentityKey(locator);
    if (this.failed.get(key) === locator.fingerprint) return undefined;
    try {
      const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, locator.name));
      const source = await this.safeExternalRead(path, locator.sourceKind === "active");
      const document = (locator.sourceKind === "active" ? parseActive : parseTranscript)(source.text);
      const metadata = await loadReadonlyMetadata(this.dataRoot, locator.identity);
      const actual = { ...locator, revision: `${source.stat.size}:${source.stat.mtimeMs}`,
        updatedAt: source.stat.mtime.toISOString(), fingerprint: fingerprint(source.stat) };
      if (this.tokenCurrent(agent.agentId, token)) this.failed.delete(key);
      this.event({ type: "transcript_loaded", agentId: agent.agentId,
        recordId: locator.recordId, sourceKind: locator.sourceKind });
      return { recordId: actual.recordId, agentId: actual.agentId, sourceKind: actual.sourceKind,
        sourceKey: actual.sourceKey, identityKey: key, identity: actual.identity, revision: actual.revision,
        updatedAt: actual.updatedAt, fingerprint: actual.fingerprint, document, metadata };
    } catch (error) {
      const sourceRace = (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof Error && (error.message === "会话来源不安全" || error.message === "会话来源读取期间发生变化");
      if (!(error instanceof TranscriptError) && !sourceRace) throw error;
      if (this.tokenCurrent(agent.agentId, token)) this.failed.set(key, locator.fingerprint);
      this.event({ type: "record_skipped", agentId: agent.agentId,
        recordId: locator.recordId, sourceKind: locator.sourceKind });
      return undefined;
    }
  }

  private async loadPanel(agentId: string, locator: PanelSessionLocator, token: EpochToken): Promise<IndexedSession | undefined> {
    const identity = panelIdentity(agentId, locator.recordId), key = sessionIdentityKey(identity);
    if (this.failed.get(key) === locator.fingerprint) return undefined;
    const diagnostic = this.panelDiagnostic();
    const loaded = diagnostic === undefined ? await loadIndexedPanelSession(this.dataRoot, agentId, locator.recordId) :
      await loadIndexedPanelSession(this.dataRoot, agentId, locator.recordId, diagnostic);
    if (!loaded) {
      if (this.tokenCurrent(agentId, token)) this.failed.set(key, locator.fingerprint);
      this.event({ type: "record_skipped", agentId, recordId: locator.recordId, sourceKind: "panel" }); return undefined;
    }
    if (this.tokenCurrent(agentId, token)) this.failed.delete(key);
    this.event({ type: "transcript_loaded", agentId, recordId: locator.recordId, sourceKind: "panel" });
    return { ...identity, identityKey: key, revision: loaded.revision, updatedAt: loaded.updatedAt,
      fingerprint: loaded.fingerprint, document: loaded.document, metadata: loaded.metadata };
  }

  private async refreshAgentAttempt(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId); if (!agent) return true;
    await assertPanelSessionDataRoot(this.dataRoot);
    const token = this.token(agentId); this.event({ type: "agent_scanned", agentId });
    const next = new Map<string, IndexedSession>();
    if (agent.sessionsRoot) {
      const externalAgent = { agentId, sessionsRoot: agent.sessionsRoot };
      for (const locator of await this.externalLocators(externalAgent)) {
        const key = sessionIdentityKey(locator), cached = this.entries.get(key);
        let entry: IndexedSession | undefined;
        if (cached && cached.sourceKind !== "panel" && cached.fingerprint === locator.fingerprint) {
          entry = { ...cached, metadata: await loadReadonlyMetadata(this.dataRoot, locator.identity) };
        } else entry = await this.loadExternal(externalAgent, locator, token);
        if (entry) next.set(key, entry);
      }
    }
    const diagnostic = this.panelDiagnostic();
    const panelLocators = diagnostic === undefined ? await scanPanelSessionLocators(this.dataRoot, agentId) :
      await scanPanelSessionLocators(this.dataRoot, agentId, diagnostic);
    for (const locator of panelLocators) {
      const key = sessionIdentityKey(panelIdentity(agentId, locator.recordId)), cached = this.entries.get(key);
      const entry = cached?.sourceKind === "panel" && cached.fingerprint === locator.fingerprint ?
        cached : await this.loadPanel(agentId, locator, token);
      if (entry) next.set(key, entry);
    }
    await this.options.beforePublish?.({ type: "full", agentId });
    if (!this.tokenCurrent(agentId, token)) return false;
    this.replaceAgent(agentId, next); this.bumpAgent(agentId); this.built.add(agentId); return true;
  }

  private async refreshAgent(agentId: string): Promise<void> {
    while (true) {
      const current = this.refreshing.get(agentId);
      if (current) { if (await current) return; continue; }
      const promise = this.refreshAgentAttempt(agentId); this.refreshing.set(agentId, promise);
      try { if (await promise) return; }
      finally { if (this.refreshing.get(agentId) === promise) this.refreshing.delete(agentId); }
    }
  }

  private async refreshIdentityAttempt(identityKey: string): Promise<{ published: boolean; entry?: IndexedSession }> {
    const identity = this.known.get(identityKey); if (!identity) return { published: true };
    const token = this.token(identity.agentId); await assertPanelSessionDataRoot(this.dataRoot);
    if (this.dirty.has(identityKey)) await this.options.beforeTargetRefresh?.(identity);
    let next: IndexedSession | undefined;
    if (identity.sourceKind === "panel") {
      const diagnostic = this.panelDiagnostic();
      const locator = diagnostic === undefined ? await inspectPanelSession(this.dataRoot, identity.agentId, identity.recordId) :
        await inspectPanelSession(this.dataRoot, identity.agentId, identity.recordId, diagnostic);
      const cached = this.entries.get(identityKey);
      if (locator) next = cached?.sourceKind === "panel" && cached.fingerprint === locator.fingerprint ?
        cached : await this.loadPanel(identity.agentId, locator, token);
    } else {
      const agent = this.agents.get(identity.agentId);
      if (agent?.sessionsRoot) {
        await this.assertExternalRoot(agent.sessionsRoot);
        const name = identity.sourceKind === "active" ? `${identity.sourceKey}.jsonl` : identity.sourceKey;
        const externalAgent = { agentId: identity.agentId, sessionsRoot: agent.sessionsRoot };
        const locator = await this.inspectExternal(externalAgent, name), cached = this.entries.get(identityKey);
        if (locator) next = cached && cached.sourceKind !== "panel" && cached.fingerprint === locator.fingerprint ?
          { ...cached, metadata: await loadReadonlyMetadata(this.dataRoot, locator.identity) } :
          await this.loadExternal(externalAgent, locator, token);
      }
    }
    await this.options.beforePublish?.({ type: "targeted", agentId: identity.agentId, identityKey });
    if (!this.tokenCurrent(identity.agentId, token) || this.known.get(identityKey)?.recordId !== identity.recordId) {
      return { published: false };
    }
    if (next) this.store(next); else this.unregister(identityKey);
    this.bumpAgent(identity.agentId);
    return next ? { published: true, entry: next } : { published: true };
  }

  private async refreshIdentityKey(identityKey: string): Promise<IndexedSession | undefined> {
    while (this.known.has(identityKey)) {
      const result = await this.refreshIdentityAttempt(identityKey);
      if (result.published) return result.entry;
    }
    return undefined;
  }

  async initialize(agentIds: Iterable<string> = this.agents.keys()): Promise<void> {
    const selected = [...new Set(agentIds)].filter(agentId => this.agents.has(agentId) && !this.built.has(agentId));
    await Promise.all(selected.map(agentId => this.refreshAgent(agentId)));
  }

  hasAgent(agentId: string): boolean { return this.agents.has(agentId); }
  hasDataRoot(dataRoot: string): boolean { return this.dataRoot === resolve(dataRoot); }

  compare(left: IndexedSession, right: IndexedSession): number {
    return (this.agentRank.get(left.agentId) ?? Number.MAX_SAFE_INTEGER) -
      (this.agentRank.get(right.agentId) ?? Number.MAX_SAFE_INTEGER) ||
      SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind] ||
      left.recordId.localeCompare(right.recordId) || left.sourceKey.localeCompare(right.sourceKey) ||
      left.identityKey.localeCompare(right.identityKey);
  }

  async snapshot(agentId?: string): Promise<readonly IndexedSession[]> {
    if (agentId && !this.agents.has(agentId)) return [];
    const selected = agentId ? [agentId] : [...this.agents.keys()];
    return await this.snapshotSelected(selected);
  }

  async snapshotAgents(agentIds: Iterable<string>): Promise<readonly IndexedSession[]> {
    const selected = [...new Set(agentIds)].filter(agentId => this.agents.has(agentId));
    return await this.snapshotSelected(selected);
  }

  private async snapshotSelected(selected: readonly string[]): Promise<readonly IndexedSession[]> {
    const allowed = new Set(selected);
    while (true) {
      await Promise.all(selected.map(id => this.refreshAgent(id)));
      if (!selected.every(id => this.built.has(id))) continue;
      return [...this.entries.values()].filter(entry => allowed.has(entry.agentId))
        .sort((left, right) => this.compare(left, right));
    }
  }

  private candidateKeys(recordId: string, allowedAgentIds?: ReadonlySet<string>): string[] {
    return [...(this.byRecord.get(recordId) ?? [])].filter(key => {
      const identity = this.known.get(key);
      return identity !== undefined && (!allowedAgentIds || allowedAgentIds.has(identity.agentId));
    });
  }

  async lookup(recordId: string, agentIds?: Iterable<string>): Promise<IndexedSession | undefined> {
    await assertPanelSessionDataRoot(this.dataRoot);
    const allowedAgentIds = agentIds ? new Set(agentIds) : undefined;
    await this.initialize(allowedAgentIds ?? this.agents.keys());
    const initial = this.candidateKeys(recordId, allowedAgentIds);
    if (initial.length !== 1) return undefined;
    await this.refreshIdentityKey(initial[0]!);
    const candidates = this.candidateKeys(recordId, allowedAgentIds);
    if (candidates.length !== 1) return undefined;
    return this.entries.get(candidates[0]!);
  }

  invalidate(entry: IndexedSession): void {
    if (!this.agents.has(entry.agentId)) return;
    this.bumpAgent(entry.agentId); const key = this.register(identityOf(entry)); this.dirty.add(key);
  }

  invalidatePanel(agentId: string, recordId: string): void {
    if (!this.agents.has(agentId)) return;
    this.bumpAgent(agentId); const key = this.register(panelIdentity(agentId, recordId)); this.dirty.add(key);
  }

  async refresh(entry: IndexedSession): Promise<IndexedSession | undefined> {
    return await this.refreshIdentityKey(entry.identityKey);
  }

  async refreshPanel(agentId: string, recordId: string): Promise<IndexedSession | undefined> {
    if (!this.agents.has(agentId)) return undefined;
    const identity = panelIdentity(agentId, recordId), key = sessionIdentityKey(identity);
    if (!this.known.has(key)) this.invalidatePanel(agentId, recordId);
    return await this.refreshIdentityKey(key);
  }

  forget(entry: IndexedSession): void {
    if (!this.agents.has(entry.agentId)) return;
    this.bumpAgent(entry.agentId); this.unregister(entry.identityKey);
  }

  forgetPanel(agentId: string, recordId: string): void {
    if (!this.agents.has(agentId)) return;
    this.bumpAgent(agentId); this.unregister(sessionIdentityKey(panelIdentity(agentId, recordId)));
  }

  clear(): void {
    this.globalEpoch++; this.entries.clear(); this.known.clear(); this.byRecord.clear(); this.byAgent.clear();
    this.dirty.clear(); this.failed.clear(); this.built.clear();
  }
}
