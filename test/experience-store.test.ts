import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ExperienceStore, MAX_STORED_AVATAR_BYTES, validateSettingsPatch } from "../src/server/experience-store.js";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "panel-experience-")); return { root, store: new ExperienceStore(root, ["claude"]) }; }

test("settings 使用严格 schema、局部更新和私有原子持久化", async () => {
  const { root, store } = await fixture();
  assert.deepEqual(await store.settings(), { version: 1, locale: "zh-CN", appearance: { theme: "system", accent: "default" }, conversation: { showStatus: true } });
  assert.deepEqual(await store.patchSettings(validateSettingsPatch({ appearance: { theme: "dark" } })), { version: 1, locale: "zh-CN", appearance: { theme: "dark", accent: "default" }, conversation: { showStatus: true } });
  assert.deepEqual(await store.patchSettings(validateSettingsPatch({ appearance: { accent: "cyan" } })), { version: 1, locale: "zh-CN", appearance: { theme: "dark", accent: "cyan" }, conversation: { showStatus: true } });
  assert.deepEqual(await store.patchSettings(validateSettingsPatch({ locale: "en" })), { version: 1, locale: "en", appearance: { theme: "dark", accent: "cyan" }, conversation: { showStatus: true } });
  assert.deepEqual(await store.patchSettings(validateSettingsPatch({ conversation: { showStatus: false } })), { version: 1, locale: "en", appearance: { theme: "dark", accent: "cyan" }, conversation: { showStatus: false } });
  assert.equal((await lstat(join(root, "settings.json"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), await store.settings());
  assert.throws(() => validateSettingsPatch({ appearance: { theme: "dark", surprise: true } }), /SETTINGS_INVALID/);
  assert.throws(() => validateSettingsPatch({ appearance: { theme: "midnight" } }), /SETTINGS_INVALID/);
  assert.throws(() => validateSettingsPatch({ locale: "fr" }), /SETTINGS_INVALID/);
  assert.throws(() => validateSettingsPatch({ conversation: { showStatus: "yes" } }), /SETTINGS_INVALID/);
  assert.throws(() => validateSettingsPatch({ conversation: { showStatus: true, surprise: true } }), /SETTINGS_INVALID/);
  assert.throws(() => validateSettingsPatch({ version: 1 }), /SETTINGS_UPDATE_EMPTY/);
});

test("并发 settings patch 不丢失不同字段", async () => {
  const { store } = await fixture();
  await Promise.all([
    store.patchSettings(validateSettingsPatch({ appearance: { theme: "gruvbox-dark-medium" } })),
    store.patchSettings(validateSettingsPatch({ appearance: { accent: "yellow" } })),
    store.patchSettings(validateSettingsPatch({ conversation: { showStatus: false } }))
  ]);
  assert.deepEqual(await store.settings(), { version: 1, locale: "zh-CN", appearance: { theme: "gruvbox-dark-medium", accent: "yellow" }, conversation: { showStatus: false } });
});

test("旧 settings 文件缺少 conversation 时采用默认值并在下次更新时迁移", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "settings.json"), JSON.stringify({ version: 1, appearance: { theme: "dark", accent: "green" } }));
  assert.deepEqual(await store.settings(), { version: 1, locale: "zh-CN", appearance: { theme: "dark", accent: "green" }, conversation: { showStatus: true } });
  await store.patchSettings(validateSettingsPatch({ conversation: { showStatus: false } }));
  const reopened = new ExperienceStore(root, ["claude"]);
  assert.deepEqual(await reopened.settings(), { version: 1, locale: "zh-CN", appearance: { theme: "dark", accent: "green" }, conversation: { showStatus: false } });
});

test("损坏或符号链接 settings 不会被静默覆盖", async () => {
  const { root, store } = await fixture(); await writeFile(join(root, "settings.json"), "{}");
  await assert.rejects(store.settings(), /SETTINGS_CORRUPT/);
  const linkedRoot = await mkdtemp(join(tmpdir(), "panel-experience-link-")), outside = join(linkedRoot, "outside.json"); await writeFile(outside, "{}");
  const data = join(linkedRoot, "data"); await mkdir(data); await symlink(outside, join(data, "settings.json"));
  await assert.rejects(new ExperienceStore(data, ["claude"]).settings(), /PANEL_STORAGE_UNSAFE/);
});

test("头像真实解码后统一裁切为 256x256 WebP，并可删除", async () => {
  const { root, store } = await fixture();
  const input = await sharp({ create: { width: 640, height: 320, channels: 3, background: "#cc8844" } }).png().toBuffer();
  const saved = await store.putAvatar("claude", input);
  assert.match(saved.etag, /^"[A-Za-z0-9_-]+"$/); assert.equal(saved.etag, `"${createHash("sha256").update(saved.bytes).digest("base64url")}"`);
  const metadata = await sharp(saved.bytes).metadata(); assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
  const path = join(root, "avatars", createHash("sha256").update("claude").digest("hex") + ".webp"); assert.equal((await lstat(path)).mode & 0o777, 0o600); assert.equal((await lstat(join(root, "avatars"))).mode & 0o777, 0o700);
  assert.deepEqual(await store.avatar("claude"), saved); assert.equal(await store.deleteAvatar("claude"), true); assert.equal(await store.avatar("claude"), undefined); assert.equal(await store.deleteAvatar("claude"), false);
});

test("头像拒绝非 allowlist、伪图片、SVG、动图和超大尺寸", async () => {
  const { store } = await fixture(); const one = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(store.putAvatar("unknown", one), /AGENT_NOT_ALLOWED/);
  await assert.rejects(store.putAvatar("claude", Buffer.from("not an image")), /AVATAR_INVALID/);
  await assert.rejects(store.putAvatar("claude", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')), /AVATAR_INVALID/);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"); await assert.rejects(store.putAvatar("claude", gif), /AVATAR_INVALID/);
  const tooWide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } }).png().toBuffer(); await assert.rejects(store.putAvatar("claude", tooWide), /AVATAR_INVALID/);
});

test("头像目录若被替换为符号链接则拒绝读写删除", async () => {
  const { root, store } = await fixture(), outside = await mkdtemp(join(tmpdir(), "panel-avatar-outside-")); await symlink(outside, join(root, "avatars"));
  const input = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(store.putAvatar("claude", input), /PANEL_STORAGE_UNSAFE/); await assert.rejects(store.avatar("claude"), /PANEL_STORAGE_UNSAFE/); await assert.rejects(store.deleteAvatar("claude"), /PANEL_STORAGE_UNSAFE/);
});

test("读取头像前拒绝超大或非普通持久文件", async () => {
  const { root, store } = await fixture(); await mkdir(join(root, "avatars"));
  const path = join(root, "avatars", createHash("sha256").update("claude").digest("hex") + ".webp");
  await writeFile(path, Buffer.alloc(MAX_STORED_AVATAR_BYTES + 1)); await assert.rejects(store.avatar("claude"), /AVATAR_STORAGE_INVALID/);
  await rm(path); await mkdir(path); await assert.rejects(store.avatar("claude"), /AVATAR_STORAGE_INVALID/);
});

test("同毫秒并发头像写入使用互不冲突的临时文件", async () => {
  const { store } = await fixture(); const input = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
  await Promise.all(Array.from({ length: 8 }, () => store.putAvatar("claude", input)));
  const avatar = await store.avatar("claude"); assert.ok(avatar); assert.equal((await sharp(avatar.bytes).metadata()).format, "webp");
});
