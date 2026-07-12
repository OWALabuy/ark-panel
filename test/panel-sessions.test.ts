import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelSession, listPanelSessions, commitPanelTranscript } from "../src/storage/panel-sessions.js";

test("panel 会话 UUID 存入 metadata，可列出并原子提交 transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-owned-"));
  const document = { header: { type: "session", version: 3, id: "fixture" }, entries: [] };
  const metadata = await createPanelSession(root, "fixture-agent", document, { parentRecordId: "parent", forkedFromMessageId: "msg" });
  assert.equal((await listPanelSessions(root, "fixture-agent"))[0]?.recordId, metadata.recordId);
  await commitPanelTranscript(root, metadata, { ...document, entries: [{ type: "message", id: "u", parentId: null, message: { role: "user", content: "虚构内容" } }] });
  const stored = await readFile(join(root, "sessions", "fixture-agent", metadata.recordId, "transcript.jsonl"), "utf8");
  assert.match(stored, /虚构内容/);
});
