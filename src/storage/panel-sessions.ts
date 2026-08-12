import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, readdir, lstat, unlink, rmdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { newPanelRecordId } from "../domain/record-id.js";
import { parseTranscript, serializeTranscript, type TranscriptDocument } from "../domain/transcript.js";
import { assertWithin, atomicWrite } from "./atomic.js";
import { removeSessionAttachmentReferences, withForkedSessionAttachmentIndex, type SessionAttachmentIndex } from "./attachments.js";
import { PANEL_SESSION_STAGING_PREFIX } from "./panel-session-layout.js";

export interface PanelMetadata {
  version: 1; recordId: string; agentId: string; createdAt: string;
  parentRecordId?: string; forkedFromMessageId?: string;
  modelOverride?: string; thinkingLevel?: string; reasoningLevel?: "on" | "off" | "stream";
  title?: string; archived?: boolean; hidden?: boolean; memoryDisposition?: "eligible" | "scratch";
  pinned?: boolean; project?: string;
}

const metadataUpdates = new Map<string, Promise<void>>();
const sessionCreates = new Map<string, Promise<void>>();
const STORAGE_UNAVAILABLE = "PANEL_SESSION_STORAGE_UNAVAILABLE";

export type PanelSessionPublishStep = "sessions-parent-sync" | "agent-parent-sync" |
  "metadata-write" | "metadata-sync" | "transcript-write" | "transcript-sync" |
  "attachments-write" | "attachments-sync" |
  "staging-directory-sync" | "publish-rename" | "published-directory-sync";
export interface PanelSessionPublishOptions { beforeStep?: (step: PanelSessionPublishStep) => void | Promise<void> }

export type PanelSessionDiagnosticReason = "STAGING_DIRECTORY" | "ENTRY_UNSAFE" | "METADATA_MISSING" | "METADATA_UNSAFE" |
  "METADATA_INVALID_JSON" | "METADATA_INVALID" | "TRANSCRIPT_MISSING" | "TRANSCRIPT_UNSAFE" | "TRANSCRIPT_INVALID";
export interface PanelSessionDiagnostic {
  event: "panel_session_record_skipped"; agentId: string; entryKey: string; reason: PanelSessionDiagnosticReason;
}
export type PanelSessionDiagnosticSink = (event: PanelSessionDiagnostic) => void;

export interface ScannedPanelSession {
  metadata: PanelMetadata; document: TranscriptDocument; revision: string; updatedAt: string;
}

class PanelSessionScanError extends Error {
  constructor(readonly reason: PanelSessionDiagnosticReason) { super(reason); }
}

function opaqueComponent(value: string, label: string): string {
  if (!value || value.length > 200 || value === "." || value === ".." || value.startsWith(PANEL_SESSION_STAGING_PREFIX) || /[\u0000-\u001f\u007f/\\]/.test(value)) throw new Error(`${label} 格式无效`);
  return value;
}

function entryKey(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
}

function defaultDiagnostic(event: PanelSessionDiagnostic): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function diagnostic(sink: PanelSessionDiagnosticSink, agentId: string, name: string, reason: PanelSessionDiagnosticReason): void {
  try { sink({ event: "panel_session_record_skipped", agentId, entryKey: entryKey(name), reason }); }
  catch { /* Diagnostics must never hide otherwise healthy sessions. */ }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function storageUnavailable(): Error { return new Error(STORAGE_UNAVAILABLE); }

async function validatedDataRoot(dataRoot: string): Promise<string> {
  const root = resolve(dataRoot); let stat: Stats;
  try { stat = await lstat(root); }
  catch { throw storageUnavailable(); }
  const wrongOwner = typeof process.getuid === "function" && stat.uid !== process.getuid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || wrongOwner || (stat.mode & 0o777) !== 0o700) throw storageUnavailable();
  return root;
}

function assertPrivateDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`${label}目录不安全`);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function ensurePrivateChild(parent: string, path: string, label: string, syncStep: PanelSessionPublishStep,
  options: PanelSessionPublishOptions): Promise<void> {
  try {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    assertPrivateDirectory(await lstat(path), label);
  } catch { throw storageUnavailable(); }
  await options.beforeStep?.(syncStep);
  try { await syncDirectory(parent); }
  catch { throw storageUnavailable(); }
}

async function prepareAgentRoot(dataRoot: string, agentId: string, options: PanelSessionPublishOptions): Promise<string> {
  opaqueComponent(agentId, "agentId"); const root = await validatedDataRoot(dataRoot);
  const sessionsRoot = assertWithin(root, join(root, "sessions"));
  await ensurePrivateChild(root, sessionsRoot, "panel sessions", "sessions-parent-sync", options);
  const agentRoot = assertWithin(sessionsRoot, join(sessionsRoot, agentId));
  await ensurePrivateChild(sessionsRoot, agentRoot, "panel agent", "agent-parent-sync", options);
  return agentRoot;
}

async function existingAgentRoot(dataRoot: string, agentId: string): Promise<string | undefined> {
  opaqueComponent(agentId, "agentId"); const root = await validatedDataRoot(dataRoot), sessionsRoot = assertWithin(root, join(root, "sessions"));
  try { assertPrivateDirectory(await lstat(sessionsRoot), "panel sessions"); }
  catch (error) { if (isMissing(error)) { await validatedDataRoot(dataRoot); return undefined; } throw storageUnavailable(); }
  const agentRoot = assertWithin(sessionsRoot, join(sessionsRoot, agentId));
  try {
    assertPrivateDirectory(await lstat(agentRoot), "panel agent"); return agentRoot;
  } catch (error) { if (isMissing(error)) { await validatedDataRoot(dataRoot); return undefined; } throw storageUnavailable(); }
}

async function serializedCreate<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionCreates.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; }), queued = previous.then(() => current);
  sessionCreates.set(key, queued); await previous;
  try { return await operation(); }
  finally { release(); if (sessionCreates.get(key) === queued) sessionCreates.delete(key); }
}

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

async function readRegular(path: string): Promise<{ text: string; stat: Stats }> {
  const candidate = await lstat(path);
  if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1 || (candidate.mode & 0o077) !== 0) throw new Error("panel 会话文件不安全");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== candidate.dev || before.ino !== candidate.ino || before.nlink !== 1 || (before.mode & 0o077) !== 0) throw new Error("panel 会话文件不安全");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1 || bytes.length !== before.size) throw new Error("panel 会话文件读取期间发生变化");
    return { text: bytes.toString("utf8"), stat: after };
  } finally { await handle.close(); }
}

async function scanRecord(directory: string, agentId: string, recordId: string): Promise<ScannedPanelSession> {
  let metadataText: string;
  try { metadataText = (await readRegular(join(directory, "metadata.json"))).text; }
  catch (error) { throw new PanelSessionScanError(isMissing(error) ? "METADATA_MISSING" : "METADATA_UNSAFE"); }
  let rawMetadata: unknown;
  try { rawMetadata = JSON.parse(metadataText); }
  catch { throw new PanelSessionScanError("METADATA_INVALID_JSON"); }
  let metadata: PanelMetadata;
  try { metadata = validateMetadata(rawMetadata, agentId, recordId); }
  catch { throw new PanelSessionScanError("METADATA_INVALID"); }
  let transcript: { text: string; stat: Stats };
  try { transcript = await readRegular(join(directory, "transcript.jsonl")); }
  catch (error) { throw new PanelSessionScanError(isMissing(error) ? "TRANSCRIPT_MISSING" : "TRANSCRIPT_UNSAFE"); }
  let document: TranscriptDocument;
  try { document = parseTranscript(transcript.text); }
  catch { throw new PanelSessionScanError("TRANSCRIPT_INVALID"); }
  return { metadata, document, revision: `${transcript.stat.size}:${transcript.stat.mtimeMs}`, updatedAt: transcript.stat.mtime.toISOString() };
}

async function publishPanelSession(dataRoot: string, agentId: string, document: TranscriptDocument,
  source?: { parentRecordId?: string; forkedFromMessageId?: string; recordId?: string; createdAt?: string; title?: string; project?: string },
  options: PanelSessionPublishOptions = {}, attachmentIndex?: SessionAttachmentIndex): Promise<PanelMetadata> {
  const recordId = source?.recordId ?? newPanelRecordId(); const createdAt = source?.createdAt ?? new Date().toISOString();
  opaqueComponent(agentId, "agentId"); opaqueComponent(recordId, "recordId");
  if (attachmentIndex && (attachmentIndex.version !== 1 || attachmentIndex.agentId !== agentId || attachmentIndex.recordId !== recordId || !attachmentIndex.references.length)) throw new Error("fork 附件索引与目标会话不一致");
  const metadata = validateMetadata({ version: 1, recordId, agentId, createdAt,
    archived: false, hidden: false, memoryDisposition: "scratch", ...(source?.title ? { title: source.title } : {}), ...(source?.project ? { project: source.project } : {}),
    ...(source?.parentRecordId && source.forkedFromMessageId ? { parentRecordId: source.parentRecordId, forkedFromMessageId: source.forkedFromMessageId } : {}) }, agentId, recordId);
  const key = `${resolve(dataRoot)}\0${agentId}\0${recordId}`;
  return await serializedCreate(key, async () => {
    const agentRoot = await prepareAgentRoot(dataRoot, agentId, options), directory = assertWithin(agentRoot, join(agentRoot, recordId));
    try { await lstat(directory); throw new Error("PANEL_SESSION_EXISTS"); }
    catch (error) { if (!isMissing(error)) throw error; }
    const staging = assertWithin(agentRoot, join(agentRoot, `${PANEL_SESSION_STAGING_PREFIX}${randomUUID()}`));
    await mkdir(staging, { mode: 0o700 }); assertPrivateDirectory(await lstat(staging), "panel staging");
    const write = async (name: string, data: string, writeStep: PanelSessionPublishStep, syncStep: PanelSessionPublishStep) => {
      const handle = await open(join(staging, name), "wx", 0o600);
      try {
        await options.beforeStep?.(writeStep); await handle.writeFile(data, "utf8");
        await options.beforeStep?.(syncStep); await handle.sync();
      } finally { await handle.close(); }
    };
    await write("metadata.json", JSON.stringify(metadata, null, 2) + "\n", "metadata-write", "metadata-sync");
    await write("transcript.jsonl", serializeTranscript(document), "transcript-write", "transcript-sync");
    if (attachmentIndex) await write("attachments.json", JSON.stringify(attachmentIndex, null, 2) + "\n", "attachments-write", "attachments-sync");
    await options.beforeStep?.("staging-directory-sync"); await syncDirectory(staging);
    try { await lstat(directory); throw new Error("PANEL_SESSION_EXISTS"); }
    catch (error) { if (!isMissing(error)) throw error; }
    await options.beforeStep?.("publish-rename"); await rename(staging, directory);
    try { await options.beforeStep?.("published-directory-sync"); await syncDirectory(agentRoot); }
    catch (error) {
      try { await rename(directory, staging); await syncDirectory(agentRoot); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "PANEL_SESSION_PUBLISH_DURABILITY_UNCERTAIN"); }
      throw error;
    }
    return metadata;
  });
}

export async function createPanelSession(dataRoot: string, agentId: string, document: TranscriptDocument,
  source?: { parentRecordId?: string; forkedFromMessageId?: string; recordId?: string; createdAt?: string; title?: string; project?: string },
  options: PanelSessionPublishOptions = {}): Promise<PanelMetadata> {
  return publishPanelSession(dataRoot, agentId, document, source, options);
}

export async function createPanelSessionFork(dataRoot: string, agentId: string, document: TranscriptDocument,
  source: { parentRecordId: string; forkedFromMessageId: string; recordId: string; createdAt?: string; title?: string; project?: string },
  attachmentSource?: { agentId: string; recordId: string }, options: PanelSessionPublishOptions = {}): Promise<PanelMetadata> {
  opaqueComponent(agentId, "agentId"); opaqueComponent(source.recordId, "recordId"); await validatedDataRoot(dataRoot);
  if (attachmentSource && attachmentSource.agentId !== agentId) throw new Error("FORK_ATTACHMENT_SOURCE_INVALID");
  if (!attachmentSource) return publishPanelSession(dataRoot, agentId, document, source, options);
  return withForkedSessionAttachmentIndex(dataRoot, attachmentSource, { agentId, recordId: source.recordId }, document,
    async attachmentIndex => publishPanelSession(dataRoot, agentId, document, source, options, attachmentIndex));
}

export async function scanPanelSessions(dataRoot: string, agentId: string,
  onDiagnostic: PanelSessionDiagnosticSink = defaultDiagnostic): Promise<ScannedPanelSession[]> {
  const root = await existingAgentRoot(dataRoot, agentId); if (!root) return [];
  const records: ScannedPanelSession[] = []; let names: string[];
  try { names = (await readdir(root)).sort(); }
  catch { throw storageUnavailable(); }
  for (const name of names) {
    if (name.startsWith(PANEL_SESSION_STAGING_PREFIX)) { diagnostic(onDiagnostic, agentId, name, "STAGING_DIRECTORY"); continue; }
    try { opaqueComponent(name, "recordId"); }
    catch { diagnostic(onDiagnostic, agentId, name, "ENTRY_UNSAFE"); continue; }
    const directory = assertWithin(root, join(root, name));
    let stat: Stats;
    try { stat = await lstat(directory); }
    catch { diagnostic(onDiagnostic, agentId, name, "ENTRY_UNSAFE"); continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) { diagnostic(onDiagnostic, agentId, name, "ENTRY_UNSAFE"); continue; }
    try { records.push(await scanRecord(directory, agentId, name)); }
    catch (error) { diagnostic(onDiagnostic, agentId, name, error instanceof PanelSessionScanError ? error.reason : "ENTRY_UNSAFE"); }
  }
  return records.sort((a, b) => a.metadata.recordId.localeCompare(b.metadata.recordId));
}

export async function listPanelSessions(dataRoot: string, agentId: string,
  onDiagnostic: PanelSessionDiagnosticSink = defaultDiagnostic): Promise<PanelMetadata[]> {
  return (await scanPanelSessions(dataRoot, agentId, onDiagnostic)).map(record => record.metadata);
}

export async function commitPanelTranscript(dataRoot: string, metadata: PanelMetadata, document: TranscriptDocument): Promise<void> {
  const directory = await publishedRecordDirectory(dataRoot, metadata.agentId, metadata.recordId);
  await readRegular(join(directory, "transcript.jsonl"));
  const path = assertWithin(directory, join(directory, "transcript.jsonl"));
  await atomicWrite(path, serializeTranscript(document));
}

export async function updatePanelMetadata(dataRoot: string, agentId: string, recordId: string,
  update: (metadata: PanelMetadata) => PanelMetadata): Promise<PanelMetadata> {
  const key = `${agentId}\0${recordId}`; const previous = metadataUpdates.get(key) ?? Promise.resolve();
  let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current); metadataUpdates.set(key, queued); await previous;
  try {
    const directory = await publishedRecordDirectory(dataRoot, agentId, recordId), path = assertWithin(directory, join(directory, "metadata.json"));
    const metadata = validateMetadata(JSON.parse((await readRegular(path)).text), agentId, recordId);
    const next = validateMetadata(update({ ...metadata }), agentId, recordId);
    await atomicWrite(path, JSON.stringify(next, null, 2) + "\n"); return next;
  } finally {
    release(); if (metadataUpdates.get(key) === queued) metadataUpdates.delete(key);
  }
}

async function publishedRecordDirectory(dataRoot: string, agentId: string, recordId: string): Promise<string> {
  opaqueComponent(agentId, "agentId"); opaqueComponent(recordId, "recordId");
  const agentRoot = await existingAgentRoot(dataRoot, agentId); if (!agentRoot) throw new Error("PANEL_SESSION_NOT_FOUND");
  const directory = assertWithin(agentRoot, join(agentRoot, recordId)); let stat: Stats;
  try { stat = await lstat(directory); }
  catch (error) { if (isMissing(error)) { await validatedDataRoot(dataRoot); throw new Error("PANEL_SESSION_NOT_FOUND"); } throw storageUnavailable(); }
  assertPrivateDirectory(stat, "panel 会话"); return directory;
}

export async function loadPanelSession(dataRoot: string, agentId: string, recordId: string): Promise<{ metadata: PanelMetadata; document: TranscriptDocument }> {
  const directory = await publishedRecordDirectory(dataRoot, agentId, recordId), scanned = await scanRecord(directory, agentId, recordId);
  return { metadata: scanned.metadata, document: scanned.document };
}

export async function deletePanelSession(dataRoot: string, agentId: string, recordId: string): Promise<void> {
  const directory = await publishedRecordDirectory(dataRoot, agentId, recordId);
  const names = (await readdir(directory)).sort();
  const expected = names.includes("attachments.json") ? ["attachments.json", "metadata.json", "transcript.jsonl"] : ["metadata.json", "transcript.jsonl"];
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error("PANEL_SESSION_DELETE_UNSAFE");
  const loaded = await loadPanelSession(dataRoot, agentId, recordId);
  if (!loaded.metadata.archived) throw new Error("SESSION_NOT_ARCHIVED");
  for (const name of names) {
    const path = assertWithin(directory, join(directory, name)); const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("PANEL_SESSION_DELETE_UNSAFE");
  }
  if (names.includes("attachments.json")) await removeSessionAttachmentReferences(dataRoot, agentId, recordId);
  await unlink(join(directory, "transcript.jsonl")); await unlink(join(directory, "metadata.json")); await rmdir(directory);
}
