import { mkdir, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, assertWithin } from "../storage/atomic.js";

export type PanelRunStatus = "accepted" | "running" | "materializing" | "committing" | "committed" | "aborting" | "completed" | "failed" | "aborted";
export const terminalRunStatuses: ReadonlySet<PanelRunStatus> = new Set(["completed", "failed", "aborted"]);

export interface PanelRunRecord {
  version: 1;
  runId: string;
  recordId: string;
  requestHash: string;
  sequence: number;
  status: PanelRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  revision?: string;
  error?: { code: string; message: string };
  runtimeAgentId?: string;
  temporarySessionId?: string;
  temporarySessionKey?: string;
  temporaryTranscriptPath?: string;
  gatewayRunId?: string;
  previousEntryCount?: number;
  baseRevision?: string;
  baseParentEntryId?: string | null;
  message?: string;
  attachmentIds?: string[];
  requestOutputs?: boolean;
  expectedRevision?: string;
  plannedUserEntryId?: string;
  stagedEntries?: unknown[];
  cleanupPending?: boolean;
}

export interface PublicRunTool { callId: string; name: string; phase: "started" | "completed" | "failed"; args?: unknown }
export interface PublicRunStream { revision: number; state: "connecting" | "streaming" | "degraded"; text: string; tools: PublicRunTool[] }
export interface PublicPanelRun { runId: string; recordId: string; status: PanelRunStatus; sequence: number; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; revision?: string; error?: { code: string; message: string }; canAbort: boolean; stream?: PublicRunStream }

export interface PanelRunStoreInstrumentation {
  onDirectoryScan?(): void;
  onRecordRead?(runId: string): void;
  beforeRecordRead?(runId: string): Promise<void>;
}

export type PanelRunStoreWriter = (path: string, data: string) => Promise<void>;

interface ActiveRunIndex {
  byRecordId: Map<string, Set<string>>;
  recordIdByRunId: Map<string, string>;
}
interface ActiveIndexBuild { generation: number; promise: Promise<PanelRunRecord[]> }
type ActiveRunRecord = Pick<PanelRunRecord, "runId" | "recordId" | "status">;

function validate(value: unknown, expectedRunId?: string): PanelRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run record 格式无效");
  const item = value as Partial<PanelRunRecord>;
  if (item.version !== 1 || typeof item.runId !== "string" || (expectedRunId && item.runId !== expectedRunId) ||
      typeof item.recordId !== "string" || typeof item.requestHash !== "string" || typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string" || !Number.isInteger(item.sequence) || typeof item.status !== "string" || !["accepted", "running", "materializing", "committing", "committed", "aborting", "completed", "failed", "aborted"].includes(item.status)) {
    throw new Error("run record 格式无效");
  }
  if (item.requestOutputs !== undefined && typeof item.requestOutputs !== "boolean") throw new Error("run record 格式无效");
  return item as PanelRunRecord;
}

export class PanelRunStore {
  private readonly root: string;
  private activeIndex: ActiveRunIndex | undefined;
  private activeIndexBuild: ActiveIndexBuild | undefined;
  private activeIndexGeneration = 0;
  constructor(dataRoot: string, private readonly instrumentation: PanelRunStoreInstrumentation = {},
    private readonly writeRunRecord: PanelRunStoreWriter = atomicWrite) {
    this.root = assertWithin(dataRoot, join(dataRoot, "runs"));
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("run store 根目录不安全");
  }
  private path(runId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("RUN_ID_INVALID");
    return assertWithin(this.root, join(this.root, `${runId}.json`));
  }
  async get(runId: string): Promise<PanelRunRecord | undefined> {
    try {
      const path = this.path(runId); this.instrumentation.onRecordRead?.(runId);
      const beforeRead = this.instrumentation.beforeRecordRead?.(runId); if (beforeRead) await beforeRead;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("run record 文件不安全");
      return validate(JSON.parse(await readFile(path, "utf8")), runId);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async put(record: PanelRunRecord): Promise<void> {
    await this.initialize();
    const validated = validate(record, record.runId);
    const indexed = { runId: validated.runId, recordId: validated.recordId, status: validated.status };
    try { await this.writeRunRecord(this.path(record.runId), JSON.stringify(validated, null, 2) + "\n"); }
    catch (error) {
      // atomicWrite may reject after rename if the parent-directory fsync fails. The new bytes can
      // therefore already be visible even though durability is unknown; discard all derived state
      // and let the next lookup rebuild from whichever authoritative run files are observable.
      this.invalidateActiveIndex(); throw error;
    }
    // The durable run file is authoritative. Never publish an accepted state or remove a terminal
    // state from the derived index until the atomic write and directory fsync have both succeeded.
    this.activeIndexGeneration++;
    if (this.activeIndex) this.applyToActiveIndex(indexed);
  }
  async list(): Promise<PanelRunRecord[]> {
    await this.initialize();
    if (!this.activeIndex) {
      const rebuilt = await this.ensureActiveIndex();
      if (rebuilt !== undefined) return [...rebuilt];
    }
    const generation = this.activeIndexGeneration, result = await this.scanRecords();
    // A concurrent successful put already applied its exact state to the index. Do not replace
    // that state with a scan that may have started before the write committed.
    if (generation === this.activeIndexGeneration) this.activeIndex = this.buildActiveIndex(result);
    return result;
  }

  async activeForRecord(recordId: string): Promise<PanelRunRecord | undefined> {
    await this.initialize();
    while (true) {
      await this.ensureActiveIndex(); const generation = this.activeIndexGeneration;
      const runId = this.activeIndex?.byRecordId.get(recordId)?.values().next().value;
      if (!runId) return undefined;
      const record = await this.get(runId);
      if (generation !== this.activeIndexGeneration || !this.activeIndex) continue;
      if (record && record.recordId === recordId && !terminalRunStatuses.has(record.status)) return record;
      // A missing or externally replaced run file cannot remain a false active lock. Normal
      // mutations already update the index in put(); this only repairs an unexpected stale entry.
      if (record) this.applyToActiveIndex(record); else this.removeFromActiveIndex(runId);
      this.activeIndexGeneration++;
    }
  }

  async activeRecordIds(): Promise<Set<string>> {
    await this.initialize(); await this.ensureActiveIndex();
    return new Set(this.activeIndex?.byRecordId.keys() ?? []);
  }

  private async scanRecords(): Promise<PanelRunRecord[]> {
    this.instrumentation.onDirectoryScan?.(); const result: PanelRunRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".json")) continue;
      const runId = name.slice(0, -5); result.push((await this.get(runId))!);
    }
    return result;
  }

  private async ensureActiveIndex(): Promise<PanelRunRecord[] | undefined> {
    while (!this.activeIndex) {
      const generation = this.activeIndexGeneration;
      let build = this.activeIndexBuild;
      if (!build || build.generation !== generation) {
        const promise = (async () => {
          await this.initialize();
          const records = await this.scanRecords();
          if (generation === this.activeIndexGeneration) this.activeIndex = this.buildActiveIndex(records);
          return records;
        })();
        build = { generation, promise }; this.activeIndexBuild = build;
        void promise.then(
          () => { if (this.activeIndexBuild === build) this.activeIndexBuild = undefined; },
          () => { if (this.activeIndexBuild === build) this.activeIndexBuild = undefined; }
        );
      }
      try {
        const records = await build.promise;
        if (build.generation === this.activeIndexGeneration && this.activeIndex) return records;
      } catch (error) {
        if (build.generation === this.activeIndexGeneration) throw error;
      }
    }
    return undefined;
  }

  private invalidateActiveIndex(): void {
    this.activeIndex = undefined; this.activeIndexGeneration++; this.activeIndexBuild = undefined;
  }

  private buildActiveIndex(records: readonly PanelRunRecord[]): ActiveRunIndex {
    const index: ActiveRunIndex = { byRecordId: new Map(), recordIdByRunId: new Map() };
    for (const record of records) this.applyToIndex(index, record);
    return index;
  }

  private applyToActiveIndex(record: ActiveRunRecord): void {
    if (this.activeIndex) this.applyToIndex(this.activeIndex, record);
  }

  private applyToIndex(index: ActiveRunIndex, record: ActiveRunRecord): void {
    const previousRecordId = index.recordIdByRunId.get(record.runId);
    if (previousRecordId) {
      const previous = index.byRecordId.get(previousRecordId); previous?.delete(record.runId);
      if (!previous?.size) index.byRecordId.delete(previousRecordId);
      index.recordIdByRunId.delete(record.runId);
    }
    if (terminalRunStatuses.has(record.status)) return;
    const active = index.byRecordId.get(record.recordId) ?? new Set<string>(); active.add(record.runId);
    index.byRecordId.set(record.recordId, active); index.recordIdByRunId.set(record.runId, record.recordId);
  }

  private removeFromActiveIndex(runId: string): void {
    if (!this.activeIndex) return;
    const recordId = this.activeIndex.recordIdByRunId.get(runId); if (!recordId) return;
    const active = this.activeIndex.byRecordId.get(recordId); active?.delete(runId);
    if (!active?.size) this.activeIndex.byRecordId.delete(recordId);
    this.activeIndex.recordIdByRunId.delete(runId);
  }
}

// Terminal records are intentionally retained indefinitely: their request hashes are the
// durable idempotency authority. A future bounded retention policy must explicitly preserve that guarantee.

export function publicRun(record: PanelRunRecord): PublicPanelRun {
  return { runId: record.runId, recordId: record.recordId, status: record.status, sequence: record.sequence,
    createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}), ...(record.revision ? { revision: record.revision } : {}),
    ...(record.error ? { error: record.error } : {}), canAbort: ["accepted", "running", "materializing"].includes(record.status) };
}
