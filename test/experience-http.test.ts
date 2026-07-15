import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createPanelServer } from "../src/server/app.js";
import { passwordHash } from "../src/server/auth.js";
import { ExperienceStore, MAX_AVATAR_BYTES } from "../src/server/experience-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-experience-http-")), publicDir = join(root, "public"), dataRoot = join(root, "data");
  await import("node:fs/promises").then(fs => Promise.all([fs.mkdir(publicDir), fs.mkdir(dataRoot)])); await writeFile(join(publicDir, "index.html"), "ok");
  const server = createPanelServer({ auth: { username: "owl", passwordHash: passwordHash("correct", "0011223344556677"), sessionSecret: "test-secret-long-enough" }, publicDir, experience: new ExperienceStore(dataRoot, ["claude"]) });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username: "owl", password: "correct" }) });
  const loginBody = await login.json() as { data: { csrfToken: string } }, cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  return { server, base, cookie, csrf: loginBody.data.csrfToken };
}

test("settings HTTP 要求登录和 CSRF，并拒绝未知字段", async t => {
  const x = await fixture(); t.after(() => x.server.close());
  assert.equal((await fetch(`${x.base}/api/v1/settings`)).status, 401);
  assert.deepEqual((await (await fetch(`${x.base}/api/v1/settings`, { headers: { cookie: x.cookie } })).json()).data, { version: 1, appearance: { theme: "system", accent: "default" } });
  const noCsrf = await fetch(`${x.base}/api/v1/settings`, { method: "PATCH", headers: { cookie: x.cookie, origin: x.base, "content-type": "application/json" }, body: JSON.stringify({ appearance: { theme: "dark" } }) }); assert.equal(noCsrf.status, 403);
  const headers = { cookie: x.cookie, origin: x.base, "x-csrf-token": x.csrf, "content-type": "application/json" };
  const invalid = await fetch(`${x.base}/api/v1/settings`, { method: "PATCH", headers, body: JSON.stringify({ appearance: { theme: "dark", unknown: true } }) }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "SETTINGS_INVALID");
  const updated = await fetch(`${x.base}/api/v1/settings`, { method: "PATCH", headers, body: JSON.stringify({ appearance: { theme: "dark" } }) }); assert.equal(updated.status, 200); assert.equal((await updated.json()).data.appearance.theme, "dark");
});

test("avatar HTTP 校验 allowlist、流式上限、真实格式、缓存与删除", async t => {
  const x = await fixture(); t.after(() => x.server.close());
  const image = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123456" } }).jpeg().toBuffer();
  assert.equal((await fetch(`${x.base}/api/v1/agents/claude/avatar`)).status, 401);
  assert.equal((await fetch(`${x.base}/api/v1/agents/claude/avatar`, { method: "PUT", headers: { cookie: x.cookie, origin: x.base }, body: new Uint8Array(image) })).status, 403);
  const writeHeaders = { cookie: x.cookie, origin: x.base, "x-csrf-token": x.csrf, "content-type": "application/octet-stream" };
  const unknown = await fetch(`${x.base}/api/v1/agents/unknown/avatar`, { method: "PUT", headers: writeHeaders, body: new Uint8Array(image) }); assert.equal(unknown.status, 403); assert.equal((await unknown.json()).error.code, "AGENT_NOT_ALLOWED");
  const fake = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { method: "PUT", headers: { ...writeHeaders, "content-type": "image/png" }, body: "fake" }); assert.equal(fake.status, 400); assert.equal((await fake.json()).error.code, "AVATAR_INVALID");
  const oversized = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { method: "PUT", headers: writeHeaders, body: new Uint8Array(MAX_AVATAR_BYTES + 1) }); assert.equal(oversized.status, 413); const oversizedError = (await oversized.json()).error; assert.equal(oversizedError.code, "AVATAR_TOO_LARGE"); assert.equal(oversizedError.message, "头像文件不能超过 5 MiB");
  const put = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { method: "PUT", headers: writeHeaders, body: new Uint8Array(image) }); assert.equal(put.status, 200);
  const get = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { headers: { cookie: x.cookie } }); assert.equal(get.status, 200); assert.equal(get.headers.get("content-type"), "image/webp"); assert.equal(get.headers.get("x-content-type-options"), "nosniff"); assert.equal(get.headers.get("cache-control"), "private, no-cache"); const etag = get.headers.get("etag"); assert.ok(etag); const metadata = await sharp(Buffer.from(await get.arrayBuffer())).metadata(); assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
  const cached = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { headers: { cookie: x.cookie, "if-none-match": etag! } }); assert.equal(cached.status, 304);
  const removed = await fetch(`${x.base}/api/v1/agents/claude/avatar`, { method: "DELETE", headers: writeHeaders }); assert.equal(removed.status, 200); assert.equal((await fetch(`${x.base}/api/v1/agents/claude/avatar`, { headers: { cookie: x.cookie } })).status, 404);
});
