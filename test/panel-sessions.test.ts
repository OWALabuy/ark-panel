import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelSession, listPanelSessions, commitPanelTranscript, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";

test("panel 会话 UUID 存入 metadata，可列出并原子提交 transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-owned-"));
  const document = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };
  const metadata = await createPanelSession(root, "fixture-agent", document, { parentRecordId: "parent", forkedFromMessageId: "msg" });
  assert.equal(metadata.archived, false); assert.equal(metadata.hidden, false); assert.equal(metadata.memoryDisposition, "scratch");
  assert.equal((await listPanelSessions(root, "fixture-agent"))[0]?.recordId, metadata.recordId);
  await commitPanelTranscript(root, metadata, { ...document, entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: "虚构内容" } }] });
  const stored = await readFile(join(root, "sessions", "fixture-agent", metadata.recordId, "transcript.jsonl"), "utf8");
  assert.match(stored, /虚构内容/);
});

test("旧 metadata 可直接读取，覆盖项更新采用原子 read-modify-write", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-metadata-"));
  const document = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };
  const metadata = await createPanelSession(root, "agent", document);
  assert.equal((await loadPanelSession(root, "agent", metadata.recordId)).metadata.modelOverride, undefined);
  await Promise.all([
    updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, modelOverride: "provider/model" })),
    updatePanelMetadata(root, "agent", metadata.recordId, current => ({ ...current, reasoningLevel: "stream" }))
  ]);
  const updated = (await loadPanelSession(root, "agent", metadata.recordId)).metadata;
  assert.equal(updated.modelOverride, "provider/model"); assert.equal(updated.reasoningLevel, "stream");
});
