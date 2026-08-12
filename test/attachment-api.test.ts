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
  const source = { create: { width: 32, height: 20, channels: 3 as const, background: "#336699" } };
  const images = [
    { bytes: await sharp(source).png().toBuffer(), mimeType: "image/png" },
    { bytes: await sharp(source).jpeg().toBuffer(), mimeType: "image/jpeg" },
    { bytes: await sharp(source).webp().toBuffer(), mimeType: "image/webp" }
  ];
  for (const image of images) {
    const uploaded = await api.upload(session.recordId, { fileName: "picture.bin", mimeType: "application/octet-stream", bytes: image.bytes });
    const preview = await api.preview(uploaded.id); assert.ok(preview); assert.equal(preview.mimeType, image.mimeType); assert.deepEqual(preview.bytes, image.bytes);
  }

  const svg = await api.upload(session.recordId, { fileName: "unsafe.png", mimeType: "image/png",
    bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') });
  await assert.rejects(api.preview(svg.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
  const gif = await api.upload(session.recordId, { fileName: "animated.gif", mimeType: "image/gif",
    bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
  await assert.rejects(api.preview(gif.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
  const corrupt = await api.upload(session.recordId, { fileName: "corrupt.png", mimeType: "image/png",
    bytes: Buffer.from("89504e470d0a1a0a00000000", "hex") });
  await assert.rejects(api.preview(corrupt.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
  const tooWideBytes = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  const tooWide = await api.upload(session.recordId, { fileName: "too-wide.png", mimeType: "image/png", bytes: tooWideBytes });
  await assert.rejects(api.preview(tooWide.id), /ATTACHMENT_PREVIEW_UNSUPPORTED/);
});
