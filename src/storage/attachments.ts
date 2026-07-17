import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertWithin } from "./atomic.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME_BYTES = 255;
export const MAX_ATTACHMENT_MIME_BYTES = 127;

export interface AttachmentManifest {
  version: 1;
  attachmentId: string;
  sha256: string;
  size: number;
  fileName: string;
  mimeType: string;
  createdAt: string;
}

export interface AttachmentReference {
  attachmentId: string;
  messageId: string;
  role: "user" | "assistant";
  addedAt: string;
}

export interface SessionAttachmentIndex {
  version: 1;
  agentId: string;
  recordId: string;
  references: AttachmentReference[];
}

export interface StoredSessionAttachment {
  manifest: AttachmentManifest;
  reference: AttachmentReference;
}

export interface AttachmentInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AttachmentOwner {
  agentId: string;
  recordId: string;
  messageId: string;
  role: "user" | "assistant";
}

export interface AttachmentGcResult { removedAttachments: string[]; removedBlobs: string[] }

const ATTACHMENT_ID = /^att_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const updates = new Map<string, Promise<void>>();

async function serialized<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = updates.get(dataRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  updates.set(dataRoot, queued);
  await previous;
  try { return await operation(); }
  finally { release(); if (updates.get(dataRoot) === queued) updates.delete(dataRoot); }
}

function validateOpaqueId(value: string, label: string): string {
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(value) || value === "." || value === "..") throw new Error(`${label} 格式无效`);
  return value;
}

export function validateAttachmentFileName(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value === "." || value === ".." || basename(value) !== value || /[\u0000-\u001f\u007f/\\]/.test(value) || Buffer.byteLength(value, "utf8") > MAX_ATTACHMENT_FILENAME_BYTES) throw new Error("附件文件名无效");
  return value;
}

export function validateAttachmentMimeType(value: string): string {
  if (typeof value !== "string" || value !== value.toLowerCase() || Buffer.byteLength(value, "ascii") > MAX_ATTACHMENT_MIME_BYTES || !MIME.test(value)) throw new Error("附件 MIME 类型无效");
  return value;
}

function validateBytes(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array)) throw new Error("附件内容无效");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("附件超过大小上限");
  return Buffer.from(bytes);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("附件目录不安全");
  await chmod(path, 0o700);
}

async function ensureLayout(dataRoot: string): Promise<{ blobs: string; manifests: string }> {
  const files = assertWithin(dataRoot, join(dataRoot, "files"));
  const blobs = assertWithin(dataRoot, join(files, "blobs", "sha256"));
  const manifests = assertWithin(dataRoot, join(files, "manifests"));
  await ensureDirectory(files); await ensureDirectory(join(files, "blobs")); await ensureDirectory(blobs); await ensureDirectory(manifests);
  return { blobs, manifests };
}

async function readSafeFile(path: string, maximum = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("附件文件不是安全普通文件");
    if (before.size > maximum) throw new Error("附件超过大小上限");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) throw new Error("附件文件在读取期间发生变化");
    if (bytes.length > maximum) throw new Error("附件超过大小上限");
    return bytes;
  } finally { await handle.close(); }
}

async function createImmutable(path: string, bytes: Uint8Array): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function writeMutable(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw new Error("附件索引文件不安全");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}

function parseManifest(value: unknown, expectedId?: string): AttachmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件 manifest 格式无效");
  const item = value as Partial<AttachmentManifest>;
  if (item.version !== 1 || typeof item.attachmentId !== "string" || !ATTACHMENT_ID.test(item.attachmentId) || (expectedId !== undefined && item.attachmentId !== expectedId) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || !Number.isSafeInteger(item.size) || (item.size ?? -1) < 0 || (item.size ?? 0) > MAX_ATTACHMENT_BYTES || typeof item.fileName !== "string" || typeof item.mimeType !== "string" || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error("附件 manifest 格式无效");
  validateAttachmentFileName(item.fileName); validateAttachmentMimeType(item.mimeType);
  return item as AttachmentManifest;
}

function parseIndex(value: unknown, agentId: string, recordId: string): SessionAttachmentIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("附件索引格式无效");
  const index = value as Partial<SessionAttachmentIndex>;
  if (index.version !== 1 || index.agentId !== agentId || index.recordId !== recordId || !Array.isArray(index.references)) throw new Error("附件索引与会话不一致");
  const seen = new Set<string>();
  for (const reference of index.references) {
    if (!reference || typeof reference !== "object" || typeof reference.attachmentId !== "string" || !ATTACHMENT_ID.test(reference.attachmentId) || typeof reference.messageId !== "string" || !["user", "assistant"].includes(reference.role) || typeof reference.addedAt !== "string" || !Number.isFinite(Date.parse(reference.addedAt))) throw new Error("附件引用格式无效");
    validateOpaqueId(reference.messageId, "messageId");
    if (seen.has(reference.attachmentId)) throw new Error("附件引用重复");
    seen.add(reference.attachmentId);
  }
  return index as SessionAttachmentIndex;
}

function indexPath(dataRoot: string, agentId: string, recordId: string): string {
  validateOpaqueId(agentId, "agentId"); validateOpaqueId(recordId, "recordId");
  return assertWithin(dataRoot, join(dataRoot, "sessions", agentId, recordId, "attachments.json"));
}

async function assertSessionDirectory(dataRoot: string, agentId: string, recordId: string): Promise<string> {
  validateOpaqueId(agentId, "agentId"); validateOpaqueId(recordId, "recordId");
  const sessions = assertWithin(dataRoot, join(dataRoot, "sessions")), agent = assertWithin(sessions, join(sessions, agentId)), record = assertWithin(agent, join(agent, recordId));
  for (const [path, label] of [[sessions, "sessions"], [agent, "agent"], [record, "会话"]] as const) {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`附件所属${label}目录不安全`);
  }
  return record;
}

async function readIndex(dataRoot: string, agentId: string, recordId: string): Promise<SessionAttachmentIndex> {
  await assertSessionDirectory(dataRoot, agentId, recordId);
  const path = indexPath(dataRoot, agentId, recordId);
  try { return parseIndex(JSON.parse((await readSafeFile(path, 4 * 1024 * 1024)).toString("utf8")), agentId, recordId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, agentId, recordId, references: [] };
    throw error;
  }
}

async function readManifestAt(dataRoot: string, attachmentId: string): Promise<AttachmentManifest> {
  if (!ATTACHMENT_ID.test(attachmentId)) throw new Error("attachmentId 格式无效");
  const { manifests } = await ensureLayout(dataRoot);
  const path = assertWithin(manifests, join(manifests, `${attachmentId}.json`));
  return parseManifest(JSON.parse((await readSafeFile(path, 64 * 1024)).toString("utf8")), attachmentId);
}

async function writeBlob(blobs: string, sha256: string, bytes: Buffer): Promise<void> {
  const bucket = assertWithin(blobs, join(blobs, sha256.slice(0, 2)));
  const path = assertWithin(blobs, join(bucket, sha256));
  await ensureDirectory(bucket);
  try { await createImmutable(path, bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stored = await readSafeFile(path);
  if (stored.length !== bytes.length || createHash("sha256").update(stored).digest("hex") !== sha256) throw new Error("已存在的附件 blob 校验失败");
}

async function storeAndReferenceUnlocked(dataRoot: string, input: AttachmentInput, owner: AttachmentOwner): Promise<StoredSessionAttachment> {
  validateOpaqueId(owner.agentId, "agentId"); validateOpaqueId(owner.recordId, "recordId"); validateOpaqueId(owner.messageId, "messageId");
  if (!["user", "assistant"].includes(owner.role)) throw new Error("附件角色无效");
  await assertSessionDirectory(dataRoot, owner.agentId, owner.recordId);
  const bytes = validateBytes(input.bytes), fileName = validateAttachmentFileName(input.fileName), mimeType = validateAttachmentMimeType(input.mimeType);
  const sha256 = createHash("sha256").update(bytes).digest("hex"), attachmentId = `att_${randomUUID()}`;
  const manifest: AttachmentManifest = { version: 1, attachmentId, sha256, size: bytes.length, fileName, mimeType, createdAt: new Date().toISOString() };
  const layout = await ensureLayout(dataRoot);
  await writeBlob(layout.blobs, sha256, bytes);
  await createImmutable(assertWithin(layout.manifests, join(layout.manifests, `${attachmentId}.json`)), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  const index = await readIndex(dataRoot, owner.agentId, owner.recordId);
  const reference: AttachmentReference = { attachmentId, messageId: owner.messageId, role: owner.role, addedAt: new Date().toISOString() };
  index.references.push(reference);
  try { await writeMutable(indexPath(dataRoot, owner.agentId, owner.recordId), Buffer.from(JSON.stringify(index, null, 2) + "\n")); }
  catch (error) { await unlink(join(layout.manifests, `${attachmentId}.json`)).catch(() => undefined); throw error; }
  return { manifest, reference };
}

export async function storeSessionAttachment(dataRoot: string, input: AttachmentInput, owner: AttachmentOwner): Promise<StoredSessionAttachment> {
  return serialized(dataRoot, () => storeAndReferenceUnlocked(dataRoot, input, owner));
}

export async function storeSessionAttachmentFile(dataRoot: string, allowedSourceRoot: string, sourcePath: string, metadata: Omit<AttachmentInput, "bytes">, owner: AttachmentOwner): Promise<StoredSessionAttachment> {
  const rootStat = await lstat(allowedSourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("附件来源根目录不安全");
  assertWithin(await realpath(allowedSourceRoot), await realpath(sourcePath));
  const bytes = await readSafeFile(sourcePath);
  return storeSessionAttachment(dataRoot, { ...metadata, bytes }, owner);
}

export async function getAttachmentManifest(dataRoot: string, attachmentId: string): Promise<AttachmentManifest> {
  return readManifestAt(dataRoot, attachmentId);
}

export async function readAttachmentBytes(dataRoot: string, attachmentId: string): Promise<Buffer> {
  const manifest = await readManifestAt(dataRoot, attachmentId), { blobs } = await ensureLayout(dataRoot);
  const path = assertWithin(blobs, join(blobs, manifest.sha256.slice(0, 2), manifest.sha256));
  const bytes = await readSafeFile(path);
  if (bytes.length !== manifest.size || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("附件 blob 完整性校验失败");
  return bytes;
}

export async function listSessionAttachments(dataRoot: string, agentId: string, recordId: string): Promise<StoredSessionAttachment[]> {
  const index = await readIndex(dataRoot, agentId, recordId);
  return Promise.all(index.references.map(async (reference) => ({ reference, manifest: await readManifestAt(dataRoot, reference.attachmentId) })));
}

export async function getSessionAttachment(dataRoot: string, agentId: string, recordId: string, attachmentId: string): Promise<StoredSessionAttachment> {
  if (!ATTACHMENT_ID.test(attachmentId)) throw new Error("attachmentId 格式无效");
  const item = (await listSessionAttachments(dataRoot, agentId, recordId)).find((candidate) => candidate.reference.attachmentId === attachmentId);
  if (!item) throw new Error("ATTACHMENT_NOT_OWNED_BY_SESSION");
  return item;
}

export async function readSessionAttachmentBytes(dataRoot: string, agentId: string, recordId: string, attachmentId: string): Promise<Buffer> {
  await getSessionAttachment(dataRoot, agentId, recordId, attachmentId);
  return readAttachmentBytes(dataRoot, attachmentId);
}

/** Rebind uploads created before the user transcript entry exists to that durable entry. */
export async function assignSessionAttachments(dataRoot: string, agentId: string, recordId: string,
  attachmentIds: readonly string[], messageId: string, role: "user" | "assistant"): Promise<StoredSessionAttachment[]> {
  return serialized(dataRoot, async () => {
    validateOpaqueId(messageId, "messageId");
    if (!Array.isArray(attachmentIds) || new Set(attachmentIds).size !== attachmentIds.length) throw new Error("附件列表重复");
    const index = await readIndex(dataRoot, agentId, recordId);
    const selected = attachmentIds.map((attachmentId) => {
      if (!ATTACHMENT_ID.test(attachmentId)) throw new Error("attachmentId 格式无效");
      const reference = index.references.find((item) => item.attachmentId === attachmentId);
      if (!reference) throw new Error("ATTACHMENT_NOT_OWNED_BY_SESSION");
      if (reference.role !== role) throw new Error("ATTACHMENT_ALREADY_ASSIGNED");
      return reference;
    });
    for (const reference of selected) reference.messageId = messageId;
    if (selected.length) await writeMutable(indexPath(dataRoot, agentId, recordId), Buffer.from(JSON.stringify(index, null, 2) + "\n"));
    return await Promise.all(selected.map(async (reference) => ({ reference: { ...reference }, manifest: await readManifestAt(dataRoot, reference.attachmentId) })));
  });
}

export async function forkSessionAttachmentReferences(dataRoot: string, source: { agentId: string; recordId: string }, target: { agentId: string; recordId: string }, includedMessageIds: ReadonlySet<string>): Promise<number> {
  return serialized(dataRoot, async () => {
    const sourceIndex = await readIndex(dataRoot, source.agentId, source.recordId), targetPath = indexPath(dataRoot, target.agentId, target.recordId);
    await assertSessionDirectory(dataRoot, target.agentId, target.recordId);
    const references = sourceIndex.references.filter((item) => includedMessageIds.has(item.messageId));
    for (const item of references) await readManifestAt(dataRoot, item.attachmentId);
    const targetIndex: SessionAttachmentIndex = { version: 1, agentId: target.agentId, recordId: target.recordId, references: references.map((item) => ({ ...item })) };
    if (references.length > 0) await writeMutable(targetPath, Buffer.from(JSON.stringify(targetIndex, null, 2) + "\n"));
    return references.length;
  });
}

export async function removeSessionAttachmentReferences(dataRoot: string, agentId: string, recordId: string): Promise<void> {
  await serialized(dataRoot, async () => {
    const path = indexPath(dataRoot, agentId, recordId);
    try {
      parseIndex(JSON.parse((await readSafeFile(path, 4 * 1024 * 1024)).toString("utf8")), agentId, recordId);
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
}

/** Remove selected references after a failed multi-file materialization. Blobs are reclaimed by GC. */
export async function removeSessionAttachments(dataRoot: string, agentId: string, recordId: string,
  attachmentIds: readonly string[]): Promise<number> {
  return serialized(dataRoot, async () => {
    if (!Array.isArray(attachmentIds) || new Set(attachmentIds).size !== attachmentIds.length ||
        attachmentIds.some(id => !ATTACHMENT_ID.test(id))) throw new Error("attachmentId 列表无效");
    if (!attachmentIds.length) return 0;
    const index = await readIndex(dataRoot, agentId, recordId), removed = new Set(attachmentIds);
    const before = index.references.length;
    index.references = index.references.filter(reference => !removed.has(reference.attachmentId));
    if (index.references.length !== before) await writeMutable(indexPath(dataRoot, agentId, recordId), Buffer.from(JSON.stringify(index, null, 2) + "\n"));
    return before - index.references.length;
  });
}

/** Reconcile a quiescent session index with its durable transcript and expire abandoned uploads. */
export async function pruneSessionAttachments(dataRoot: string, agentId: string, recordId: string,
  liveMessageIds: ReadonlySet<string>, pendingBefore: Date, pruneOrphans = true): Promise<number> {
  return serialized(dataRoot, async () => {
    const index = await readIndex(dataRoot, agentId, recordId), before = index.references.length;
    index.references = index.references.filter(reference => liveMessageIds.has(reference.messageId) ||
      (!pruneOrphans && !reference.messageId.startsWith("pending_")) ||
      (reference.role === "user" && reference.messageId.startsWith("pending_") && Date.parse(reference.addedAt) >= pendingBefore.getTime()));
    if (index.references.length !== before) await writeMutable(indexPath(dataRoot, agentId, recordId), Buffer.from(JSON.stringify(index, null, 2) + "\n"));
    return before - index.references.length;
  });
}

async function collectLiveAttachmentIds(dataRoot: string): Promise<Set<string>> {
  const live = new Set<string>(), sessionsRoot = assertWithin(dataRoot, join(dataRoot, "sessions"));
  let agents: string[];
  try { agents = await readdir(sessionsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return live; throw error; }
  for (const agentId of agents) {
    const agentPath = assertWithin(sessionsRoot, join(sessionsRoot, agentId)), agentStat = await lstat(agentPath);
    if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) throw new Error("会话附件扫描遇到不安全 agent 目录");
    for (const recordId of await readdir(agentPath)) {
      const recordPath = assertWithin(agentPath, join(agentPath, recordId)), recordStat = await lstat(recordPath);
      if (!recordStat.isDirectory() || recordStat.isSymbolicLink()) throw new Error("会话附件扫描遇到不安全会话目录");
      const index = await readIndex(dataRoot, agentId, recordId);
      for (const reference of index.references) live.add(reference.attachmentId);
    }
  }
  return live;
}

export async function garbageCollectAttachments(dataRoot: string): Promise<AttachmentGcResult> {
  return serialized(dataRoot, async () => {
    const live = await collectLiveAttachmentIds(dataRoot), layout = await ensureLayout(dataRoot), manifests = new Map<string, AttachmentManifest>(), removedAttachments: string[] = [];
    for (const name of await readdir(layout.manifests)) {
      if (!/^att_[0-9a-f-]+\.json$/.test(name)) throw new Error("附件 manifest 目录包含未知文件");
      const id = name.slice(0, -5), manifest = await readManifestAt(dataRoot, id);
      if (live.has(id)) manifests.set(id, manifest);
      else { await unlink(join(layout.manifests, name)); removedAttachments.push(id); }
    }
    const liveHashes = new Set([...manifests.values()].map((item) => item.sha256)), removedBlobs: string[] = [];
    for (const bucketName of await readdir(layout.blobs)) {
      if (!/^[0-9a-f]{2}$/.test(bucketName)) throw new Error("附件 blob 目录包含未知目录");
      const bucket = join(layout.blobs, bucketName), stat = await lstat(bucket);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("附件 blob 分桶不安全");
      for (const hash of await readdir(bucket)) {
        if (!SHA256.test(hash) || !hash.startsWith(bucketName)) throw new Error("附件 blob 目录包含未知文件");
        const path = join(bucket, hash), bytes = await readSafeFile(path);
        if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("附件 blob 完整性校验失败");
        if (!liveHashes.has(hash)) { await unlink(path); removedBlobs.push(hash); }
      }
      if ((await readdir(bucket)).length === 0) await rmdir(bucket);
    }
    return { removedAttachments: removedAttachments.sort(), removedBlobs: removedBlobs.sort() };
  });
}
