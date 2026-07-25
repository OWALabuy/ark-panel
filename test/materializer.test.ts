import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBridgeMaterializer } from "../src/gateway/materializer.js";
import { parseTranscript } from "../src/domain/transcript.js";

test("物化旧会话时刷新临时 transcript 时间，避免 OpenClaw 按日 rollover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "panel-materializer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "22222222-2222-4222-8222-222222222222.jsonl");
  const materializer = new FileBridgeMaterializer(() => new Date("2026-07-13T08:00:00.000Z"));
  await materializer.replaceCreatedTranscript({
    sessionId: "22222222-2222-4222-8222-222222222222",
    sessionKey: "agent:runtime:panel-fixture",
    transcriptPath
  }, {
    header: { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-07-12T00:00:00.000Z" },
    entries: [{ type: "message", message: { role: "assistant", content: "history" } }]
  });
  const document = parseTranscript(await readFile(transcriptPath, "utf8"));
  assert.equal(document.header.id, "22222222-2222-4222-8222-222222222222");
  assert.equal(document.header.timestamp, "2026-07-13T08:00:00.000Z");
  assert.equal(document.entries.length, 1);
});

test("移除 gateway 重复 user entry，并把第一层 parentId 接回 panel user", () => {
  const materializer = new FileBridgeMaterializer();
  const result = materializer.verifyAndStripSubmittedUser([
    { type: "thinking_level_change", level: "high" },
    { type: "message", id: "gateway-user", parentId: "old-assistant", message: { role: "user", content: "虚构问题" } },
    { type: "message", id: "assistant", parentId: "gateway-user", message: { role: "assistant", content: [{ type: "text", text: "虚构回答" }] } }
  ], "虚构问题", "panel-user");
  assert.equal(result.length, 2);
  assert.equal(result[1]?.parentId, "panel-user");
});

test("只采纳保持完整历史前缀和合法 keepRecentTokens 边界的唯一 compaction", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-materializer-")); t.after(() => rm(root, { recursive: true, force: true }));
  const created = { sessionId: "22222222-2222-4222-8222-222222222222", sessionKey: "agent:runtime:key",
    transcriptPath: join(root, "22222222-2222-4222-8222-222222222222.jsonl") };
  const history = { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } },
    { type: "model_change", id: "m1", parentId: "a1", modelId: "fixture" }
  ] };
  const materializer = new FileBridgeMaterializer(); await materializer.replaceCreatedTranscript(created, history);
  const compact = { type: "compaction", id: "c1", parentId: "m1", timestamp: "2026-07-24T12:00:00.000Z",
    summary: "summary", firstKeptEntryId: "m1", tokensBefore: 42 };
  await appendFile(created.transcriptPath, `${JSON.stringify(compact)}\n`);
  assert.deepEqual(await materializer.readAndVerifyCompaction(created, history), compact);
  await appendFile(created.transcriptPath, `${JSON.stringify({ ...compact, id: "c2", parentId: "c1" })}\n`);
  await assert.rejects(materializer.readAndVerifyCompaction(created, history), /REWRITE_UNSUPPORTED/);
});

test("拒绝 compaction 改写时只诊断结构，不记录消息正文、摘要、ID 或路径", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-diagnostic-")); t.after(() => rm(root, { recursive: true, force: true }));
  const created = { sessionId: "22222222-2222-4222-8222-222222222222", sessionKey: "agent:runtime:key",
    transcriptPath: join(root, "22222222-2222-4222-8222-222222222222.jsonl") };
  const events: unknown[] = [], materializer = new FileBridgeMaterializer(() => new Date("2026-07-25T00:00:00.000Z"), event => events.push(event));
  const history = { header: { type: "session" }, entries: [
    { type: "message", id: "private-user-id", parentId: null, message: { role: "user", content: "private prompt fixture" } }
  ] };
  await materializer.replaceCreatedTranscript(created, history);
  await appendFile(created.transcriptPath, `${JSON.stringify({
    type: "compaction", id: "private-compaction-id", parentId: "private-user-id",
    timestamp: "2026-07-25T00:01:00.000Z", summary: "private summary fixture",
    firstKeptEntryId: "private-user-id", tokensBefore: 100
  })}\n${JSON.stringify({ type: "custom", id: "private-extra-id", parentId: "private-compaction-id", data: "private hook fixture" })}\n`);
  await assert.rejects(materializer.readAndVerifyCompaction(created, history), /REWRITE_UNSUPPORTED/);
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.match(serialized, /compaction_rewrite_rejected/);
  assert.match(serialized, /"expectedHistoricalEntries":1/);
  assert.match(serialized, /"actualEntries":3/);
  assert.match(serialized, /"type":"compaction"/);
  assert.match(serialized, /"type":"custom"/);
  assert.doesNotMatch(serialized, /private|22222222|panel-compact-diagnostic|agent:runtime/);
});

test("只丢弃严格验证的 OpenClaw compaction runtime prelude 并把摘要接回面板叶节点", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-prelude-")); t.after(() => rm(root, { recursive: true, force: true }));
  const created = { sessionId: "22222222-2222-4222-8222-222222222222", sessionKey: "agent:runtime:key",
    transcriptPath: join(root, "22222222-2222-4222-8222-222222222222.jsonl") };
  const history = { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } }
  ] };
  const materializer = new FileBridgeMaterializer(); await materializer.replaceCreatedTranscript(created, history);
  const thinking = { type: "thinking_level_change", id: "thinking", parentId: "a1",
    timestamp: "2026-07-25T00:00:00.000Z", thinkingLevel: "high" };
  const snapshot = { type: "custom", id: "snapshot", parentId: "thinking", timestamp: "2026-07-25T00:00:01.000Z",
    customType: "model-snapshot", data: { timestamp: 1784937601000, provider: "fixture", modelApi: "fixture-api", modelId: "fixture-model" } };
  const compact = { type: "compaction", id: "compact", parentId: "snapshot", timestamp: "2026-07-25T00:00:02.000Z",
    summary: "summary", firstKeptEntryId: "compact", tokensBefore: 42, details: { fixture: true }, fromHook: false };
  await appendFile(created.transcriptPath, `${JSON.stringify(thinking)}\n${JSON.stringify(snapshot)}\n${JSON.stringify(compact)}\n`);
  assert.deepEqual(await materializer.readAndVerifyCompaction(created, history), { ...compact, parentId: "a1" });
});

test("拒绝伪造、越权字段、断链或乱序的 compaction runtime prelude", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-prelude-deny-")); t.after(() => rm(root, { recursive: true, force: true }));
  const created = { sessionId: "22222222-2222-4222-8222-222222222222", sessionKey: "agent:runtime:key",
    transcriptPath: join(root, "22222222-2222-4222-8222-222222222222.jsonl") };
  const history = { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } }
  ] };
  const validSnapshot = { type: "custom", id: "snapshot", parentId: "u1", timestamp: "2026-07-25T00:00:01.000Z",
    customType: "model-snapshot", data: { timestamp: 1784937601000, provider: "fixture", modelApi: "fixture-api", modelId: "fixture-model" } };
  const compact = { type: "compaction", id: "compact", parentId: "snapshot", timestamp: "2026-07-25T00:00:02.000Z",
    summary: "summary", firstKeptEntryId: "compact", tokensBefore: 42 };
  const invalidPreludes = [
    [{ ...validSnapshot, customType: "unknown" }],
    [{ ...validSnapshot, secret: "not allowed" }],
    [{ ...validSnapshot, parentId: "wrong" }],
    [{ type: "thinking_level_change", id: "thinking", parentId: "u1", timestamp: "2026-07-25T00:00:00.000Z", thinkingLevel: "high" },
      { type: "thinking_level_change", id: "thinking-2", parentId: "thinking", timestamp: "2026-07-25T00:00:01.000Z", thinkingLevel: "low" }]
  ];
  for (const [index, prelude] of invalidPreludes.entries()) {
    await new FileBridgeMaterializer().replaceCreatedTranscript(created, history);
    const parentId = prelude.at(-1)?.id ?? "u1";
    await appendFile(created.transcriptPath, `${prelude.map(entry => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({ ...compact, parentId, id: `compact-${index}`, firstKeptEntryId: `compact-${index}` })}\n`);
    await assert.rejects(new FileBridgeMaterializer().readAndVerifyCompaction(created, history), /REWRITE_UNSUPPORTED/);
  }
});
