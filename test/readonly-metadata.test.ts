import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReadonlyMetadata, updateReadonlyMetadata, type ReadonlySourceIdentity } from "../src/storage/readonly-metadata.js";

test("只读 sidecar 默认安全，并发更新不丢字段且不使用来源名作为文件名", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-meta-"));
  const identity: ReadonlySourceIdentity = { sourceKind: "reset", agentId: "fixture", sourceSessionId: "11111111-1111-4111-8111-111111111111", resetTimestamp: "2026-07-11T00-00-00Z" };
  const initial = await loadReadonlyMetadata(root, identity); assert.equal(initial.archived, false); assert.equal(initial.memoryDisposition, "scratch");
  await Promise.all([
    updateReadonlyMetadata(root, identity, value => ({ ...value, title: "新标题" })),
    updateReadonlyMetadata(root, identity, value => ({ ...value, archived: true }))
  ]);
  const loaded = await loadReadonlyMetadata(root, identity); assert.equal(loaded.title, "新标题"); assert.equal(loaded.archived, true);
  const manifest = await import("node:fs/promises").then(fs => fs.readdir(join(root, "readonly-meta", "fixture")));
  assert.equal(manifest.length, 1); assert.match(manifest[0]!, /^[a-f0-9]{64}\.json$/); assert.doesNotMatch(manifest[0]!, /11111111/);
  assert.equal((JSON.parse(await readFile(join(root, "readonly-meta", "fixture", manifest[0]!), "utf8")) as { sourceSessionId: string }).sourceSessionId, identity.sourceSessionId);
});

test("只读 sidecar 拒绝通过符号链接目录写出 dataRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-meta-link-")), outside = join(root, "outside"), data = join(root, "data");
  await mkdir(outside); await mkdir(data); await symlink(outside, join(data, "readonly-meta"));
  const identity: ReadonlySourceIdentity = { sourceKind: "active", agentId: "fixture", sourceSessionId: "11111111-1111-4111-8111-111111111111" };
  await assert.rejects(updateReadonlyMetadata(data, identity, value => ({ ...value, archived: true })), /目录不安全/);
  assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(outside)), []);
});
