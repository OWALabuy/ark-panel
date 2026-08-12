import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryConsolidationStore } from "../src/storage/memory-consolidation.js";
import { tempFixture } from "./test-helpers.js";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("候选不触碰 workspace，后续确认原子替换同一会话文件并推进 checkpoint", async t => {
  const root = await tempFixture(t, "panel-memory-state-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), candidate = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "rev-1", fromEntryId: "u1", throughEntryId: "a2", content: "# Notes\n\n- Safe" });
  assert.equal(await store.checkpoint("record"), undefined); await assert.rejects(readFile(join(workspace, "memory", "anything")), /ENOENT/);
  const ledger = await store.confirm(candidate.batchId, candidate.contentHash, workspace);
  assert.equal(await readFile(join(workspace, ledger.targetPath), "utf8"), "# Notes\n\n- Safe\n"); assert.equal(await store.checkpoint("record"), "a2");
  assert.deepEqual(await store.confirm(candidate.batchId, candidate.contentHash, workspace), ledger);
  const context = await store.context("record", workspace);
  const next = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "rev-2",
    previousCheckpointEntryId: context.checkpointEntryId!, baseContentHash: context.baseContentHash!,
    fromEntryId: "u3", throughEntryId: "a4", content: "# Notes\n\n- Safe\n- Updated" });
  const nextLedger = await store.confirm(next.batchId, next.contentHash, workspace);
  assert.equal(nextLedger.targetPath, ledger.targetPath); assert.equal(await readFile(join(workspace, ledger.targetPath), "utf8"), "# Notes\n\n- Safe\n- Updated\n");
  assert.equal(await store.checkpoint("record"), "a4"); assert.equal((await store.ledgers()).length, 2);
});

test("确认拒绝 hash 篡改与过期候选，且失败不推进 checkpoint", async t => {
  const root = await tempFixture(t, "panel-memory-stale-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), first = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "active", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "first" });
  const competing = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "active", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a2", content: "competing" });
  await assert.rejects(store.confirm(first.batchId, "wrong", workspace), /MEMORY_CANDIDATE_HASH_MISMATCH/); assert.equal(await store.checkpoint("record"), undefined);
  await store.confirm(first.batchId, first.contentHash, workspace); await assert.rejects(store.confirm(competing.batchId, competing.contentHash, workspace), /MEMORY_CANDIDATE_STALE/);
  assert.equal(await store.checkpoint("record"), "a1");
});

test("滚动文件已替换但 state 尚未推进时，重复确认完成崩溃恢复", async t => {
  const root = await tempFixture(t, "panel-memory-recover-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), first = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "first" });
  const firstLedger = await store.confirm(first.batchId, first.contentHash, workspace), context = await store.context("record", workspace);
  const second = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "two",
    previousCheckpointEntryId: context.checkpointEntryId!, baseContentHash: context.baseContentHash!,
    fromEntryId: "u2", throughEntryId: "a2", content: "second" });
  await writeFile(join(workspace, firstLedger.targetPath), second.content + "\n");
  const recovered = await store.confirm(second.batchId, second.contentHash, workspace);
  assert.equal(recovered.throughEntryId, "a2"); assert.equal(await store.checkpoint("record"), "a2");
  assert.equal((await store.ledgers()).length, 2);
});

test("旧版逐 batch 文件作为基线迁移，滚动 state 持久化后安全清理", async t => {
  const root = await tempFixture(t, "panel-memory-migrate-"), data = join(root, "data"), workspace = join(root, "workspace");
  const stateRoot = join(data, "memory", "state"), memoryRoot = join(workspace, "memory"); await mkdir(stateRoot, { recursive: true }); await mkdir(memoryRoot, { recursive: true });
  const recordId = "legacy-record", batchId = "12345678-1234-4123-8123-123456789abc", content = "# Legacy\n\n- Existing";
  const oldPath = "memory/2026-07-22-ark-panel-12345678-1234-4123-8123-123456789abc.md"; await writeFile(join(workspace, oldPath), content + "\n");
  const ledger = { batchId, agentId: "agent", recordId, sourceKind: "panel", sourceRevision: "rev-1", fromEntryId: "u1", throughEntryId: "a1",
    contentHash: hash(content), targetPath: oldPath, createdAt: "2026-07-22T00:00:00.000Z", confirmedAt: "2026-07-22T00:01:00.000Z", status: "confirmed" };
  const statePath = join(stateRoot, `${hash(recordId)}.json`); await writeFile(statePath, JSON.stringify({ version: 1, recordId, checkpointEntryId: "a1", batches: [ledger] }) + "\n");
  const store = new MemoryConsolidationStore(data), context = await store.context(recordId, workspace);
  assert.equal(context.baseContent, content); assert.equal(context.checkpointEntryId, "a1");
  const candidate = await store.createCandidate({ agentId: "agent", recordId, sourceKind: "panel", sourceRevision: "rev-2",
    previousCheckpointEntryId: context.checkpointEntryId!, baseContentHash: context.baseContentHash!,
    fromEntryId: "u2", throughEntryId: "a2", content: "# Legacy\n\n- Existing\n- New" });
  const confirmed = await store.confirm(candidate.batchId, candidate.contentHash, workspace);
  assert.equal(await readFile(join(workspace, confirmed.targetPath), "utf8"), "# Legacy\n\n- Existing\n- New\n");
  await assert.rejects(readFile(join(workspace, oldPath)), /ENOENT/);
  const migrated = JSON.parse(await readFile(statePath, "utf8")) as { version: number; legacyTargets?: unknown };
  assert.equal(migrated.version, 2); assert.equal(migrated.legacyTargets, undefined);
});

test("滚动文件删除后以最后确认的完整候选恢复，保留 checkpoint 且支持无新增重建", async t => {
  const root = await tempFixture(t, "panel-memory-restore-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const firstStore = new MemoryConsolidationStore(data), first = await firstStore.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "# Remembered\n\n- Kept" });
  const ledger = await firstStore.confirm(first.batchId, first.contentHash, workspace); await unlink(join(workspace, ledger.targetPath));
  const store = new MemoryConsolidationStore(data);
  assert.equal(await store.recovery("record", workspace), "restore_or_rebuild");
  await assert.rejects(store.context("record", workspace), /MEMORY_RECOVERY_REQUIRED/);
  const context = await store.context("record", workspace, "restore");
  assert.equal(context.baseContent, first.content); assert.equal(context.checkpointEntryId, "a1"); assert.equal(context.targetState, "absent");
  const recovery = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "one",
    previousCheckpointEntryId: "a1", ...(context.baseContentHash ? { baseContentHash: context.baseContentHash } : {}), fromEntryId: "a1", throughEntryId: "a1", content: context.baseContent!,
    mode: "restore", stateHash: context.stateHash, expectedTargetState: context.targetState });
  await store.confirm(recovery.batchId, recovery.contentHash, workspace);
  assert.equal(await readFile(join(workspace, ledger.targetPath), "utf8"), first.content + "\n"); assert.equal(await store.checkpoint("record"), "a1");
  assert.equal(await store.recovery("record", workspace), "none");
});

test("恢复候选以 state 和缺失目标做 CAS，拒绝生成期间被重新创建的文件", async t => {
  const root = await tempFixture(t, "panel-memory-restore-cas-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), first = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "first" });
  const ledger = await store.confirm(first.batchId, first.contentHash, workspace); await unlink(join(workspace, ledger.targetPath));
  const context = await store.context("record", workspace, "restore"), recovery = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "two",
    previousCheckpointEntryId: "a1", ...(context.baseContentHash ? { baseContentHash: context.baseContentHash } : {}), fromEntryId: "u2", throughEntryId: "a2", content: "updated",
    mode: "restore", stateHash: context.stateHash, expectedTargetState: context.targetState });
  await writeFile(join(workspace, ledger.targetPath), "recreated elsewhere\n");
  await assert.rejects(store.confirm(recovery.batchId, recovery.contentHash, workspace), /MEMORY_TARGET_CONFLICT/);
  assert.equal(await store.checkpoint("record"), "a1");
});

test("恢复快照缺失或不安全时只允许完整会话重建", async t => {
  const root = await tempFixture(t, "panel-memory-rebuild-only-"), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), first = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "first" });
  const ledger = await store.confirm(first.batchId, first.contentHash, workspace); await unlink(join(workspace, ledger.targetPath));
  const candidatePath = join(data, "memory", "candidates", `${first.batchId}.json`), hardlinkPath = join(data, "memory", "candidates", `${first.batchId}.copy`); await link(candidatePath, hardlinkPath);
  assert.equal(await store.recovery("record", workspace), "rebuild_only");
  await assert.rejects(store.context("record", workspace, "restore"), /MEMORY_RECOVERY_SNAPSHOT_UNAVAILABLE/);
  const rebuild = await store.context("record", workspace, "rebuild"); assert.equal(rebuild.baseContent, undefined); assert.equal(rebuild.checkpointEntryId, "a1");
  await unlink(hardlinkPath);
});

test("v1 state 的旧 batch 缺失时可从完整会话重建并迁移到 v2", async t => {
  const root = await tempFixture(t, "panel-memory-v1-rebuild-"), data = join(root, "data"), workspace = join(root, "workspace"), stateRoot = join(data, "memory", "state");
  await mkdir(stateRoot, { recursive: true }); await mkdir(workspace);
  const recordId = "legacy-missing", batchId = "12345678-1234-4123-8123-123456789abc", targetPath = `memory/2026-07-22-ark-panel-${batchId}.md`;
  const ledger = { batchId, agentId: "agent", recordId, sourceKind: "panel", sourceRevision: "rev-1", fromEntryId: "u1", throughEntryId: "a1",
    contentHash: hash("missing legacy"), targetPath, createdAt: "2026-07-22T00:00:00.000Z", confirmedAt: "2026-07-22T00:01:00.000Z", status: "confirmed" };
  const statePath = join(stateRoot, `${hash(recordId)}.json`); await writeFile(statePath, JSON.stringify({ version: 1, recordId, checkpointEntryId: "a1", batches: [ledger] }) + "\n");
  const store = new MemoryConsolidationStore(data); assert.equal(await store.recovery(recordId, workspace), "rebuild_only");
  const context = await store.context(recordId, workspace, "rebuild"), candidate = await store.createCandidate({ agentId: "agent", recordId, sourceKind: "panel", sourceRevision: "rev-2",
    previousCheckpointEntryId: "a1", fromEntryId: "u1", throughEntryId: "a2", content: "rebuilt from full conversation",
    mode: "rebuild", stateHash: context.stateHash, expectedTargetState: context.targetState });
  const confirmed = await store.confirm(candidate.batchId, candidate.contentHash, workspace);
  assert.equal(await readFile(join(workspace, confirmed.targetPath), "utf8"), "rebuilt from full conversation\n");
  const migrated = JSON.parse(await readFile(statePath, "utf8")) as { version: number; checkpointEntryId: string };
  assert.deepEqual({ version: migrated.version, checkpointEntryId: migrated.checkpointEntryId }, { version: 2, checkpointEntryId: "a2" });
});
