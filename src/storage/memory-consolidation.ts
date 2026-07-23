import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertWithin, atomicWrite } from "./atomic.js";
import { readMemoryFile } from "./memory-files.js";

const MAX_CANDIDATE_BYTES = 256 * 1024;
const MAX_BASE_BYTES = 1024 * 1024;
export interface MemoryCandidate {
  version: 2; batchId: string; agentId: string; recordId: string; sourceKind: "active" | "reset" | "panel";
  sourceRevision: string; previousCheckpointEntryId?: string; baseContentHash?: string;
  fromEntryId: string; throughEntryId: string; targetPath: string;
  contentHash: string; content: string; createdAt: string;
}
export interface MemoryLedgerEntry {
  batchId: string; agentId: string; recordId: string; sourceKind: MemoryCandidate["sourceKind"];
  sourceRevision: string; fromEntryId: string; throughEntryId: string; baseContentHash?: string; contentHash: string;
  targetPath: string; createdAt: string; confirmedAt: string; status: "confirmed";
}
export interface MemoryConsolidationContext {
  checkpointEntryId?: string; baseContent?: string; baseContentHash?: string; targetPath: string;
}
interface LegacyMemoryRecordState { version: 1; recordId: string; checkpointEntryId?: string; batches: MemoryLedgerEntry[] }
interface MemoryRecordState {
  version: 2; recordId: string; checkpointEntryId?: string;
  current?: { targetPath: string; contentHash: string };
  legacyTargets?: Array<{ targetPath: string; contentHash: string }>;
  batches: MemoryLedgerEntry[];
}
type StoredMemoryRecordState = LegacyMemoryRecordState | MemoryRecordState;

const locks = new Map<string, Promise<void>>();
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function recordKey(recordId: string): string { return digest(recordId); }
function rollingPath(recordId: string): string { return `memory/ark-panel/${recordKey(recordId)}.md`; }
function validBatch(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function normalizedContent(value: string): string { return value.trim(); }

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current); locks.set(key, queued); await previous;
  try { return await operation(); } finally { release(); if (locks.get(key) === queued) locks.delete(key); }
}

async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MEMORY_STORAGE_UNSAFE");
}
function validLedger(value: unknown): value is MemoryLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<MemoryLedgerEntry>;
  return typeof item.batchId === "string" && validBatch(item.batchId) && typeof item.agentId === "string" && typeof item.recordId === "string" &&
    ["active", "reset", "panel"].includes(item.sourceKind ?? "") && typeof item.sourceRevision === "string" &&
    typeof item.fromEntryId === "string" && typeof item.throughEntryId === "string" && typeof item.contentHash === "string" &&
    typeof item.targetPath === "string" && typeof item.createdAt === "string" && typeof item.confirmedAt === "string" && item.status === "confirmed" &&
    (item.baseContentHash === undefined || typeof item.baseContentHash === "string");
}

export class MemoryConsolidationStore {
  constructor(private readonly dataRoot: string) { this.dataRoot = resolve(dataRoot); }

  private root(name: "candidates" | "state"): string { return assertWithin(this.dataRoot, join(this.dataRoot, "memory", name)); }
  private async ensure(): Promise<void> {
    const root = assertWithin(this.dataRoot, join(this.dataRoot, "memory")); await mkdir(root, { recursive: true, mode: 0o700 }); await safeDirectory(root);
    for (const name of ["candidates", "state"] as const) { const path = this.root(name); await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await safeDirectory(path); }
  }
  private candidatePath(batchId: string): string { if (!validBatch(batchId)) throw new Error("MEMORY_BATCH_INVALID"); return assertWithin(this.root("candidates"), join(this.root("candidates"), `${batchId}.json`)); }
  private statePath(recordId: string): string { return assertWithin(this.root("state"), join(this.root("state"), `${recordKey(recordId)}.json`)); }

  private async state(recordId: string): Promise<StoredMemoryRecordState> {
    await this.ensure(); const path = this.statePath(recordId);
    try {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_STORAGE_UNSAFE");
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<StoredMemoryRecordState>;
      if (![1, 2].includes(value.version ?? 0) || value.recordId !== recordId || !Array.isArray(value.batches) || !value.batches.every(validLedger)) throw new Error("MEMORY_STATE_CORRUPT");
      if (value.version === 1 && value.checkpointEntryId && value.batches.length === 0) throw new Error("MEMORY_STATE_CORRUPT");
      if (value.version === 2) {
        const current = value.current;
        if (current && (typeof current.targetPath !== "string" || typeof current.contentHash !== "string")) throw new Error("MEMORY_STATE_CORRUPT");
        if (Boolean(value.checkpointEntryId) !== Boolean(current)) throw new Error("MEMORY_STATE_CORRUPT");
        if (value.legacyTargets && (!Array.isArray(value.legacyTargets) || value.legacyTargets.some(item => !item || typeof item.targetPath !== "string" || typeof item.contentHash !== "string"))) throw new Error("MEMORY_STATE_CORRUPT");
      }
      return value as StoredMemoryRecordState;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, recordId, batches: [] }; throw error; }
  }

  private async readVerified(workspaceRoot: string, targetPath: string, expectedHash: string): Promise<string> {
    const content = normalizedContent((await readMemoryFile(workspaceRoot, targetPath)).content);
    if (digest(content) !== expectedHash) throw new Error("MEMORY_TARGET_CONFLICT");
    return content;
  }
  private async contextFromState(recordId: string, workspaceRoot: string, state: StoredMemoryRecordState): Promise<MemoryConsolidationContext> {
    const targetPath = rollingPath(recordId);
    if (state.version === 2 && state.current) {
      if (state.current.targetPath !== targetPath) throw new Error("MEMORY_STATE_CORRUPT");
      const baseContent = await this.readVerified(workspaceRoot, state.current.targetPath, state.current.contentHash);
      return { ...(state.checkpointEntryId ? { checkpointEntryId: state.checkpointEntryId } : {}), baseContent, baseContentHash: state.current.contentHash, targetPath };
    }
    if (state.version === 1 && state.batches.length) {
      const seen = new Set<string>(), parts: string[] = [];
      for (const batch of state.batches) {
        if (seen.has(batch.targetPath)) continue; seen.add(batch.targetPath);
        parts.push(await this.readVerified(workspaceRoot, batch.targetPath, batch.contentHash));
      }
      const baseContent = parts.filter(Boolean).join("\n\n").trim();
      if (!baseContent || Buffer.byteLength(baseContent, "utf8") > MAX_BASE_BYTES) throw new Error("MEMORY_BASE_INVALID");
      return { ...(state.checkpointEntryId ? { checkpointEntryId: state.checkpointEntryId } : {}), baseContent, baseContentHash: digest(baseContent), targetPath };
    }
    return { ...(state.checkpointEntryId ? { checkpointEntryId: state.checkpointEntryId } : {}), targetPath };
  }

  async context(recordId: string, workspaceRoot: string): Promise<MemoryConsolidationContext> {
    return await withLock(recordId, async () => await this.contextFromState(recordId, workspaceRoot, await this.state(recordId)));
  }
  async checkpoint(recordId: string): Promise<string | undefined> { return (await this.state(recordId)).checkpointEntryId; }

  async createCandidate(input: Omit<MemoryCandidate, "version" | "batchId" | "contentHash" | "createdAt" | "targetPath">): Promise<MemoryCandidate> {
    return await withLock(input.recordId, async () => {
      const content = normalizedContent(input.content); if (!content || Buffer.byteLength(content, "utf8") > MAX_CANDIDATE_BYTES) throw new Error("MEMORY_CANDIDATE_INVALID");
      const state = await this.state(input.recordId);
      if (state.checkpointEntryId !== input.previousCheckpointEntryId) throw new Error("MEMORY_CANDIDATE_STALE");
      await this.ensure(); const candidate: MemoryCandidate = { version: 2, batchId: randomUUID(), ...input, targetPath: rollingPath(input.recordId),
        contentHash: digest(content), content, createdAt: new Date().toISOString() };
      const path = this.candidatePath(candidate.batchId), handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(candidate, null, 2) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(this.root("candidates"), "r"); try { await directory.sync(); } finally { await directory.close(); }
      return candidate;
    });
  }

  async loadCandidate(batchId: string): Promise<MemoryCandidate> {
    await this.ensure(); const path = this.candidatePath(batchId), stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("MEMORY_CANDIDATE_NOT_FOUND"); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CANDIDATE_BYTES * 2) throw new Error("MEMORY_STORAGE_UNSAFE");
    const value = JSON.parse(await readFile(path, "utf8")) as Omit<Partial<MemoryCandidate>, "version"> & { version?: number };
    if (value.version === 1) throw new Error("MEMORY_CANDIDATE_VERSION_UNSUPPORTED");
    if (value.version !== 2 || value.batchId !== batchId || typeof value.recordId !== "string" || typeof value.agentId !== "string" ||
      !["active", "reset", "panel"].includes(value.sourceKind ?? "") || typeof value.content !== "string" || digest(value.content) !== value.contentHash ||
      typeof value.fromEntryId !== "string" || typeof value.throughEntryId !== "string" || typeof value.sourceRevision !== "string" ||
      typeof value.targetPath !== "string" || value.targetPath !== rollingPath(value.recordId) ||
      (value.previousCheckpointEntryId !== undefined && typeof value.previousCheckpointEntryId !== "string") ||
      (value.baseContentHash !== undefined && typeof value.baseContentHash !== "string") || typeof value.createdAt !== "string") throw new Error("MEMORY_CANDIDATE_CORRUPT");
    return value as MemoryCandidate;
  }

  private async ensureRollingDirectory(workspaceRoot: string): Promise<string> {
    const configured = resolve(workspaceRoot), workspaceStat = await lstat(configured); if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error("MEMORY_WORKSPACE_UNSAFE");
    const workspace = await realpath(configured), memoryRoot = assertWithin(workspace, join(workspace, "memory"));
    await mkdir(memoryRoot, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await safeDirectory(memoryRoot);
    const rollingRoot = assertWithin(workspace, join(memoryRoot, "ark-panel"));
    await mkdir(rollingRoot, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await safeDirectory(rollingRoot);
    return workspace;
  }
  private async cleanupLegacy(workspace: string, targets: readonly { targetPath: string; contentHash: string }[], currentPath: string): Promise<boolean> {
    let complete = true;
    for (const legacy of targets) {
      if (legacy.targetPath === currentPath) continue;
      try {
        await this.readVerified(workspace, legacy.targetPath, legacy.contentHash);
        const target = assertWithin(workspace, join(workspace, ...legacy.targetPath.split("/"))), stat = await lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_STORAGE_UNSAFE");
        await unlink(target); const directory = await open(dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if ((error as Error).message === "MEMORY_FILE_NOT_FOUND" || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        complete = false;
      }
    }
    return complete;
  }

  async confirm(batchId: string, expectedHash: string, workspaceRoot: string): Promise<MemoryLedgerEntry> {
    const candidate = await this.loadCandidate(batchId); if (candidate.contentHash !== expectedHash) throw new Error("MEMORY_CANDIDATE_HASH_MISMATCH");
    return await withLock(candidate.recordId, async () => {
      const state = await this.state(candidate.recordId), confirmed = state.batches.find(batch => batch.batchId === batchId); if (confirmed) return confirmed;
      if (state.checkpointEntryId !== candidate.previousCheckpointEntryId) throw new Error("MEMORY_CANDIDATE_STALE");
      const workspace = await this.ensureRollingDirectory(workspaceRoot), target = assertWithin(workspace, join(workspace, ...candidate.targetPath.split("/")));
      let targetHash: string | undefined;
      try {
        targetHash = digest(normalizedContent((await readMemoryFile(workspace, candidate.targetPath)).content));
      } catch (error) {
        if ((error as Error).message !== "MEMORY_FILE_NOT_FOUND") throw error;
      }
      const alreadyWritten = targetHash === candidate.contentHash;
      const context = alreadyWritten && state.version === 2
        ? { ...(state.checkpointEntryId ? { checkpointEntryId: state.checkpointEntryId } : {}), ...(state.current ? { baseContentHash: state.current.contentHash } : {}), targetPath: rollingPath(candidate.recordId) }
        : await this.contextFromState(candidate.recordId, workspaceRoot, state);
      if (context.baseContentHash !== candidate.baseContentHash || context.targetPath !== candidate.targetPath) throw new Error("MEMORY_CANDIDATE_STALE");
      if (!alreadyWritten && (state.version === 2 && state.current ? targetHash !== context.baseContentHash : targetHash !== undefined)) throw new Error("MEMORY_TARGET_CONFLICT");
      if (!alreadyWritten) await atomicWrite(target, candidate.content + "\n");
      const legacyTargets = state.version === 1 ? state.batches.map(batch => ({ targetPath: batch.targetPath, contentHash: batch.contentHash })) : state.legacyTargets;
      const ledger: MemoryLedgerEntry = { batchId, agentId: candidate.agentId, recordId: candidate.recordId, sourceKind: candidate.sourceKind,
        sourceRevision: candidate.sourceRevision, fromEntryId: candidate.fromEntryId, throughEntryId: candidate.throughEntryId,
        ...(candidate.baseContentHash ? { baseContentHash: candidate.baseContentHash } : {}), contentHash: candidate.contentHash,
        targetPath: candidate.targetPath, createdAt: candidate.createdAt, confirmedAt: new Date().toISOString(), status: "confirmed" };
      const next: MemoryRecordState = { version: 2, recordId: candidate.recordId, checkpointEntryId: candidate.throughEntryId,
        current: { targetPath: candidate.targetPath, contentHash: candidate.contentHash },
        ...(legacyTargets?.length ? { legacyTargets } : {}), batches: [...state.batches, ledger] };
      await atomicWrite(this.statePath(candidate.recordId), JSON.stringify(next, null, 2) + "\n");
      if (legacyTargets?.length && await this.cleanupLegacy(workspace, legacyTargets, candidate.targetPath)) {
        await atomicWrite(this.statePath(candidate.recordId), JSON.stringify({ ...next, legacyTargets: undefined }, null, 2) + "\n").catch(() => {});
      }
      return ledger;
    });
  }

  async ledgers(): Promise<MemoryLedgerEntry[]> {
    await this.ensure(); const output: MemoryLedgerEntry[] = [];
    for (const name of await readdir(this.root("state"))) {
      if (!name.endsWith(".json") || basename(name) !== name) continue; const path = assertWithin(this.root("state"), join(this.root("state"), name)), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_STORAGE_UNSAFE");
      const raw = JSON.parse(await readFile(path, "utf8")) as Partial<StoredMemoryRecordState>;
      if (![1, 2].includes(raw.version ?? 0) || typeof raw.recordId !== "string" || recordKey(raw.recordId) + ".json" !== name || !Array.isArray(raw.batches) || !raw.batches.every(validLedger)) throw new Error("MEMORY_STATE_CORRUPT");
      output.push(...raw.batches);
    }
    return output;
  }
}
