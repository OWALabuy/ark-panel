import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unregisterAndClean } from "../src/gateway/artifact-cleanup.js";
import type { GatewayClient } from "../src/gateway/adapter.js";

function client(version = "2026.6.11"): GatewayClient & { deleted: string[] } {
  const deleted: string[] = [];
  return { deleted, async version() { return version; }, async deleteSession(key) { deleted.push(key); },
    async createSession() { throw new Error("unused"); }, async send() { throw new Error("unused"); }, async waitForCompletion() {}, async abort() {} };
}

test("先官方注销，再只删除 allowlist 根目录内已知 artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-clean-"));
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

test("版本不符时不注销、不清理", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-clean-")); const sessions = join(root, "sessions"); await mkdir(sessions);
  const gateway = client("2026.7.0");
  await assert.rejects(unregisterAndClean(gateway, { runtimeAgentId: "runtime", sessionId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "key", runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]) }), /UNSUPPORTED/);
  assert.equal(gateway.deleted.length, 0);
});

test("未知同 sessionId 文件或符号链接会使清理失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-clean-")); const sessions = join(root, "sessions"); await mkdir(sessions);
  const id = "11111111-1111-4111-8111-111111111111";
  await symlink("/tmp", join(sessions, `${id}.unknown`));
  await assert.rejects(unregisterAndClean(client(), { runtimeAgentId: "runtime", sessionId: id, sessionKey: "key",
    runtimeSessionsRoot: sessions, allowedRuntimeRoots: new Map([["runtime", sessions]]) }), /未知/);
});
