import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { atomicWrite, assertWithin } from "../storage/atomic.js";
import { compatibleGenerationRequestFingerprintMatcherVersion, currentGenerationRequestFingerprintMatcherVersion,
  type GenerationRequestFingerprintMatcherVersion } from "../domain/generation-request.js";
import { publicRunErrorMessage, retainedRunErrorCode } from "./run-errors.js";

export type PanelRunStatus = "accepted" | "running" | "materializing" | "committing" | "committed" | "aborting" | "completed" | "failed" | "aborted";
export type TerminalPanelRunStatus = Extract<PanelRunStatus, "completed" | "failed" | "aborted">;
export const terminalRunStatuses: ReadonlySet<PanelRunStatus> = new Set(["completed", "failed", "aborted"]);

export interface PanelRunRecord {
  version: 1;
  runId: string;
  recordId: string;
  requestHash: string;
  fingerprintMatcherVersion?: GenerationRequestFingerprintMatcherVersion;
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

export interface PanelRunTombstone {
  version: 1;
  kind: "terminal-run-tombstone";
  runId: string;
  recordId: string;
  requestHash: string;
  fingerprintMatcherVersion: GenerationRequestFingerprintMatcherVersion;
  sequence: number;
  status: TerminalPanelRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt: string;
  retiredAt: string;
  revision?: string;
  failureCode?: string;
}
export type StoredPanelRun = PanelRunRecord | PanelRunTombstone;
export interface RunRetentionOptions { retentionDays: number; now?: Date; backupConfirmed?: boolean }
export interface RunRetentionResult { scanned: number; retired: number; retained: number }

export interface PublicRunTool { callId: string; name: string; phase: "started" | "completed" | "failed"; args?: unknown }
export interface PublicRunTextItem { type: "text"; sequence: number; text: string }
export interface PublicRunToolItem extends PublicRunTool { type: "tool"; sequence: number; updatedSequence: number }
export type PublicRunStreamItem = PublicRunTextItem | PublicRunToolItem;
export interface PublicRunStream {
  revision: number;
  state: "connecting" | "streaming" | "degraded";
  text: string;
  tools: PublicRunTool[];
  items: PublicRunStreamItem[];
}
export interface PublicPanelRun { runId: string; recordId: string; status: PanelRunStatus; sequence: number; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; revision?: string; error?: { code: string; message: string }; canAbort: boolean; stream?: PublicRunStream }

interface PanelRunStoreTestHooks {
  onDirectoryScan?(): void;
  onRecordRead?(runId: string): void;
  onTombstoneShardParse?(shard: string): void;
  listRunFileNames?(): Promise<string[]>;
  beforeRecordRead?(runId: string): Promise<void>;
  writeRunRecord?(path: string, data: string): Promise<void>;
  writeTombstoneShard?(path: string, data: string): Promise<void>;
  writeSchemaBarrier?(path: string, data: string): Promise<void>;
  unlinkRunRecord?(path: string): Promise<void>;
  syncRunsDirectory?(path: string): Promise<void>;
  maxTombstoneShardBytes?: number;
  maxTombstoneTotalBytes?: number;
  maxRetentionScanned?: number;
  maxRetentionRetired?: number;
  maxRetentionElapsedMs?: number;
  monotonicNow?(): number;
}

interface ActiveRunIndex {
  byRecordId: Map<string, Set<string>>;
  recordIdByRunId: Map<string, string>;
}
interface ActiveIndexBuild { generation: number; promise: Promise<PanelRunRecord[]> }
type ActiveRunRecord = Pick<PanelRunRecord, "runId" | "recordId" | "status">;

interface TombstoneShard {
  version: 1;
  kind: "panel-run-tombstone-shard";
  shard: string;
  tombstones: Record<string, PanelRunTombstone>;
}
interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number; uid: number; mode: number }
interface DirectoryIdentity { dev: number; ino: number; uid: number; mode: number }

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;
const SCHEMA_BARRIER_NAME = ".tombstone-schema-v1.json";
const SHARD_KIND = "panel-run-tombstone-shard";
const TOMBSTONE_KIND = "terminal-run-tombstone";
const MAX_TOMBSTONES_PER_SHARD = 16_384;
const MAX_TOMBSTONE_SHARD_BYTES = 8 * 1024 * 1024;
const MAX_TOMBSTONE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RETENTION_SCANNED = 512;
const MAX_RETENTION_RETIRED = 128;
const MAX_RETENTION_ELAPSED_MS = 2_000;
const MAX_SHARD_CACHE_ENTRIES = 8;
const REQUEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOMBSTONE_KEYS = new Set(["version", "kind", "runId", "recordId", "requestHash", "fingerprintMatcherVersion", "sequence",
  "status", "createdAt", "updatedAt", "startedAt", "finishedAt", "retiredAt", "revision", "failureCode"]);
const SHARD_KEYS = new Set(["version", "kind", "shard", "tombstones"]);
const BARRIER_KEYS = new Set(["version", "kind", "tombstoneSchemaVersion"]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink,
    uid: stat.uid, mode: stat.mode };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.nlink === right.nlink && left.uid === right.uid && left.mode === right.mode;
}

function privateOwner(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateOwner(stat) && (stat.mode & 0o077) === 0;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matcherVersion(value: unknown): value is GenerationRequestFingerprintMatcherVersion {
  return value === currentGenerationRequestFingerprintMatcherVersion || value === compatibleGenerationRequestFingerprintMatcherVersion;
}

function validateFull(value: unknown, expectedRunId?: string): PanelRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run record 格式无效");
  const item = value as Partial<PanelRunRecord>;
  if ((item as PanelRunRecord & { kind?: unknown }).kind !== undefined || item.version !== 1 || typeof item.runId !== "string" || (expectedRunId && item.runId !== expectedRunId) ||
      typeof item.recordId !== "string" || typeof item.requestHash !== "string" || typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string" || !Number.isInteger(item.sequence) || typeof item.status !== "string" || !["accepted", "running", "materializing", "committing", "committed", "aborting", "completed", "failed", "aborted"].includes(item.status)) {
    throw new Error("run record 格式无效");
  }
  if (item.requestOutputs !== undefined && typeof item.requestOutputs !== "boolean") throw new Error("run record 格式无效");
  if (item.fingerprintMatcherVersion !== undefined && !matcherVersion(item.fingerprintMatcherVersion)) throw new Error("run record 指纹版本无效");
  return item as PanelRunRecord;
}

function validateTombstone(value: unknown, expectedRunId?: string): PanelRunTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run tombstone 格式无效");
  const item = value as Record<string, unknown>;
  if (!hasOnlyKeys(item, TOMBSTONE_KEYS) || item.version !== 1 || item.kind !== TOMBSTONE_KIND ||
      typeof item.runId !== "string" || !RUN_ID_PATTERN.test(item.runId) || (expectedRunId && item.runId !== expectedRunId) ||
      typeof item.recordId !== "string" || !validOpaqueRecordId(item.recordId) || typeof item.requestHash !== "string" ||
      !REQUEST_HASH_PATTERN.test(item.requestHash) || !matcherVersion(item.fingerprintMatcherVersion) ||
      !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 || !["completed", "failed", "aborted"].includes(String(item.status)) ||
      typeof item.createdAt !== "string" || !isCanonicalInstant(item.createdAt) || typeof item.updatedAt !== "string" || !isCanonicalInstant(item.updatedAt) ||
      typeof item.finishedAt !== "string" || !isCanonicalInstant(item.finishedAt) || typeof item.retiredAt !== "string" || !isCanonicalInstant(item.retiredAt) ||
      (item.startedAt !== undefined && (typeof item.startedAt !== "string" || !isCanonicalInstant(item.startedAt))) ||
      (item.revision !== undefined && (item.status !== "completed" || typeof item.revision !== "string" || !validRevision(item.revision))) ||
      (item.failureCode !== undefined && (item.status !== "failed" || typeof item.failureCode !== "string" || retainedRunErrorCode(item.failureCode) !== item.failureCode))) {
    throw new Error("run tombstone 格式无效");
  }
  return item as unknown as PanelRunTombstone;
}

function validateShard(value: unknown, expectedShard: string): TombstoneShard {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run tombstone shard 格式无效");
  const item = value as Record<string, unknown>;
  if (!hasOnlyKeys(item, SHARD_KEYS) || item.version !== 1 || item.kind !== SHARD_KIND || item.shard !== expectedShard ||
      !item.tombstones || typeof item.tombstones !== "object" || Array.isArray(item.tombstones)) {
    throw new Error("run tombstone shard 格式无效");
  }
  const rawTombstones = item.tombstones as Record<string, unknown>, entries = Object.entries(rawTombstones);
  if (entries.length > MAX_TOMBSTONES_PER_SHARD) throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
  const tombstones: Record<string, PanelRunTombstone> = {};
  for (const [runId, raw] of entries) {
    if (shardForRun(runId) !== expectedShard) throw new Error("run tombstone shard 分片无效");
    tombstones[runId] = validateTombstone(raw, runId);
  }
  return { version: 1, kind: SHARD_KIND, shard: expectedShard, tombstones };
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validOpaqueRecordId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f/\\]/.test(value) && value !== "." && value !== "..";
}

function validRevision(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertRetirementFields(record: PanelRunRecord): void {
  if (!validOpaqueRecordId(record.recordId) || !REQUEST_HASH_PATTERN.test(record.requestHash) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 || !isCanonicalInstant(record.createdAt) ||
      !isCanonicalInstant(record.updatedAt) || !record.finishedAt || !isCanonicalInstant(record.finishedAt) ||
      (record.startedAt !== undefined && !isCanonicalInstant(record.startedAt)) ||
      (record.revision !== undefined && !validRevision(record.revision))) throw new Error("RUN_RECORD_NOT_RETIREABLE");
}

function shardForRun(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("RUN_ID_INVALID");
  return createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 2);
}

function retirementIdentityMatches(record: PanelRunRecord, tombstone: PanelRunTombstone): boolean {
  const version = record.fingerprintMatcherVersion ?? compatibleGenerationRequestFingerprintMatcherVersion;
  const failureCode = record.status === "failed" ? stableFailureCode(record.error?.code) : undefined;
  return record.runId === tombstone.runId && record.recordId === tombstone.recordId && record.requestHash === tombstone.requestHash &&
    version === tombstone.fingerprintMatcherVersion && record.sequence === tombstone.sequence && record.status === tombstone.status &&
    record.createdAt === tombstone.createdAt && record.updatedAt === tombstone.updatedAt && record.finishedAt === tombstone.finishedAt &&
    record.startedAt === tombstone.startedAt &&
    (record.status === "completed" ? record.revision : undefined) === tombstone.revision && failureCode === tombstone.failureCode;
}

function stableFailureCode(value: unknown): string {
  return typeof value === "string" ? retainedRunErrorCode(value) ?? "RUN_FAILED" : "RUN_FAILED";
}

function serializeShard(shard: TombstoneShard): string {
  const tombstones: Record<string, PanelRunTombstone> = {};
  for (const runId of Object.keys(shard.tombstones).sort()) tombstones[runId] = shard.tombstones[runId]!;
  return JSON.stringify({ version: 1, kind: SHARD_KIND, shard: shard.shard, tombstones }, null, 2) + "\n";
}

function toTombstone(record: PanelRunRecord, retiredAt: string): PanelRunTombstone {
  if (!terminalRunStatuses.has(record.status) || !record.finishedAt) throw new Error("RUN_NOT_RETIREABLE");
  assertRetirementFields(record);
  const status = record.status as TerminalPanelRunStatus;
  return { version: 1, kind: TOMBSTONE_KIND, runId: record.runId, recordId: record.recordId, requestHash: record.requestHash,
    fingerprintMatcherVersion: record.fingerprintMatcherVersion ?? compatibleGenerationRequestFingerprintMatcherVersion,
    sequence: record.sequence, status, createdAt: record.createdAt, updatedAt: record.updatedAt, finishedAt: record.finishedAt, retiredAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(status === "completed" && record.revision ? { revision: record.revision } : {}),
    ...(status === "failed" ? { failureCode: stableFailureCode(record.error?.code) } : {}) };
}

export function isPanelRunTombstone(record: StoredPanelRun): record is PanelRunTombstone {
  return "kind" in record && record.kind === TOMBSTONE_KIND;
}

export class PanelRunStore {
  #testHooks: PanelRunStoreTestHooks;
  private readonly root: string;
  private readonly tombstoneBaseRoot: string;
  private readonly tombstoneRoot: string;
  private readonly barrierPath: string;
  private activeIndex: ActiveRunIndex | undefined;
  private activeIndexBuild: ActiveIndexBuild | undefined;
  private activeIndexGeneration = 0;
  private readonly runTails = new Map<string, Promise<void>>();
  private readonly shardTails = new Map<string, Promise<void>>();
  private barrierTail: Promise<void> = Promise.resolve();
  private retentionTail: Promise<void> = Promise.resolve();
  private rootIdentity: DirectoryIdentity | undefined;
  private tombstoneBaseRootIdentity: DirectoryIdentity | undefined;
  private tombstoneRootIdentity: DirectoryIdentity | undefined;
  private fullRunIds: Set<string> | undefined;
  private retentionIterator: Iterator<string> | undefined;
  private readonly shardCache = new Map<string, { identity: FileIdentity; value: TombstoneShard }>();
  constructor(dataRoot: string);
  constructor(dataRoot: string, testHooks: PanelRunStoreTestHooks = {}) {
    this.#testHooks = testHooks;
    this.root = assertWithin(dataRoot, join(dataRoot, "runs"));
    this.tombstoneBaseRoot = assertWithin(dataRoot, join(dataRoot, "run-tombstones"));
    this.tombstoneRoot = assertWithin(this.tombstoneBaseRoot, join(this.tombstoneBaseRoot, "v1"));
    this.barrierPath = assertWithin(this.root, join(this.root, SCHEMA_BARRIER_NAME));
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.rootIdentity = await this.pinDirectory(this.root, this.rootIdentity, "run store 根目录");
    await mkdir(this.tombstoneBaseRoot, { recursive: true, mode: 0o700 });
    this.tombstoneBaseRootIdentity = await this.pinDirectory(this.tombstoneBaseRoot, this.tombstoneBaseRootIdentity, "run tombstone 根目录");
    await mkdir(this.tombstoneRoot, { recursive: true, mode: 0o700 });
    this.tombstoneRootIdentity = await this.pinDirectory(this.tombstoneRoot, this.tombstoneRootIdentity, "run tombstone schema 目录");
    const barrier = await this.readSchemaBarrier();
    if (!barrier && (await readdir(this.tombstoneRoot)).some(name => name.endsWith(".json"))) {
      throw new Error("RUN_TOMBSTONE_BARRIER_REQUIRED");
    }
  }
  private path(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("RUN_ID_INVALID");
    return assertWithin(this.root, join(this.root, `${runId}.json`));
  }
  private shardPath(shard: string): string {
    if (!SHARD_PATTERN.test(shard)) throw new Error("RUN_TOMBSTONE_SHARD_INVALID");
    return assertWithin(this.tombstoneRoot, join(this.tombstoneRoot, `${shard}.json`));
  }
  async get(runId: string): Promise<StoredPanelRun | undefined> {
    await this.initialize(); this.path(runId);
    return await this.withRunLock(runId, async () => await this.getUnlocked(runId));
  }
  async put(record: PanelRunRecord): Promise<void> {
    await this.initialize();
    const validated = validateFull(record, record.runId);
    await this.withRunLock(validated.runId, async () => {
      await this.assertPinnedRoots();
      if (await this.readTombstone(validated.runId)) throw new Error("RUN_TOMBSTONE_EXISTS");
      await this.assertPinnedRoots();
      const indexed = { runId: validated.runId, recordId: validated.recordId, status: validated.status };
      try { await (this.#testHooks.writeRunRecord ?? atomicWrite)(this.path(validated.runId), JSON.stringify(validated, null, 2) + "\n"); }
      catch (error) {
        this.invalidateActiveIndex(); throw error;
      }
      await this.assertPinnedRoots();
      this.fullRunIds?.add(validated.runId);
      this.activeIndexGeneration++;
      if (this.activeIndex) this.applyToActiveIndex(indexed);
    });
  }
  async listFullRunsForRecovery(): Promise<PanelRunRecord[]> {
    await this.initialize();
    if (!this.activeIndex) {
      const rebuilt = await this.ensureActiveIndex();
      if (rebuilt !== undefined) return [...rebuilt];
    }
    const generation = this.activeIndexGeneration, result = await this.scanFullRecords();
    if (generation === this.activeIndexGeneration) {
      this.activeIndex = this.buildActiveIndex(result); this.fullRunIds = new Set(result.map(record => record.runId));
      this.retentionIterator = undefined;
    }
    return result;
  }

  async list(): Promise<PanelRunRecord[]> { return await this.listFullRunsForRecovery(); }

  async activeForRecord(recordId: string): Promise<PanelRunRecord | undefined> {
    await this.initialize();
    while (true) {
      await this.ensureActiveIndex(); const generation = this.activeIndexGeneration;
      const runId = this.activeIndex?.byRecordId.get(recordId)?.values().next().value;
      if (!runId) return undefined;
      const record = await this.get(runId);
      if (generation !== this.activeIndexGeneration || !this.activeIndex) continue;
      if (record && !isPanelRunTombstone(record) && record.recordId === recordId && !terminalRunStatuses.has(record.status)) return record;
      if (record) this.applyToActiveIndex(record); else this.removeFromActiveIndex(runId);
      this.activeIndexGeneration++;
    }
  }

  async activeRecordIds(): Promise<Set<string>> {
    await this.initialize(); await this.ensureActiveIndex();
    return new Set(this.activeIndex?.byRecordId.keys() ?? []);
  }

  /** Replace eligible terminal full records with privacy-minimal, indefinitely retained shard entries.
   * The caller supplies the wall clock so deterministic maintenance and tests share one cutoff. */
  async retireTerminalRuns(options: RunRetentionOptions): Promise<RunRetentionResult> {
    const previous = this.retentionTail; let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current);
    this.retentionTail = queued; await previous;
    try { return await this.retireTerminalRunsUnlocked(options); }
    catch (error) { this.retentionIterator = undefined; throw error; }
    finally { release(); if (this.retentionTail === queued) this.retentionTail = Promise.resolve(); }
  }

  private async retireTerminalRunsUnlocked(options: RunRetentionOptions): Promise<RunRetentionResult> {
    const { retentionDays, backupConfirmed = false } = options, now = options.now ?? new Date();
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36_500) throw new Error("RUN_RETENTION_DAYS_INVALID");
    if (!Number.isFinite(now.getTime())) throw new Error("RUN_RETENTION_NOW_INVALID");
    await this.initialize();
    if (retentionDays === 0) return { scanned: 0, retired: 0, retained: 0 };
    if (backupConfirmed && !await this.readSchemaBarrier()) await this.ensureSchemaBarrier();
    const capacity = await this.inspectTombstoneCapacity();
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000, retiredAt = now.toISOString();
    if (!Number.isFinite(cutoff)) throw new Error("RUN_RETENTION_NOW_INVALID");
    await this.ensureActiveIndex();
    if (!this.fullRunIds?.size) { this.retentionIterator = undefined; return { scanned: 0, retired: 0, retained: 0 }; }
    const started = this.monotonicNow();
    let scanned = 0, retired = 0;
    while (true) {
      const elapsed = this.monotonicNow() - started;
      if (scanned >= this.maxRetentionScanned || retired >= this.maxRetentionRetired ||
          (scanned > 0 && elapsed >= this.maxRetentionElapsedMs)) break;
      this.retentionIterator ??= this.fullRunIds.values();
      const next = this.retentionIterator.next();
      if (next.done) { this.retentionIterator = undefined; break; }
      const runId = next.value;
      scanned++;
      if (await this.retireOne(runId, cutoff, retiredAt, backupConfirmed, capacity)) {
        retired++; this.fullRunIds.delete(runId); this.removeFromActiveIndex(runId);
      }
    }
    return { scanned, retired, retained: scanned - retired };
  }

  private async retireOne(runId: string, cutoff: number, retiredAt: string, backupConfirmed: boolean,
    capacity: { totalBytes: number; shardBytes: Map<string, number> }): Promise<boolean> {
    return await this.withRunLock(runId, async () => {
      const source = await this.readFullSource(runId); if (!source) return false;
      const record = source.record;
      if (!terminalRunStatuses.has(record.status) || record.cleanupPending === true || !record.finishedAt ||
          !isCanonicalInstant(record.finishedAt) || Date.parse(record.finishedAt) > cutoff) return false;
      if (!await this.readSchemaBarrier()) {
        if (!backupConfirmed) throw new Error("RUN_RETENTION_BACKUP_CONFIRMATION_REQUIRED");
        await this.ensureSchemaBarrier();
      }
      const tombstone = toTombstone(record, retiredAt), shard = shardForRun(runId);
      await this.withShardLock(shard, async () => {
        await this.assertPinnedRoots();
        const current = await this.readShard(shard);
        const existing = current.tombstones[runId];
        if (existing && !retirementIdentityMatches(record, existing)) throw new Error("RUN_TOMBSTONE_CONFLICT");
        if (!existing) {
          if (Object.keys(current.tombstones).length >= MAX_TOMBSTONES_PER_SHARD) throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
          const next: TombstoneShard = { ...current, tombstones: { ...current.tombstones, [runId]: tombstone } };
          const data = serializeShard(next);
          const nextBytes = Buffer.byteLength(data, "utf8"), previousBytes = capacity.shardBytes.get(shard) ?? 0;
          if (nextBytes > this.maxTombstoneShardBytes || capacity.totalBytes - previousBytes + nextBytes > this.maxTombstoneTotalBytes) {
            throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
          }
          await (this.#testHooks.writeTombstoneShard ?? atomicWrite)(this.shardPath(shard), data);
          await this.assertPinnedRoots();
          const durable = (await this.readShard(shard)).tombstones[runId];
          if (!durable || !retirementIdentityMatches(record, durable)) throw new Error("RUN_TOMBSTONE_WRITE_UNCONFIRMED");
          capacity.totalBytes = capacity.totalBytes - previousBytes + nextBytes; capacity.shardBytes.set(shard, nextBytes);
        }
      });
      await this.assertPinnedRoots();
      const latest = await this.readFullSource(runId);
      if (!latest) return false;
      if (latest.source !== source.source || !sameFileIdentity(latest.identity, source.identity)) throw new Error("RUN_RECORD_CHANGED_DURING_RETIREMENT");
      const durable = await this.readTombstone(runId);
      if (!durable || !retirementIdentityMatches(record, durable)) throw new Error("RUN_TOMBSTONE_WRITE_UNCONFIRMED");
      await this.assertPinnedRoots();
      await (this.#testHooks.unlinkRunRecord ?? unlink)(this.path(runId));
      await this.assertPinnedRoots();
      if (await this.readFullSource(runId)) throw new Error("RUN_RECORD_DELETE_UNCONFIRMED");
      await (this.#testHooks.syncRunsDirectory ?? this.syncDirectory)(this.root);
      return true;
    });
  }

  private async getUnlocked(runId: string): Promise<StoredPanelRun | undefined> {
    this.#testHooks.onRecordRead?.(runId);
    const beforeRead = this.#testHooks.beforeRecordRead?.(runId); if (beforeRead) await beforeRead;
    const full = await this.readFullSource(runId);
    const tombstone = await this.readTombstone(runId);
    if (tombstone && full && (!terminalRunStatuses.has(full.record.status) || !retirementIdentityMatches(full.record, tombstone))) {
      throw new Error("RUN_TOMBSTONE_CONFLICT");
    }
    return tombstone ? { ...tombstone } : full?.record;
  }

  private async readFullSource(runId: string): Promise<{ record: PanelRunRecord; source: string; identity: FileIdentity } | undefined> {
    try {
      const path = this.path(runId), stat = await lstat(path);
      if (!privateFile(stat)) throw new Error("run record 文件不安全");
      const identity = fileIdentity(stat);
      const source = await readFile(path, "utf8");
      const after = await lstat(path);
      if (!privateFile(after) || !sameFileIdentity(identity, fileIdentity(after))) {
        throw new Error("RUN_RECORD_CHANGED_DURING_READ");
      }
      return { record: validateFull(JSON.parse(source), runId), source, identity };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async readTombstone(runId: string): Promise<PanelRunTombstone | undefined> {
    return (await this.readShard(shardForRun(runId))).tombstones[runId];
  }

  private async readShard(shard: string): Promise<TombstoneShard> {
    try {
      const path = this.shardPath(shard), stat = await lstat(path);
      if (!privateFile(stat)) throw new Error("run tombstone shard 文件不安全");
      if (stat.size > this.maxTombstoneShardBytes) throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
      const identity = fileIdentity(stat), cached = this.shardCache.get(shard);
      if (cached && sameFileIdentity(cached.identity, identity)) {
        this.shardCache.delete(shard); this.shardCache.set(shard, cached); return cached.value;
      }
      const source = await readFile(path, "utf8"), after = await lstat(path);
      if (!privateFile(after) || !sameFileIdentity(identity, fileIdentity(after))) {
        throw new Error("RUN_TOMBSTONE_SHARD_CHANGED_DURING_READ");
      }
      this.#testHooks.onTombstoneShardParse?.(shard);
      const validated = validateShard(JSON.parse(source), shard);
      if (source !== serializeShard(validated)) throw new Error("RUN_TOMBSTONE_SHARD_NON_CANONICAL");
      this.shardCache.delete(shard); this.shardCache.set(shard, { identity, value: validated });
      while (this.shardCache.size > MAX_SHARD_CACHE_ENTRIES) this.shardCache.delete(this.shardCache.keys().next().value!);
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.shardCache.delete(shard); return { version: 1, kind: SHARD_KIND, shard, tombstones: {} };
      }
      throw error;
    }
  }

  private async inspectTombstoneCapacity(): Promise<{ totalBytes: number; shardBytes: Map<string, number> }> {
    let totalBytes = 0; const shardBytes = new Map<string, number>();
    for (const name of await readdir(this.tombstoneRoot)) {
      if (!name.endsWith(".json")) continue;
      const shard = name.slice(0, -5);
      if (!SHARD_PATTERN.test(shard)) throw new Error("RUN_TOMBSTONE_SHARD_INVALID");
      const stat = await lstat(this.shardPath(shard));
      if (!privateFile(stat) || stat.size > this.maxTombstoneShardBytes) throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
      totalBytes += stat.size;
      if (totalBytes > this.maxTombstoneTotalBytes) throw new Error("RUN_TOMBSTONE_CAPACITY_EXCEEDED");
      shardBytes.set(shard, stat.size);
    }
    return { totalBytes, shardBytes };
  }

  private get maxTombstoneShardBytes(): number { return this.#testHooks.maxTombstoneShardBytes ?? MAX_TOMBSTONE_SHARD_BYTES; }
  private get maxTombstoneTotalBytes(): number { return this.#testHooks.maxTombstoneTotalBytes ?? MAX_TOMBSTONE_TOTAL_BYTES; }
  private get maxRetentionScanned(): number { return this.#testHooks.maxRetentionScanned ?? MAX_RETENTION_SCANNED; }
  private get maxRetentionRetired(): number { return this.#testHooks.maxRetentionRetired ?? MAX_RETENTION_RETIRED; }
  private get maxRetentionElapsedMs(): number { return this.#testHooks.maxRetentionElapsedMs ?? MAX_RETENTION_ELAPSED_MS; }
  private readonly monotonicNow = (): number => this.#testHooks.monotonicNow ? this.#testHooks.monotonicNow() : performance.now();

  private async readSchemaBarrier(): Promise<boolean> {
    try {
      const stat = await lstat(this.barrierPath);
      if (!privateFile(stat) || stat.size > 1024) throw new Error("run tombstone schema barrier 无效");
      const identity = fileIdentity(stat), source = await readFile(this.barrierPath, "utf8"), after = await lstat(this.barrierPath);
      if (!privateFile(after) || !sameFileIdentity(identity, fileIdentity(after))) {
        throw new Error("run tombstone schema barrier 无效");
      }
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== "object" || Array.isArray(value) || !hasOnlyKeys(value as Record<string, unknown>, BARRIER_KEYS)) {
        throw new Error("run tombstone schema barrier 无效");
      }
      const item = value as Record<string, unknown>;
      if (item.version !== 1 || item.kind !== "panel-run-tombstone-schema-barrier" || item.tombstoneSchemaVersion !== 1) {
        throw new Error("run tombstone schema barrier 无效");
      }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async ensureSchemaBarrier(): Promise<void> {
    const previous = this.barrierTail; let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.barrierTail = previous.then(() => current);
    await previous;
    try {
      if (await this.readSchemaBarrier()) return;
      await this.assertPinnedRoots();
      const data = JSON.stringify({ version: 1, kind: "panel-run-tombstone-schema-barrier", tombstoneSchemaVersion: 1 }, null, 2) + "\n";
      await (this.#testHooks.writeSchemaBarrier ?? atomicWrite)(this.barrierPath, data);
      await this.assertPinnedRoots();
      if (!await this.readSchemaBarrier()) throw new Error("RUN_RETENTION_BARRIER_WRITE_UNCONFIRMED");
    } finally { release(); }
  }

  private async scanFullRecords(): Promise<PanelRunRecord[]> {
    this.#testHooks.onDirectoryScan?.(); const barrier = await this.readSchemaBarrier();
    const result: PanelRunRecord[] = [];
    for (const name of await (this.#testHooks.listRunFileNames?.() ?? readdir(this.root))) {
      if (name === SCHEMA_BARRIER_NAME || !name.endsWith(".json")) continue;
      const runId = name.slice(0, -5); this.path(runId);
      this.#testHooks.onRecordRead?.(runId);
      const beforeRead = this.#testHooks.beforeRecordRead?.(runId); if (beforeRead) await beforeRead;
      const full = await this.readFullSource(runId); if (!full) continue;
      result.push(full.record);
    }
    if (barrier) {
      const byShard = new Map<string, PanelRunRecord[]>();
      for (const record of result) {
        const shard = shardForRun(record.runId), records = byShard.get(shard) ?? [];
        records.push(record); byShard.set(shard, records);
      }
      for (const [shard, records] of byShard) {
        const tombstones = (await this.readShard(shard)).tombstones;
        for (const record of records) {
          const tombstone = tombstones[record.runId];
          if (tombstone && (!terminalRunStatuses.has(record.status) || !retirementIdentityMatches(record, tombstone))) {
            throw new Error("RUN_TOMBSTONE_CONFLICT");
          }
        }
      }
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
          const records = await this.scanFullRecords();
          if (generation === this.activeIndexGeneration) {
            this.activeIndex = this.buildActiveIndex(records); this.fullRunIds = new Set(records.map(record => record.runId));
            this.retentionIterator = undefined;
          }
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

  private async withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.runTails.get(runId) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current);
    this.runTails.set(runId, queued); await previous;
    try { return await action(); }
    finally { release(); if (this.runTails.get(runId) === queued) this.runTails.delete(runId); }
  }

  private async withShardLock<T>(shard: string, action: () => Promise<T>): Promise<T> {
    const previous = this.shardTails.get(shard) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current);
    this.shardTails.set(shard, queued); await previous;
    try { return await action(); }
    finally { release(); if (this.shardTails.get(shard) === queued) this.shardTails.delete(shard); }
  }

  private async pinDirectory(path: string, pinned: DirectoryIdentity | undefined, label: string): Promise<DirectoryIdentity> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat) || (stat.mode & 0o077) !== 0) throw new Error(`${label}不安全`);
    const identity = { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
    if (pinned && !sameDirectoryIdentity(pinned, identity)) throw new Error("RUN_STORE_ROOT_CHANGED");
    return pinned ?? identity;
  }

  private async assertPinnedRoots(): Promise<void> {
    this.rootIdentity = await this.pinDirectory(this.root, this.rootIdentity, "run store 根目录");
    this.tombstoneBaseRootIdentity = await this.pinDirectory(this.tombstoneBaseRoot, this.tombstoneBaseRootIdentity, "run tombstone 根目录");
    this.tombstoneRootIdentity = await this.pinDirectory(this.tombstoneRoot, this.tombstoneRootIdentity, "run tombstone schema 目录");
  }

  private readonly syncDirectory = async (path: string): Promise<void> => {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
}

export function publicRun(record: StoredPanelRun): PublicPanelRun {
  const errorCode = isPanelRunTombstone(record) ?
    record.status === "failed" ? record.failureCode ?? "RUN_FAILED" : record.status === "aborted" ? "RUN_ABORTED" : undefined : undefined;
  const error = isPanelRunTombstone(record) ? errorCode ? { code: errorCode, message: publicRunErrorMessage(errorCode) } : undefined : record.error;
  return { runId: record.runId, recordId: record.recordId, status: record.status, sequence: record.sequence,
    createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}), ...(record.revision ? { revision: record.revision } : {}),
    ...(error ? { error } : {}), canAbort: ["accepted", "running", "materializing"].includes(record.status) };
}
