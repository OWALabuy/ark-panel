import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import { createPanelSession, loadPanelSession } from "../src/storage/panel-sessions.js";
import { PanelCompactionApi } from "../src/server/compaction-api.js";
import { SessionOperationCoordinator } from "../src/server/session-operation.js";

function revision(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

test("compact 使用当前 overrides、只原子追加实际减少有效上下文的 entry，并拒绝 revision race", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-api-")), operations = new SessionOperationCoordinator();
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPanelSession(root, "agent", { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old fictional context ".repeat(400) } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "kept fictional tail" } }
  ] }, { recordId: "record" });
  const seen: unknown[] = [], entry = { type: "compaction", id: "c1", parentId: "a1", summary: "short fictional summary", firstKeptEntryId: "a1", tokensBefore: 12 };
  const api = new PanelCompactionApi({ async compact(request) { seen.push(request); return { compacted: true, entry }; } },
    { dataRoot: root, runtimeByAgent: new Map([["agent", "runtime"]]), contextBudget: new ConservativeContextBudget(20_000), operations });
  const result = await api.compact("record");
  assert.equal(result.compacted, true); assert.equal((await loadPanelSession(root, "agent", "record")).document.entries.at(-1)?.type, "compaction");
  assert.equal((seen[0] as { runtimeAgentId: string }).runtimeAgentId, "runtime");
  await assert.rejects(api.compact("record", "stale"), /REVISION_CONFLICT/);
});

test("保留根节点起全部历史并额外加入摘要时拒绝采纳，transcript 与 revision 不变", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-no-reduction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPanelSession(root, "agent", { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "fictional prompt ".repeat(100) } },
    { type: "message", id: "a1", parentId: "u1", message: {
      role: "assistant", content: "fictional answer", usage: { input: 0, output: 0, total: 0 }
    } }
  ] }, { recordId: "record" });
  const transcriptPath = join(root, "sessions", "agent", "record", "transcript.jsonl");
  const beforeContent = await readFile(transcriptPath, "utf8"), beforeRevision = revision(await lstat(transcriptPath));
  const api = new PanelCompactionApi({ async compact() { return { compacted: true, entry: {
    type: "compaction", id: "c1", parentId: "a1", summary: "fictional summary",
    firstKeptEntryId: "u1", tokensBefore: 0
  } }; } }, { dataRoot: root, runtimeByAgent: new Map([["agent", "runtime"]]), contextBudget: new ConservativeContextBudget(20_000) });

  const result = await api.compact("record", beforeRevision);

  assert.deepEqual(result, { compacted: false, revision: beforeRevision, reason: "NO_EFFECTIVE_REDUCTION" });
  assert.equal(await readFile(transcriptPath, "utf8"), beforeContent);
  assert.equal(revision(await lstat(transcriptPath)), beforeRevision);
  assert.equal((await loadPanelSession(root, "agent", "record")).document.entries.length, 2);
});

test("compact 与生成互斥时立即 SESSION_BUSY，不排队", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-busy-")), operations = new SessionOperationCoordinator();
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPanelSession(root, "agent", { header: { type: "session" }, entries: [{ type: "message", id: "u", parentId: null, message: { role: "user" } }] }, { recordId: "record" });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const running = operations.runGeneration("record", async () => await gate);
  const api = new PanelCompactionApi({ async compact() { return { compacted: false }; } },
    { dataRoot: root, runtimeByAgent: new Map([["agent", "runtime"]]), operations });
  await assert.rejects(api.compact("record"), /SESSION_BUSY/); release(); await running;
});
