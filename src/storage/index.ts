import { readdir, readFile, mkdir, copyFile, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { externalRecordId, type SourceKind } from "../domain/record-id.js";
import { parseTranscript } from "../domain/transcript.js";
import { assertWithin, atomicWrite } from "./atomic.js";

export interface SessionRecord {
  recordId: string; agentId: string; sourceKind: SourceKind; sourceKey: string;
  sourceRevision: string; title?: string; messageCount: number; updatedAt?: string; snapshotPath?: string;
}

export interface ScanAgent { agentId: string; sessionsRoot: string }

const ACTIVE = /^([0-9a-f-]+)\.jsonl$/i;
const RESET = /^([0-9a-f-]+)\.jsonl\.reset\.(.+)$/i;

async function recordFor(agent: ScanAgent, name: string): Promise<SessionRecord | undefined> {
  const match = ACTIVE.exec(name) ?? RESET.exec(name);
  if (!match) return undefined;
  const kind: "active" | "reset" = name.includes(".reset.") ? "reset" : "active";
  const path = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, name));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const document = parseTranscript(await readFile(path, "utf8"));
  const sourceKey = kind === "active" ? match[1]! : name;
  const timestamp = typeof document.header.timestamp === "string" ? document.header.timestamp : undefined;
  return {
    recordId: externalRecordId(agent.agentId, kind, sourceKey), agentId: agent.agentId, sourceKind: kind,
    sourceKey, sourceRevision: `${stat.size}:${stat.mtimeMs}`, messageCount: document.entries.filter((e) => e.type === "message").length,
    ...(timestamp ? { updatedAt: timestamp } : {})
  };
}

export async function scanAgent(agent: ScanAgent): Promise<SessionRecord[]> {
  const names = await readdir(agent.sessionsRoot);
  const records = await Promise.all(names.sort().map((name) => recordFor(agent, name)));
  return records.filter((record): record is SessionRecord => !!record);
}

export async function importResetSnapshot(agent: ScanAgent, record: SessionRecord, dataRoot: string): Promise<SessionRecord> {
  if (record.sourceKind !== "reset") throw new Error("只有 reset 记录可以导入快照");
  const source = assertWithin(agent.sessionsRoot, join(agent.sessionsRoot, record.sourceKey));
  const targetDir = join(dataRoot, "snapshots", agent.agentId);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const target = assertWithin(dataRoot, join(targetDir, `${record.recordId}.jsonl`));
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("reset 来源不是普通文件");
  try { await copyFile(source, target, 1); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { ...record, snapshotPath: join("snapshots", agent.agentId, basename(target)) };
}

export async function rebuildIndex(agents: ScanAgent[], indexPath: string): Promise<SessionRecord[]> {
  const records = (await Promise.all(agents.map(scanAgent))).flat().sort((a, b) => a.recordId.localeCompare(b.recordId));
  await atomicWrite(indexPath, JSON.stringify({ version: 1, records }, null, 2) + "\n");
  return records;
}
