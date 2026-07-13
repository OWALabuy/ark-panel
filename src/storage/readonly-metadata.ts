import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertWithin, atomicWrite } from "./atomic.js";

export interface ReadonlySourceIdentity {
  sourceKind: "active" | "reset";
  agentId: string;
  sourceSessionId: string;
  resetTimestamp?: string;
}

export interface ReadonlyMetadata extends ReadonlySourceIdentity {
  version: 1;
  title?: string;
  archived: boolean;
  hidden: boolean;
  memoryDisposition: "eligible" | "scratch";
  pinned?: boolean;
  project?: string;
  updatedAt: string;
}

const updates = new Map<string, Promise<void>>();

function keyOf(identity: ReadonlySourceIdentity): string {
  return [identity.agentId, identity.sourceKind, identity.sourceSessionId, identity.resetTimestamp ?? ""].join("\0");
}

function fileName(identity: ReadonlySourceIdentity): string {
  return createHash("sha256").update(keyOf(identity), "utf8").digest("hex") + ".json";
}

function defaults(identity: ReadonlySourceIdentity): ReadonlyMetadata {
  return { version: 1, ...identity, archived: false, hidden: false, memoryDisposition: "scratch", updatedAt: new Date(0).toISOString() };
}

function validate(value: unknown, identity: ReadonlySourceIdentity): ReadonlyMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("只读会话 metadata 格式无效");
  const item = value as Partial<ReadonlyMetadata>;
  if (item.version !== 1 || item.agentId !== identity.agentId || item.sourceKind !== identity.sourceKind || item.sourceSessionId !== identity.sourceSessionId ||
    item.resetTimestamp !== identity.resetTimestamp) throw new Error("只读会话 metadata 与来源不一致");
  if (item.title !== undefined && (typeof item.title !== "string" || !item.title.trim() || item.title.length > 120)) throw new Error("只读会话标题格式无效");
  if (item.pinned !== undefined && typeof item.pinned !== "boolean") throw new Error("只读会话置顶格式无效");
  if (item.project !== undefined && (typeof item.project !== "string" || !item.project.trim() || item.project.length > 60 || /[\u0000-\u001f\u007f]/.test(item.project))) throw new Error("只读会话 project 格式无效");
  if (typeof item.archived !== "boolean" || typeof item.hidden !== "boolean" || !["eligible", "scratch"].includes(item.memoryDisposition ?? "") || typeof item.updatedAt !== "string") {
    throw new Error("只读会话 metadata 字段无效");
  }
  return item as ReadonlyMetadata;
}

async function directory(dataRoot: string, agentId: string): Promise<string> {
  const root = assertWithin(dataRoot, join(dataRoot, "readonly-meta"));
  const path = assertWithin(root, join(root, agentId));
  await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("只读会话 metadata 目录不安全");
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const pathStat = await lstat(path); if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) throw new Error("只读会话 metadata 目录不安全");
  return path;
}

export async function loadReadonlyMetadata(dataRoot: string, identity: ReadonlySourceIdentity): Promise<ReadonlyMetadata> {
  const path = join(await directory(dataRoot, identity.agentId), fileName(identity));
  try {
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("只读会话 metadata 文件不安全");
    return validate(JSON.parse(await readFile(path, "utf8")), identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(identity);
    throw error;
  }
}

export async function updateReadonlyMetadata(dataRoot: string, identity: ReadonlySourceIdentity,
  update: (metadata: ReadonlyMetadata) => ReadonlyMetadata): Promise<ReadonlyMetadata> {
  const key = keyOf(identity), previous = updates.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current); updates.set(key, queued); await previous;
  try {
    const next = validate(update({ ...await loadReadonlyMetadata(dataRoot, identity), updatedAt: new Date().toISOString() }), identity);
    const dir = await directory(dataRoot, identity.agentId); await atomicWrite(assertWithin(dir, join(dir, fileName(identity))), JSON.stringify(next, null, 2) + "\n"); return next;
  } finally { release(); if (updates.get(key) === queued) updates.delete(key); }
}
