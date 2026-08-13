import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unregisterAndClean } from "../src/gateway/artifact-cleanup.js";
import type { GatewayClient } from "../src/gateway/adapter.js";
import { tempFixture } from "./test-helpers.js";

function client(version = "2026.6.11"): GatewayClient & { deleted: string[] } {
  const deleted: string[] = [];
  return { deleted, async version() { return version; }, async deleteSession(key) { deleted.push(key); },
    async createSession() { throw new Error("unused"); }, async send() { throw new Error("unused"); }, async waitForCompletion() {}, async abort() {} };
}

test("先官方注销，再只删除 allowlist 根目录内已知 artifacts", async t => {
  const root = await tempFixture(t, "panel-clean-");
  const sessions = join(root, "sessions"); await mkdir(sessions);
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(sessions, `${id}.jsonl.deleted.2026-07-11T00:00:00Z`), "x");
  await writeFile(join(sessions, `${id}.trajectory.jsonl`), "x");
  await writeFile(join(sessions, "unrelated.jsonl"), "x");
  const gateway = client();
  const removed = await unregisterAndClean(gateway, { runtimeAgentId: "panel-runtime-claude", sessionId: id,
    sessionKey: "agent:panel-runtime-claude:test", runtimeSessionsRoot: sessions,
    allowedRuntimeRoots: new Map([["panel-runtime-claude", sessions]]) });
  assert.equal(gateway.deleted.length, 1);
  assert.equal(removed.length, 2);
});

test("版本不符时不注销、不清理", async t => {
  const root = await tempFixture(t, "panel-clean-"); const sessions = join(root, "sessions"); await mkdir(sessions);
  const gateway = client("2026.7.0");
  await assert.rejects(unregisterAndClean(gateway, { runtimeAgentId: "runtime", sessionId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "key", runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]) }), /UNSUPPORTED/);
  assert.equal(gateway.deleted.length, 0);
});

test("未知同 sessionId 文件或符号链接会使清理失败", async t => {
  const root = await tempFixture(t, "panel-clean-"); const sessions = join(root, "sessions"); await mkdir(sessions);
  const id = "11111111-1111-4111-8111-111111111111";
  await symlink("/tmp", join(sessions, `${id}.unknown`));
  await assert.rejects(unregisterAndClean(client(), { runtimeAgentId: "runtime", sessionId: id, sessionKey: "key",
    runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]) }), /未知/);
});

test("固定 runtime root 身份在官方注销前后都必须保持", async t => {
  const root = await tempFixture(t, "panel-clean-"), sessions = join(root, "sessions"); await mkdir(sessions);
  const stat = await lstat(sessions, { bigint: true }), expectedRuntimeRootIdentity = { dev: stat.dev, ino: stat.ino };
  const id = "11111111-1111-4111-8111-111111111111", replacement = join(root, "replacement"); await mkdir(replacement);
  const before = client();
  await assert.rejects(unregisterAndClean(before, { runtimeAgentId: "runtime", sessionId: id, sessionKey: "key",
    runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]),
    expectedRuntimeRootIdentity: { ...expectedRuntimeRootIdentity, ino: expectedRuntimeRootIdentity.ino + 1n } }), /不安全/u);
  assert.equal(before.deleted.length, 0);

  const after = client(); after.deleteSession = async key => {
    after.deleted.push(key); await rename(sessions, join(root, "original")); await rename(replacement, sessions);
  };
  await assert.rejects(unregisterAndClean(after, { runtimeAgentId: "runtime", sessionId: id, sessionKey: "key",
    runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]), expectedRuntimeRootIdentity }), /不安全/u);
  assert.equal(after.deleted.length, 1);
});
