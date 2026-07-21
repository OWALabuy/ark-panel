import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { assertWithin, atomicWrite } from "./atomic.js";

const MAX_CANDIDATE_BYTES = 256 * 1024;
export interface MemoryCandidate {
  version: 1; batchId: string; agentId: string; recordId: string; sourceKind: "active" | "reset" | "panel";
  sourceRevision: string; previousCheckpointEntryId?: string; fromEntryId: string; throughEntryId: string;
  contentHash: string; content: string; createdAt: string;
}
export interface MemoryLedgerEntry {
  batchId: string; agentId: string; recordId: string; sourceKind: MemoryCandidate["sourceKind"];
  sourceRevision: string; fromEntryId: string; throughEntryId: string; contentHash: string;
  targetPath: string; createdAt: string; confirmedAt: string; status: "confirmed";
}
interface MemoryRecordState { version: 1; recordId: string; checkpointEntryId?: string; batches: MemoryLedgerEntry[] }

const locks = new Map<string, Promise<void>>();
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function recordKey(recordId: string): string { return digest(recordId); }
function validBatch(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current); locks.set(key, queued); await previous;
  try { return await operation(); } finally { release(); if (locks.get(key) === queued) locks.delete(key); }
}

async function safeDirectory(path: string): Promise<void> {
  const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MEMORY_STORAGE_UNSAFE");
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

  private async state(recordId: string): Promise<MemoryRecordState> {
    await this.ensure(); const path = this.statePath(recordId);
    try {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_STORAGE_UNSAFE");
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<MemoryRecordState>;
      if (value.version !== 1 || value.recordId !== recordId || !Array.isArray(value.batches)) throw new Error("MEMORY_STATE_CORRUPT");
      return value as MemoryRecordState;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, recordId, batches: [] }; throw error; }
  }

  async checkpoint(recordId: string): Promise<string | undefined> { return (await this.state(recordId)).checkpointEntryId; }

  async createCandidate(input: Omit<MemoryCandidate, "version" | "batchId" | "contentHash" | "createdAt" | "previousCheckpointEntryId">): Promise<MemoryCandidate> {
    return await withLock(input.recordId, async () => {
      const content = input.content.trim(); if (!content || Buffer.byteLength(content, "utf8") > MAX_CANDIDATE_BYTES) throw new Error("MEMORY_CANDIDATE_INVALID");
      await this.ensure(); const state = await this.state(input.recordId), candidate: MemoryCandidate = { version: 1, batchId: randomUUID(), ...input,
        ...(state.checkpointEntryId ? { previousCheckpointEntryId: state.checkpointEntryId } : {}), contentHash: digest(content), content, createdAt: new Date().toISOString() };
      const path = this.candidatePath(candidate.batchId), handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(JSON.stringify(candidate, null, 2) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
      const directory = await open(this.root("candidates"), "r"); try { await directory.sync(); } finally { await directory.close(); }
      return candidate;
    });
  }

  async loadCandidate(batchId: string): Promise<MemoryCandidate> {
    await this.ensure(); const path = this.candidatePath(batchId), stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("MEMORY_CANDIDATE_NOT_FOUND"); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CANDIDATE_BYTES * 2) throw new Error("MEMORY_STORAGE_UNSAFE");
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<MemoryCandidate>;
    if (value.version !== 1 || value.batchId !== batchId || typeof value.recordId !== "string" || typeof value.agentId !== "string" ||
      !["active", "reset", "panel"].includes(value.sourceKind ?? "") || typeof value.content !== "string" || digest(value.content) !== value.contentHash ||
      typeof value.fromEntryId !== "string" || typeof value.throughEntryId !== "string" || typeof value.sourceRevision !== "string" || typeof value.createdAt !== "string") throw new Error("MEMORY_CANDIDATE_CORRUPT");
    return value as MemoryCandidate;
  }

  async confirm(batchId: string, expectedHash: string, workspaceRoot: string): Promise<MemoryLedgerEntry> {
    const candidate = await this.loadCandidate(batchId); if (candidate.contentHash !== expectedHash) throw new Error("MEMORY_CANDIDATE_HASH_MISMATCH");
    return await withLock(candidate.recordId, async () => {
      const state = await this.state(candidate.recordId), confirmed = state.batches.find(batch => batch.batchId === batchId); if (confirmed) return confirmed;
      if (state.checkpointEntryId !== candidate.previousCheckpointEntryId) throw new Error("MEMORY_CANDIDATE_STALE");
      const configured = resolve(workspaceRoot), workspaceStat = await lstat(configured); if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error("MEMORY_WORKSPACE_UNSAFE");
      const workspace = await realpath(configured), memoryRoot = assertWithin(workspace, join(workspace, "memory"));
      await mkdir(memoryRoot, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }); await safeDirectory(memoryRoot);
      const day = new Date().toISOString().slice(0, 10), targetPath = `memory/${day}-ark-panel-${batchId}.md`, target = assertWithin(workspace, join(workspace, targetPath));
      try { const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); try { await handle.writeFile(candidate.content + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); } }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest((await readFile(target, "utf8")).trimEnd()) !== candidate.contentHash) throw new Error("MEMORY_TARGET_CONFLICT");
      }
      const directory = await open(memoryRoot, "r"); try { await directory.sync(); } finally { await directory.close(); }
      const ledger: MemoryLedgerEntry = { batchId, agentId: candidate.agentId, recordId: candidate.recordId, sourceKind: candidate.sourceKind,
        sourceRevision: candidate.sourceRevision, fromEntryId: candidate.fromEntryId, throughEntryId: candidate.throughEntryId,
        contentHash: candidate.contentHash, targetPath, createdAt: candidate.createdAt, confirmedAt: new Date().toISOString(), status: "confirmed" };
      await atomicWrite(this.statePath(candidate.recordId), JSON.stringify({ version: 1, recordId: candidate.recordId, checkpointEntryId: candidate.throughEntryId, batches: [...state.batches, ledger] } satisfies MemoryRecordState, null, 2) + "\n");
      return ledger;
    });
  }

  async ledgers(): Promise<MemoryLedgerEntry[]> {
    await this.ensure(); const output: MemoryLedgerEntry[] = [];
    for (const name of await readdir(this.root("state"))) {
      if (!name.endsWith(".json") || basename(name) !== name) continue; const path = assertWithin(this.root("state"), join(this.root("state"), name)), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_STORAGE_UNSAFE");
      const raw = JSON.parse(await readFile(path, "utf8")) as MemoryRecordState;
      if (raw.version !== 1 || typeof raw.recordId !== "string" || recordKey(raw.recordId) + ".json" !== name || !Array.isArray(raw.batches)) throw new Error("MEMORY_STATE_CORRUPT");
      output.push(...raw.batches);
    }
    return output;
  }
}
