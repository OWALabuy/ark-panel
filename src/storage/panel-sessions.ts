import { mkdir, open, readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { newPanelRecordId } from "../domain/record-id.js";
import { parseTranscript, serializeTranscript, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin, atomicWrite } from "./atomic.js";

export interface PanelMetadata {
  version: 1; recordId: string; agentId: string; createdAt: string;
  parentRecordId?: string; forkedFromMessageId?: string;
}

async function readRegular(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("panel 会话文件不安全");
  return await readFile(path, "utf8");
}

export async function createPanelSession(dataRoot: string, agentId: string, document: TranscriptDocument,
  source?: { parentRecordId?: string; forkedFromMessageId?: string; recordId?: string; createdAt?: string }): Promise<PanelMetadata> {
  const recordId = source?.recordId ?? newPanelRecordId(); const createdAt = source?.createdAt ?? new Date().toISOString();
  const metadata: PanelMetadata = { version: 1, recordId, agentId, createdAt,
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
      const metadata = JSON.parse(await readRegular(join(directory, "metadata.json"))) as PanelMetadata;
      if (metadata.version !== 1 || metadata.recordId !== name || metadata.agentId !== agentId) throw new Error("panel metadata 与目录不一致");
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

export async function loadPanelSession(dataRoot: string, agentId: string, recordId: string): Promise<{ metadata: PanelMetadata; document: TranscriptDocument }> {
  const directory = assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId));
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("panel 会话目录不安全");
  const metadata = JSON.parse(await readRegular(join(directory, "metadata.json"))) as PanelMetadata;
  if (metadata.version !== 1 || metadata.agentId !== agentId || metadata.recordId !== recordId) throw new Error("panel metadata 与请求不一致");
  return { metadata, document: parseTranscript(await readRegular(join(directory, "transcript.jsonl"))) };
}
