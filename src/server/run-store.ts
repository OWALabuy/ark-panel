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
  expectedRevision?: string;
  plannedUserEntryId?: string;
  stagedEntries?: unknown[];
  cleanupPending?: boolean;
}

export interface PublicRunTool { callId: string; name: string; phase: "started" | "completed" | "failed"; args?: unknown }
export interface PublicRunStream { revision: number; state: "connecting" | "streaming" | "degraded"; text: string; tools: PublicRunTool[] }
export interface PublicPanelRun { runId: string; recordId: string; status: PanelRunStatus; sequence: number; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; revision?: string; error?: { code: string; message: string }; canAbort: boolean; stream?: PublicRunStream }

function validate(value: unknown, expectedRunId?: string): PanelRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run record 格式无效");
  const item = value as Partial<PanelRunRecord>;
  if (item.version !== 1 || typeof item.runId !== "string" || (expectedRunId && item.runId !== expectedRunId) ||
      typeof item.recordId !== "string" || typeof item.requestHash !== "string" || typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string" || !Number.isInteger(item.sequence) || typeof item.status !== "string" || !["accepted", "running", "materializing", "committing", "committed", "aborting", "completed", "failed", "aborted"].includes(item.status)) {
    throw new Error("run record 格式无效");
  }
  return item as PanelRunRecord;
}

export class PanelRunStore {
  private readonly root: string;
  constructor(dataRoot: string) { this.root = assertWithin(dataRoot, join(dataRoot, "runs")); }
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
      const path = this.path(runId), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("run record 文件不安全");
      return validate(JSON.parse(await readFile(path, "utf8")), runId);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async put(record: PanelRunRecord): Promise<void> {
    await this.initialize();
    await atomicWrite(this.path(record.runId), JSON.stringify(validate(record, record.runId), null, 2) + "\n");
  }
  async list(): Promise<PanelRunRecord[]> {
    await this.initialize(); const result: PanelRunRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (!name.endsWith(".json")) continue;
      const runId = name.slice(0, -5); result.push((await this.get(runId))!);
    }
    return result;
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
