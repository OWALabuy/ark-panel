import { mkdir, open, readdir, readFile, lstat, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { newPanelRecordId } from "../domain/record-id.js";
import { parseTranscript, serializeTranscript, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin, atomicWrite } from "./atomic.js";
import { removeSessionAttachmentReferences } from "./attachments.js";

export interface PanelMetadata {
  version: 1; recordId: string; agentId: string; createdAt: string;
  parentRecordId?: string; forkedFromMessageId?: string;
  modelOverride?: string; thinkingLevel?: string; reasoningLevel?: "on" | "off" | "stream";
  title?: string; archived?: boolean; hidden?: boolean; memoryDisposition?: "eligible" | "scratch";
  pinned?: boolean; project?: string;
}

const metadataUpdates = new Map<string, Promise<void>>();

function validateMetadata(value: unknown, agentId: string, recordId: string): PanelMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("panel metadata 格式无效");
  const metadata = value as Partial<PanelMetadata>;
  if (metadata.version !== 1 || metadata.recordId !== recordId || metadata.agentId !== agentId || typeof metadata.createdAt !== "string") throw new Error("panel metadata 与请求不一致");
  if (metadata.modelOverride !== undefined && typeof metadata.modelOverride !== "string") throw new Error("panel metadata modelOverride 格式无效");
  if (metadata.thinkingLevel !== undefined && typeof metadata.thinkingLevel !== "string") throw new Error("panel metadata thinkingLevel 格式无效");
  if (metadata.reasoningLevel !== undefined && !["on", "off", "stream"].includes(metadata.reasoningLevel)) throw new Error("panel metadata reasoningLevel 格式无效");
  if (metadata.title !== undefined && (typeof metadata.title !== "string" || !metadata.title.trim() || metadata.title.length > 120)) throw new Error("panel metadata title 格式无效");
  if (metadata.archived !== undefined && typeof metadata.archived !== "boolean") throw new Error("panel metadata archived 格式无效");
  if (metadata.hidden !== undefined && typeof metadata.hidden !== "boolean") throw new Error("panel metadata hidden 格式无效");
  if (metadata.pinned !== undefined && typeof metadata.pinned !== "boolean") throw new Error("panel metadata pinned 格式无效");
  if (metadata.project !== undefined && (typeof metadata.project !== "string" || !metadata.project.trim() || metadata.project.length > 60 || /[\u0000-\u001f\u007f]/.test(metadata.project))) throw new Error("panel metadata project 格式无效");
  if (metadata.memoryDisposition !== undefined && !["eligible", "scratch"].includes(metadata.memoryDisposition)) throw new Error("panel metadata memoryDisposition 格式无效");
  return { archived: false, hidden: false, memoryDisposition: "scratch", ...metadata } as PanelMetadata;
}

async function readRegular(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("panel 会话文件不安全");
  return await readFile(path, "utf8");
}

export async function createPanelSession(dataRoot: string, agentId: string, document: TranscriptDocument,
  source?: { parentRecordId?: string; forkedFromMessageId?: string; recordId?: string; createdAt?: string; title?: string; project?: string }): Promise<PanelMetadata> {
  const recordId = source?.recordId ?? newPanelRecordId(); const createdAt = source?.createdAt ?? new Date().toISOString();
  const metadata: PanelMetadata = { version: 1, recordId, agentId, createdAt,
    archived: false, hidden: false, memoryDisposition: "scratch", ...(source?.title ? { title: source.title } : {}), ...(source?.project ? { project: source.project } : {}),
    ...(source?.parentRecordId && source.forkedFromMessageId ? { parentRecordId: source.parentRecordId, forkedFromMessageId: source.forkedFromMessageId } : {}) };
  const directory = assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadataHandle = await open(join(directory, "metadata.json"), "wx", 0o600);
  try { await metadataHandle.writeFile(JSON.stringify(metadata, null, 2) + "\n"); await metadataHandle.sync(); }
  finally { await metadataHandle.close(); }
  const transcriptHandle = await open(join(directory, "transcript.jsonl"), "wx", 0o600);
  try { await transcriptHandle.writeFile(serializeTranscript(document)); await transcriptHandle.sync(); }
  finally { await transcriptHandle.close(); }
  return metadata;
}

export async function listPanelSessions(dataRoot: string, agentId: string): Promise<PanelMetadata[]> {
  const root = assertWithin(dataRoot, join(dataRoot, "sessions", agentId));
  try {
    const records: PanelMetadata[] = [];
    for (const name of await readdir(root)) {
      const directory = assertWithin(root, join(root, name)); const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const metadata = validateMetadata(JSON.parse(await readRegular(join(directory, "metadata.json"))), agentId, name);
      parseTranscript(await readRegular(join(directory, "transcript.jsonl")));
      records.push(metadata);
    }
    return records.sort((a, b) => a.recordId.localeCompare(b.recordId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function commitPanelTranscript(dataRoot: string, metadata: PanelMetadata, document: TranscriptDocument): Promise<void> {
  const path = assertWithin(dataRoot, join(dataRoot, "sessions", metadata.agentId, metadata.recordId, "transcript.jsonl"));
  await atomicWrite(path, serializeTranscript(document));
}

export async function updatePanelMetadata(dataRoot: string, agentId: string, recordId: string,
  update: (metadata: PanelMetadata) => PanelMetadata): Promise<PanelMetadata> {
  const key = `${agentId}\0${recordId}`; const previous = metadataUpdates.get(key) ?? Promise.resolve();
  let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current); metadataUpdates.set(key, queued); await previous;
  try {
    const path = assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId, "metadata.json"));
    const metadata = validateMetadata(JSON.parse(await readRegular(path)), agentId, recordId);
    const next = validateMetadata(update({ ...metadata }), agentId, recordId);
    await atomicWrite(path, JSON.stringify(next, null, 2) + "\n"); return next;
  } finally {
    release(); if (metadataUpdates.get(key) === queued) metadataUpdates.delete(key);
  }
}

export async function loadPanelSession(dataRoot: string, agentId: string, recordId: string): Promise<{ metadata: PanelMetadata; document: TranscriptDocument }> {
  const directory = assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId));
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("panel 会话目录不安全");
  const metadata = validateMetadata(JSON.parse(await readRegular(join(directory, "metadata.json"))), agentId, recordId);
  return { metadata, document: parseTranscript(await readRegular(join(directory, "transcript.jsonl"))) };
}

export async function deletePanelSession(dataRoot: string, agentId: string, recordId: string): Promise<void> {
  const directory = assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId));
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("panel 会话目录不安全");
  const names = (await readdir(directory)).sort();
  const expected = names.includes("attachments.json") ? ["attachments.json", "metadata.json", "transcript.jsonl"] : ["metadata.json", "transcript.jsonl"];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error("PANEL_SESSION_DELETE_UNSAFE");
  const loaded = await loadPanelSession(dataRoot, agentId, recordId);
  if (!loaded.metadata.archived) throw new Error("SESSION_NOT_ARCHIVED");
  for (const name of names) {
    const path = assertWithin(directory, join(directory, name)); const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("PANEL_SESSION_DELETE_UNSAFE");
  }
  if (names.includes("attachments.json")) await removeSessionAttachmentReferences(dataRoot, agentId, recordId);
  await unlink(join(directory, "transcript.jsonl")); await unlink(join(directory, "metadata.json")); await rmdir(directory);
}
