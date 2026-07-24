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
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } }
  ] };
  const materializer = new FileBridgeMaterializer(); await materializer.replaceCreatedTranscript(created, history);
  const compact = { type: "compaction", id: "c1", parentId: "a1", summary: "summary", firstKeptEntryId: "a1", tokensBefore: 42 };
  await appendFile(created.transcriptPath, `${JSON.stringify(compact)}\n`);
  assert.deepEqual(await materializer.readAndVerifyCompaction(created, history), compact);
  await appendFile(created.transcriptPath, `${JSON.stringify({ ...compact, id: "c2", parentId: "c1" })}\n`);
  await assert.rejects(materializer.readAndVerifyCompaction(created, history), /REWRITE_UNSUPPORTED/);
});
