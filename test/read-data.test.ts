import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionReadData } from "../src/server/read-data.js";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import { updatePanelMetadata } from "../src/storage/panel-sessions.js";

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
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data, new ConservativeContextBudget(10_000));
  const listed = await reads.sessions("fixture"); assert.deepEqual(listed.map(item => item.sourceKind).sort(), ["active", "reset"]);
  assert.equal(listed.find(item => item.sourceKind === "active")!.messageCount, 2);
  const conversation = await reads.conversation(listed.find(item => item.sourceKind === "active")!.recordId) as { status: Record<string, unknown>; document: { header: Record<string, unknown>; entries: unknown[] } };
  assert.equal(conversation.document.entries.length, 2);
  assert.equal("cwd" in conversation.document.header, false); assert.equal("unknownSecret" in conversation.document.header, false);
  assert.deepEqual({ modelOverride: conversation.status.modelOverride, thinkingLevel: conversation.status.thinkingLevel, reasoningLevel: conversation.status.reasoningLevel }, { modelOverride: null, thinkingLevel: null, reasoningLevel: null });
  assert.equal((conversation.status.contextBudget as { budgetTokens: number }).budgetTokens, 10_000); assert.equal(typeof (conversation.status.contextBudget as { percentage: unknown }).percentage, "number");
  assert.equal("cwd" in conversation.status, false); assert.equal(JSON.stringify(conversation.status).includes("needle private fixture"), false);
  const found = await reads.search("needle", "fixture") as unknown[]; assert.equal(found.length, 2);

  const activeRecord = listed.find(item => item.sourceKind === "active")!;
  await reads.updateSession(activeRecord.recordId, { title: "只读标题", archived: true });
  assert.equal((await reads.sessions("fixture")).some(item => item.recordId === activeRecord.recordId), false);
  const archived = await reads.sessions("fixture", true); assert.equal(archived.find(item => item.recordId === activeRecord.recordId)?.title, "只读标题");
  await reads.updateSession(activeRecord.recordId, { archived: false });
  assert.equal((await reads.sessions("fixture")).find(item => item.recordId === activeRecord.recordId)?.title, "只读标题");
  await reads.updateSession(activeRecord.recordId, { pinned: true, project: "Ark Panel" });
  const organized = await reads.sessions("fixture");
  assert.equal(organized[0]?.recordId, activeRecord.recordId); assert.equal(organized[0]?.pinned, true); assert.equal(organized[0]?.project, "Ark Panel");
  await reads.updateSession(activeRecord.recordId, { project: null });
  assert.equal((await reads.sessions("fixture"))[0]?.project, undefined);
  await assert.rejects(reads.updateSession(activeRecord.recordId, { project: "bad\nproject" }), /SESSION_PROJECT_INVALID/);

  const sourceBeforeHide = await readFile(activePath, "utf8");
  assert.deepEqual(await reads.deleteSession(activeRecord.recordId, true), { action: "hidden" });
  assert.equal((await reads.sessions("fixture")).some(item => item.recordId === activeRecord.recordId), false);
  assert.equal((await reads.sessions("fixture", true)).some(item => item.recordId === activeRecord.recordId), false);
  assert.equal(await readFile(activePath, "utf8"), sourceBeforeHide, "隐藏只读会话不得修改源 transcript");

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

test("面板会话要求显式确认并先归档才可永久删除", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-delete-")), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data); const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data);
  const created = await reads.createPanel("fixture") as { recordId: string };
  await assert.rejects(reads.deleteSession(created.recordId, false), /SESSION_DELETE_CONFIRMATION_REQUIRED/);
  await assert.rejects(reads.deleteSession(created.recordId, true), /SESSION_NOT_ARCHIVED/);
  await reads.updateSession(created.recordId, { archived: true });
  assert.deepEqual(await reads.deleteSession(created.recordId, true), { action: "deleted" });
  assert.equal(await reads.conversation(created.recordId), null);
});

test("面板会话状态只暴露 override、预算估算和活跃时间", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-status-")), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data); const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data, new ConservativeContextBudget(1_024));
  const created = await reads.createPanel("fixture", "status") as { recordId: string };
  await updatePanelMetadata(data, "fixture", created.recordId, current => ({ ...current, modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" }));
  const conversation = await reads.conversation(created.recordId) as { status: { modelOverride: string | null; thinkingLevel: string | null; reasoningLevel: string | null; contextBudget: { percentage: number; method: string }; lastActiveAt: string } };
  assert.equal(conversation.status.modelOverride, "provider/model"); assert.equal(conversation.status.thinkingLevel, "high"); assert.equal(conversation.status.reasoningLevel, "stream");
  assert.equal(conversation.status.contextBudget.method, "utf8-bytes-upper-bound-v2"); assert.equal(Number.isInteger(conversation.status.contextBudget.percentage), true); assert.match(conversation.status.lastActiveAt, /^\d{4}-/);
});

test("project 目录汇总正常与归档会话、忽略大小写重复和隐藏来源", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-projects-")), sessions = join(root, "source"), data = join(root, "data");
  await mkdir(sessions); await mkdir(data);
  const activeId = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(sessions, `${activeId}.jsonl`), jsonl(user));
  await writeFile(join(sessions, `${activeId}.jsonl.reset.2026-07-10T00-00-00Z`), jsonl(user));
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: sessions }], data);
  const records = await reads.sessions("fixture"); const active = records.find(item => item.sourceKind === "active")!, reset = records.find(item => item.sourceKind === "reset")!;
  await reads.updateSession(active.recordId, { project: "Project Alpha" });
  await reads.updateSession(reset.recordId, { project: "project alpha", archived: true });
  assert.deepEqual(await reads.projects("fixture"), ["Project Alpha"]);
  await reads.updateSession(active.recordId, { project: "Hidden Only" });
  await reads.deleteSession(active.recordId, true);
  assert.deepEqual(await reads.projects("fixture"), ["project alpha"]);
});

test("sessions 根目录本身是符号链接时拒绝读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-read-link-")), actual = join(root, "actual"), link = join(root, "link"), data = join(root, "data");
  await mkdir(actual); await mkdir(data); await symlink(actual, link);
  const reads = new SessionReadData([{ agentId: "fixture", sessionsRoot: link }], data);
  await assert.rejects(reads.sessions(), /根目录不安全/);
});
