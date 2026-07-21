import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryConsolidationStore } from "../src/storage/memory-consolidation.js";

test("候选不触碰 workspace，确认后只写唯一短期文件并原子推进 checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-state-")), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), candidate = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "panel", sourceRevision: "rev-1", fromEntryId: "u1", throughEntryId: "a2", content: "# Notes\n\n- Safe" });
  assert.equal(await store.checkpoint("record"), undefined); await assert.rejects(readFile(join(workspace, "memory", "anything")), /ENOENT/);
  const ledger = await store.confirm(candidate.batchId, candidate.contentHash, workspace);
  assert.equal(await readFile(join(workspace, ledger.targetPath), "utf8"), "# Notes\n\n- Safe\n"); assert.equal(await store.checkpoint("record"), "a2");
  assert.deepEqual(await store.confirm(candidate.batchId, candidate.contentHash, workspace), ledger); assert.equal((await store.ledgers()).length, 1);
});

test("确认拒绝 hash 篡改与过期候选，且失败不推进 checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-stale-")), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const store = new MemoryConsolidationStore(data), first = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "active", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a1", content: "first" });
  const competing = await store.createCandidate({ agentId: "agent", recordId: "record", sourceKind: "active", sourceRevision: "one", fromEntryId: "u1", throughEntryId: "a2", content: "competing" });
  await assert.rejects(store.confirm(first.batchId, "wrong", workspace), /MEMORY_CANDIDATE_HASH_MISMATCH/); assert.equal(await store.checkpoint("record"), undefined);
  await store.confirm(first.batchId, first.contentHash, workspace); await assert.rejects(store.confirm(competing.batchId, competing.contentHash, workspace), /MEMORY_CANDIDATE_STALE/);
  assert.equal(await store.checkpoint("record"), "a1");
});
