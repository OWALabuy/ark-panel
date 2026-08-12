import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { PanelAttachmentApi } from "../src/server/attachment-api.js";
import { createPanelSession } from "../src/storage/panel-sessions.js";
import { SessionReadIndex, type SessionReadIndexEvent } from "../src/storage/index.js";
import { tempFixture } from "./test-helpers.js";

const emptyDocument = { header: { type: "session", version: 3 }, entries: [] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-attachment-preview-"));
  const session = await createPanelSession(root, "agent", emptyDocument);
  return { root, session, api: new PanelAttachmentApi(root, ["agent"]) };
}

async function assertUnsupported(api: PanelAttachmentApi, recordId: string, bytes: Buffer) {
  const uploaded = await api.upload(recordId, { fileName: "picture.bin", mimeType: "application/octet-stream", bytes });
  await assert.rejects(api.preview(uploaded.id), error => error instanceof Error && error.message === "ATTACHMENT_PREVIEW_UNSUPPORTED");
}

test("图片预览只内联真实、单帧且有界的 PNG/JPEG/WebP", async t => {
  const { root, session, api } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
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

test("图片预览完整解码并拒绝 metadata 可读的截尾 PNG", async t => {
  const { root, session, api } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#336699" } }).png().toBuffer();
  const truncated = png.subarray(0, png.length - 30);
  const metadata = await sharp(truncated).metadata(); assert.equal(metadata.format, "png");
  await assert.rejects(sharp(truncated).stats());
  await assertUnsupported(api, session.recordId, truncated);
});

test("图片预览拒绝双帧 animated WebP", async t => {
  const { root, session, api } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const width = 4, pageHeight = 4, channels = 4;
  const first = Buffer.alloc(width * pageHeight * channels), second = Buffer.alloc(width * pageHeight * channels);
  for (let offset = 0; offset < first.length; offset += channels) {
    first[offset] = 255; first[offset + 3] = 255;
    second[offset + 2] = 255; second[offset + 3] = 255;
  }
  const animated = await sharp(Buffer.concat([first, second]), {
    raw: { width, height: pageHeight * 2, channels, pageHeight }
  }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const metadata = await sharp(animated, { animated: true }).metadata(); assert.equal(metadata.pages, 2);
  await assertUnsupported(api, session.recordId, animated);
});

test("图片预览拒绝单边合规但总像素超过 40M 的图片", async t => {
  const { root, session, api } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const oversized = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#336699" } }).png().toBuffer();
  await assertUnsupported(api, session.recordId, oversized);
});

test("附件 owner 查询复用会话 locator 而不重新枚举或解析所有 panel transcript", async t => {
  const root = await tempFixture(t, "panel-attachment-owner-index-");
  const records = [];
  for (let index = 0; index < 12; index++) {
    records.push(await createPanelSession(root, "agent", emptyDocument, { recordId: `record-${index}` }));
  }
  const events: SessionReadIndexEvent[] = [];
  const readIndex = new SessionReadIndex([{ agentId: "agent" }], root, { onEvent: event => events.push(event) });
  await readIndex.initialize();
  const api = new PanelAttachmentApi(root, ["agent"], readIndex);
  const scans = events.filter(event => event.type === "agent_scanned").length;
  const loads = events.filter(event => event.type === "transcript_loaded").length;
  await api.upload(records[7]!.recordId, { fileName: "fixture.txt", mimeType: "text/plain", bytes: Buffer.from("fixture") });
  assert.equal(events.filter(event => event.type === "agent_scanned").length, scans);
  assert.equal(events.filter(event => event.type === "transcript_loaded").length, loads);
});
