import assert from "node:assert/strict";
import test from "node:test";
import { currentTranscriptBranch } from "../src/domain/branch.js";

test("分支扫描遵循 leaf/side cursor 并让 compaction 成为立即可见的叶", () => {
  const document = { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user" } },
    { type: "message", id: "side", parentId: "u1", appendMode: "side", message: { role: "assistant" } },
    { type: "leaf", id: "leaf", parentId: "u1", targetId: "u1", appendParentId: "side", appendMode: "side" },
    { type: "model_change", id: "model", parentId: "side" },
    { type: "compaction", id: "compact", parentId: "model", summary: "s", firstKeptEntryId: "model", tokensBefore: 10 },
    { type: "custom", id: "side-custom", parentId: "compact", appendMode: "side" }
  ] };
  assert.deepEqual(currentTranscriptBranch(document).entries.map(entry => entry.id), ["u1", "model", "compact"]);
});
