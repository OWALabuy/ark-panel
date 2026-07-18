import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { PanelAttachmentApi } from "../src/server/attachment-api.js";
import { createPanelSession } from "../src/storage/panel-sessions.js";

const emptyDocument = { header: { type: "session", version: 3 }, entries: [] };

test("图片预览只内联真实、单帧且有界的 PNG/JPEG/WebP", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-preview-")); t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createPanelSession(root, "agent", emptyDocument), api = new PanelAttachmentApi(root, ["agent"]);
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: "#336699" } }).png().toBuffer();
  const uploaded = await api.upload(session.recordId, { fileName: "picture.bin", mimeType: "application/octet-stream", bytes: png });
  const preview = await api.preview(uploaded.id); assert.ok(preview); assert.equal(preview.mimeType, "image/png"); assert.deepEqual(preview.bytes, png);

  const svg = await api.upload(session.recordId, { fileName: "unsafe.png", mimeType: "image/png",
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') });
  await assert.rejects(api.preview(svg.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
  const gif = await api.upload(session.recordId, { fileName: "animated.gif", mimeType: "image/gif",
    bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
  await assert.rejects(api.preview(gif.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
});
