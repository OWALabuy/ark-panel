import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import { externalRecordId } from "../src/domain/record-id.js";
import { SessionReadData } from "../src/server/read-data.js";
import { SessionReadIndex, type SessionReadIndexEvent } from "../src/storage/index.js";
import { commitPanelTranscript, createPanelSession, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
import { tempFixture } from "./test-helpers.js";

function uuid(index: number): string { return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`; }
function transcript(id: string, content: string): string {
  return [
    { type: "session", version: 3, id, timestamp: "2026-07-11T00:00:00Z" },
    { type: "message", id: `u-${id}`, parentId: null, message: { role: "user", content } }
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}
function count(events: readonly SessionReadIndexEvent[], type: SessionReadIndexEvent["type"]): number {
  return events.filter(event => event.type === type).length;
}

test("搜索只线性解析候选，暖缓存单条读取不重新枚举且清空后可重建", async t => {
  const root = await tempFixture(t, "panel-index-linear-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const total = 24;
  for (let index = 1; index <= total; index++) {
    const id = uuid(index); await writeFile(join(sessions, `${id}.jsonl`), transcript(id, `linear needle ${index}`));
  }
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    new ConservativeContextBudget(), index);

  assert.equal((await reads.search("needle", "fixture") as unknown[]).length, total);
  assert.equal(count(events, "transcript_loaded"), total, "N 条候选只读取并解析 N 次");
  const listed = await reads.sessions("fixture"), first = listed[0]!;
  const scansBeforeLookup = count(events, "agent_scanned"), loadsBeforeLookup = count(events, "transcript_loaded");
  assert.equal((await reads.conversation(first.recordId) as { recordId: string }).recordId, first.recordId);
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "已定位的单条读取不得重新枚举 agent");
  assert.equal(count(events, "transcript_loaded"), loadsBeforeLookup, "未变的单条读取复用解析结果");
  assert.equal((await reads.updateSession(first.recordId, { title: "sidecar title" })).title, "sidecar title");
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "sidecar 定点更新不得全量枚举");
  assert.equal(count(events, "transcript_loaded"), loadsBeforeLookup, "sidecar 更新不得重读 transcript");
  await assert.rejects(reads.updateSession("unknown-record", { title: "not found" }), /SESSION_NOT_FOUND/);
  assert.equal(count(events, "agent_scanned"), scansBeforeLookup, "未知 record lookup 也不得全量枚举");

  await reads.search("needle", "fixture");
  assert.equal(count(events, "transcript_loaded"), total, "重复搜索只校验指纹，不重读正文");
  const changedId = uuid(1);
  await writeFile(join(sessions, `${changedId}.jsonl`), transcript(changedId, "changed needle"));
  await reads.search("changed", "fixture");
  assert.equal(count(events, "transcript_loaded"), total + 1, "只有变更的 transcript 被重新解析");

  index.clear();
  assert.equal((await reads.search("needle", "fixture") as unknown[]).length, total);
  assert.equal(count(events, "transcript_loaded"), total * 2 + 1, "删除派生状态后从权威来源完整重建");
  await assert.rejects(lstat(join(data, "index.json")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("源修改、reset 重命名和 panel sidecar/transcript 更新使缓存精确失效", async t => {
  const root = await tempFixture(t, "panel-index-invalidation-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const activeId = uuid(31), resetId = uuid(32), activeName = `${activeId}.jsonl`;
  const resetName = `${resetId}.jsonl.reset.2026-07-11T00-00-00Z`;
  await writeFile(join(sessions, activeName), transcript(activeId, "active old"));
  await writeFile(join(sessions, resetName), transcript(resetId, "reset old"));
  const panel = await createPanelSession(data, "fixture", {
    header: { type: "session", version: 3, id: "panel-header" }, entries: [
      { type: "message", id: "panel-u", parentId: null, message: { role: "user", content: "panel old" } }
    ]
  }, { recordId: "panel-record", title: "old title" });
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    new ConservativeContextBudget(), index);
  assert.equal((await reads.sessions("fixture")).length, 3);
  assert.equal(count(events, "transcript_loaded"), 3);

  await updatePanelMetadata(data, "fixture", panel.recordId, current => ({ ...current, title: "new title" }));
  assert.equal((await reads.sessions("fixture")).find(record => record.recordId === panel.recordId)?.title, "new title");
  assert.equal(count(events, "transcript_loaded"), 4, "metadata 指纹变化只重载一条 panel 记录");
  const loaded = await loadPanelSession(data, "fixture", panel.recordId);
  await commitPanelTranscript(data, loaded.metadata, { ...loaded.document, entries: [...loaded.document.entries,
    { type: "message", id: "panel-a", parentId: "panel-u", message: { role: "assistant", content: "panel fresh needle" } }] });
  assert.deepEqual((await reads.search("fresh", "fixture") as Array<{ recordId: string }>).map(item => item.recordId), [panel.recordId]);
  assert.equal(count(events, "transcript_loaded"), 5);

  await writeFile(join(sessions, activeName), transcript(activeId, "active complete") + '{"type":"message"');
  assert.equal((await reads.conversation(externalRecordId("fixture", "active", activeId)) as { messageCount: number }).messageCount, 1,
    "active 尾部半行不得污染已完成记录");
  assert.equal(count(events, "transcript_loaded"), 6);

  const renamed = `${resetId}.jsonl.reset.2026-07-12T00-00-00Z`;
  const oldRecordId = externalRecordId("fixture", "reset", resetName);
  await rename(join(sessions, resetName), join(sessions, renamed));
  const afterRename = await reads.sessions("fixture", null, true);
  assert.equal(afterRename.some(record => record.recordId === oldRecordId), false);
  assert.equal(afterRename.some(record => record.recordId === externalRecordId("fixture", "reset", renamed)), true);
  assert.equal(count(events, "transcript_loaded"), 7, "reset 新 locator 只解析一次");
});

test("并发冷启动共用一次重建且单条坏记录不会污染后续快照", async t => {
  const root = await tempFixture(t, "panel-index-concurrent-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const id = uuid(41); await writeFile(join(sessions, `${id}.jsonl`), transcript(id, "shared needle"));
  const broken = await createPanelSession(data, "fixture", { header: { type: "session", version: 3, id: "broken" }, entries: [] },
    { recordId: "broken" });
  await writeFile(join(data, "sessions", "fixture", broken.recordId, "transcript.jsonl"), "{broken", { mode: 0o600 });
  const events: SessionReadIndexEvent[] = [], diagnostics: string[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data, {
    onEvent: event => events.push(event), onPanelDiagnostic: event => diagnostics.push(event.reason)
  });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    new ConservativeContextBudget(), index);
  const [left, right] = await Promise.all([reads.search("needle"), reads.sessions("fixture")]);
  assert.equal((left as unknown[]).length, 1); assert.equal(right.length, 1);
  assert.equal(count(events, "agent_scanned"), 1); assert.equal(count(events, "transcript_loaded"), 1);
  assert.deepEqual(diagnostics, ["TRANSCRIPT_INVALID"]);
  await reads.sessions("fixture");
  assert.deepEqual(diagnostics, ["TRANSCRIPT_INVALID"], "未变的坏记录按指纹隔离，不反复读取或泄漏内容");
});

test("panel create/update/delete 定点维护 locator，不触发全局会话扫描", async t => {
  const root = await tempFixture(t, "panel-index-mutation-"), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data, { mode: 0o700 });
  const events: SessionReadIndexEvent[] = [];
  const index = new SessionReadIndex([{ agentId: "fixture", sessionsRoot: sessions }], data,
    { onEvent: event => events.push(event) });
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data,
    new ConservativeContextBudget(), index);
  await index.initialize();
  const scans = count(events, "agent_scanned");
  const created = await reads.createPanel("fixture", "created") as { recordId: string };
  assert.equal(count(events, "agent_scanned"), scans);
  assert.equal((await reads.updateSession(created.recordId, { title: "updated", archived: true })).title, "updated");
  assert.equal(count(events, "agent_scanned"), scans);
  assert.deepEqual(await reads.deleteSession(created.recordId, true), { action: "deleted" });
  assert.equal(count(events, "agent_scanned"), scans);
  assert.equal(await reads.conversation(created.recordId), null);
});
