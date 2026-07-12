import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, serializeTranscript } from "../src/domain/transcript.js";

test("解析和序列化保留未知字段及所有 content block", () => {
  const source = [
    { type: "session", version: 3, id: "s", unknown: { a: 1 } },
    { type: "message", id: "u", parentId: null, message: { role: "user", content: "问题" } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [
      { type: "thinking", thinking: "虚构思考" }, { type: "tool_use", id: "tool-1", name: "read", input: { path: "fixture" } }
    ] } },
    { type: "message", id: "t", parentId: "a", message: { role: "toolResult", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "虚构结果" }] } }
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  assert.equal(serializeTranscript(parseTranscript(source)), source);
});

test("拒绝半行 JSON", () => assert.throws(() => parseTranscript('{"type":"session"}\n{"type":'), /完整 JSON/));
