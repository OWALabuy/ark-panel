import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionReadData } from "../src/server/read-data.js";

const header = { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-07-11T00:00:00Z", cwd: "/private/workspace", unknownSecret: "must-not-leak" };
const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-07-11T00:00:01Z", message: { role: "user", content: "needle private fixture" } };
const assistant = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-11T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "fixture reply" }], stopReason: "stop" } };
const jsonl = (...entries: object[]) => [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n";

test("只读扫描 active/reset/panel，容忍 active 半行并拒绝符号链接来源", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-")), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data);
  const activeId = "11111111-1111-4111-8111-111111111111", linkedId = "22222222-2222-4222-8222-222222222222";
  const activePath = join(sessions, `${activeId}.jsonl`); await writeFile(activePath, jsonl(user, assistant) + '{"type":"message"');
  await writeFile(join(sessions, `${activeId}.jsonl.reset.2026-07-11T00-00-00Z`), jsonl(user));
  const outside = join(root, "outside.jsonl"); await writeFile(outside, jsonl(user)); await symlink(outside, join(sessions, `${linkedId}.jsonl`));
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data);
  const listed = await reads.sessions("fixture"); assert.deepEqual(listed.map(item => item.sourceKind).sort(), ["active", "reset"]);
  assert.equal(listed.find(item => item.sourceKind === "active")!.messageCount, 2);
  const conversation = await reads.conversation(listed.find(item => item.sourceKind === "active")!.recordId) as { document: { header: Record<string, unknown>; entries: unknown[] } };
  assert.equal(conversation.document.entries.length, 2);
  assert.equal("cwd" in conversation.document.header, false); assert.equal("unknownSecret" in conversation.document.header, false);
  const found = await reads.search("needle", "fixture") as unknown[]; assert.equal(found.length, 2);

  const activeRecord = listed.find(item => item.sourceKind === "active")!;
  await reads.updateSession(activeRecord.recordId, { title: "只读标题", archived: true });
  assert.equal((await reads.sessions("fixture")).some(item => item.recordId === activeRecord.recordId), false);
  const archived = await reads.sessions("fixture", true); assert.equal(archived.find(item => item.recordId === activeRecord.recordId)?.title, "只读标题");
  await reads.updateSession(activeRecord.recordId, { archived: false });
  assert.equal((await reads.sessions("fixture")).find(item => item.recordId === activeRecord.recordId)?.title, "只读标题");

  const before = await readFile(activePath, "utf8");
  const forked = await reads.fork(listed.find(item => item.sourceKind === "active")!.recordId, "a1") as { recordId: string };
  const afterFork = await reads.sessions("fixture"); assert.ok(afterFork.some(item => item.recordId === forked.recordId && item.sourceKind === "panel"));
  const forkConversation = await reads.conversation(forked.recordId) as { document: { header: { panel?: { recordId?: string } } } };
  assert.equal(forkConversation.document.header.panel?.recordId, forked.recordId);
  const edited = await reads.editAndFork(listed.find(item => item.sourceKind === "active")!.recordId, "u1", "replacement") as { recordId: string };
  const editedConversation = await reads.conversation(edited.recordId) as { document: { entries: Array<{ message?: { content?: unknown } }> } };
  assert.equal(editedConversation.document.entries.at(-1)?.message?.content, "replacement");
  assert.equal(await readFile(activePath, "utf8"), before, "派生操作不得写源 transcript");
});

test("sessions 根目录本身是符号链接时拒绝读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-link-")), actual = join(root, "actual"), link = join(root, "link"), data = join(root, "data");
  await mkdir(actual); await mkdir(data); await symlink(actual, link);
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: link }], data);
  await assert.rejects(reads.sessions(), /根目录不安全/);
});
