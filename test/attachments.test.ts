import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  garbageCollectAttachments, forkSessionAttachmentReferences, listSessionAttachments,
  MAX_ATTACHMENT_BYTES, pruneSessionAttachments, readAttachmentBytes, readSessionAttachmentBytes, removeSessionAttachmentReferences,
  storeSessionAttachment, storeSessionAttachmentFile
} from "../src/storage/attachments.js";
import { createPanelSession, deletePanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";

const emptyDocument = { header: { type: "session", version: 3 }, entries: [] };

test("附件按内容寻址并以消息引用，Office 原文件无需转换即可保存", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachments-"));
  try {
    const session = await createPanelSession(root, "agent", emptyDocument);
    const word = Buffer.from("fixture office bytes");
    const first = await storeSessionAttachment(root, {
      fileName: "需求文档.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: word
    }, { agentId: "agent", recordId: session.recordId, messageId: "message-1", role: "user" });
    const second = await storeSessionAttachment(root, {
      fileName: "副本.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: word
    }, { agentId: "agent", recordId: session.recordId, messageId: "message-2", role: "assistant" });

    assert.notEqual(first.manifest.attachmentId, second.manifest.attachmentId);
    assert.equal(first.manifest.sha256, second.manifest.sha256);
    assert.deepEqual(await readAttachmentBytes(root, first.manifest.attachmentId), word);
    const unrelated = await createPanelSession(root, "agent", emptyDocument);
    await assert.rejects(readSessionAttachmentBytes(root, "agent", unrelated.recordId, first.manifest.attachmentId), /NOT_OWNED/);
    assert.deepEqual(await readSessionAttachmentBytes(root, "agent", session.recordId, first.manifest.attachmentId), word);
    const listed = await listSessionAttachments(root, "agent", session.recordId);
    assert.deepEqual(listed.map((item) => [item.manifest.fileName, item.reference.messageId]), [["需求文档.docx", "message-1"], ["副本.docx", "message-2"]]);

    const blob = join(root, "files", "blobs", "sha256", first.manifest.sha256.slice(0, 2), first.manifest.sha256);
    assert.equal((await lstat(blob)).mode & 0o777, 0o600);
    assert.equal((await lstat(dirname(blob))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, "files", "manifests", `${first.manifest.attachmentId}.json`))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, "sessions", "agent", session.recordId, "attachments.json"))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(root, "sessions", "agent", session.recordId, "attachments.json"), "utf8"), /office bytes|需求文档/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("附件输入严格限制文件名、MIME、大小和所属会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-validation-"));
  try {
    const session = await createPanelSession(root, "agent", emptyDocument), owner = { agentId: "agent", recordId: session.recordId, messageId: "m", role: "user" as const };
    for (const fileName of ["../secret", "sub/file", "bad\\file", " bad.txt", "bad\n.txt", "a".repeat(256)]) {
      await assert.rejects(storeSessionAttachment(root, { fileName, mimeType: "text/plain", bytes: Buffer.alloc(0) }, owner), /文件名无效/);
    }
    for (const mimeType of ["Text/Plain", "text/plain; charset=utf-8", "plain", "text//plain", "text/空白"]) {
      await assert.rejects(storeSessionAttachment(root, { fileName: "safe.txt", mimeType, bytes: Buffer.alloc(0) }, owner), /MIME 类型无效/);
    }
    await assert.rejects(storeSessionAttachment(root, { fileName: "large.bin", mimeType: "application/octet-stream", bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }, owner), /大小上限/);
    await assert.rejects(storeSessionAttachment(root, { fileName: "safe.txt", mimeType: "text/plain", bytes: Buffer.alloc(0) }, { ...owner, recordId: "missing" }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("从模型产出路径采集时拒绝 symlink、hardlink 和非普通文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-source-"));
  try {
    const session = await createPanelSession(root, "agent", emptyDocument), owner = { agentId: "agent", recordId: session.recordId, messageId: "m", role: "assistant" as const };
    const source = join(root, "source.txt"), alias = join(root, "alias.txt"), symbolic = join(root, "symbolic.txt"), directory = join(root, "directory");
    await writeFile(source, "safe"); await link(source, alias); await symlink(source, symbolic); await mkdir(directory);
    for (const path of [source, alias, symbolic, directory]) await assert.rejects(storeSessionAttachmentFile(root, root, path, { fileName: "output.txt", mimeType: "text/plain" }, owner), /安全普通文件|ELOOP|EISDIR/);
    await rm(alias); await rm(source); await writeFile(source, "safe");
    const stored = await storeSessionAttachmentFile(root, root, source, { fileName: "output.txt", mimeType: "text/plain" }, owner);
    assert.equal((await readAttachmentBytes(root, stored.manifest.attachmentId)).toString(), "safe");
    await assert.rejects(storeSessionAttachmentFile(root, directory, source, { fileName: "output.txt", mimeType: "text/plain" }, owner), /路径越界/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fork 仅复制纳入消息的引用，GC 尊重跨会话及内容去重引用", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-fork-"));
  try {
    const source = await createPanelSession(root, "agent", emptyDocument), target = await createPanelSession(root, "agent", emptyDocument);
    const keep = await storeSessionAttachment(root, { fileName: "keep.txt", mimeType: "text/plain", bytes: Buffer.from("same") }, { agentId: "agent", recordId: source.recordId, messageId: "keep", role: "user" });
    const omit = await storeSessionAttachment(root, { fileName: "omit.txt", mimeType: "text/plain", bytes: Buffer.from("omit") }, { agentId: "agent", recordId: source.recordId, messageId: "omit", role: "assistant" });
    assert.equal(await forkSessionAttachmentReferences(root, { agentId: "agent", recordId: source.recordId }, { agentId: "agent", recordId: target.recordId }, new Set(["keep"])), 1);
    assert.deepEqual((await listSessionAttachments(root, "agent", target.recordId)).map((item) => item.manifest.attachmentId), [keep.manifest.attachmentId]);

    await removeSessionAttachmentReferences(root, "agent", source.recordId);
    const firstGc = await garbageCollectAttachments(root);
    assert.deepEqual(firstGc.removedAttachments, [omit.manifest.attachmentId]);
    assert.equal((await readAttachmentBytes(root, keep.manifest.attachmentId)).toString(), "same");
    await removeSessionAttachmentReferences(root, "agent", target.recordId);
    const secondGc = await garbageCollectAttachments(root);
    assert.deepEqual(secondGc.removedAttachments, [keep.manifest.attachmentId]);
    assert.equal(secondGc.removedBlobs.length, 1);
    await assert.rejects(readAttachmentBytes(root, keep.manifest.attachmentId), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("blob 被替换、硬链接或篡改后拒绝读取，归档会话可安全删除附件引用", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-integrity-"));
  try {
    const session = await createPanelSession(root, "agent", emptyDocument);
    const stored = await storeSessionAttachment(root, { fileName: "safe.txt", mimeType: "text/plain", bytes: Buffer.from("original") }, { agentId: "agent", recordId: session.recordId, messageId: "m", role: "user" });
    const blob = join(root, "files", "blobs", "sha256", stored.manifest.sha256.slice(0, 2), stored.manifest.sha256), alias = join(root, "blob-alias");
    await link(blob, alias); await assert.rejects(readAttachmentBytes(root, stored.manifest.attachmentId), /安全普通文件/); await rm(alias);
    await writeFile(blob, "tampered"); await assert.rejects(readAttachmentBytes(root, stored.manifest.attachmentId), /完整性校验失败/);
    await updatePanelMetadata(root, "agent", session.recordId, (current) => ({ ...current, archived: true }));
    await deletePanelSession(root, "agent", session.recordId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("附件维护保留 transcript 引用与新上传，并回收过期 pending 和悬空产出", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-prune-"));
  try {
    const session = await createPanelSession(root, "agent", emptyDocument);
    await storeSessionAttachment(root, { fileName: "live.txt", mimeType: "text/plain", bytes: Buffer.from("live") },
      { agentId: "agent", recordId: session.recordId, messageId: "live-message", role: "assistant" });
    await storeSessionAttachment(root, { fileName: "old.txt", mimeType: "text/plain", bytes: Buffer.from("old") },
      { agentId: "agent", recordId: session.recordId, messageId: "pending_old", role: "user" });
    await storeSessionAttachment(root, { fileName: "new.txt", mimeType: "text/plain", bytes: Buffer.from("new") },
      { agentId: "agent", recordId: session.recordId, messageId: "pending_new", role: "user" });
    await storeSessionAttachment(root, { fileName: "orphan.txt", mimeType: "text/plain", bytes: Buffer.from("orphan") },
      { agentId: "agent", recordId: session.recordId, messageId: "missing-message", role: "assistant" });
    const references = await listSessionAttachments(root, "agent", session.recordId);
    const old = references.find(item => item.reference.messageId === "pending_old")!;
    const indexPath = join(root, "sessions", "agent", session.recordId, "attachments.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.references.find((item: { attachmentId: string }) => item.attachmentId === old.manifest.attachmentId).addedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
    assert.equal(await pruneSessionAttachments(root, "agent", session.recordId, new Set(["live-message"]), new Date(Date.now() - 86_400_000)), 2);
    assert.deepEqual((await listSessionAttachments(root, "agent", session.recordId)).map(item => item.reference.messageId).sort(), ["live-message", "pending_new"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
