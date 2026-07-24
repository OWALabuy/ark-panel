import test from "node:test";
import assert from "node:assert/strict";
import { deriveFork, isLegalForkBoundary } from "../src/domain/fork.js";
import type { JsonObject, TranscriptDocument } from "../src/domain/transcript.js";

const message = (id: string, parentId: string | null, role: string, content: unknown, extra: JsonObject = {}): JsonObject =>
  ({ type: "message", id, parentId, message: { role, content }, ...extra });

test("fork 沿祖先链派生，不带旁支", () => {
  const source: TranscriptDocument = { header: { type: "session", version: 3, id: "old" }, entries: [
    message("u1", null, "user", "一"), message("a1", "u1", "assistant", [{ type: "text", text: "答一" }]),
    message("branch", "a1", "user", "旁支"), message("u2", "a1", "user", "二"),
    { type: "thinking_level_change", level: "high" }, message("a2", "u2", "assistant", [{ type: "text", text: "答二" }])
  ] };
  const fork = deriveFork(source, "a2", { recordId: "panel-x", parentRecordId: "parent", forkedFromMessageId: "a2", createdAt: "2026-07-11T00:00:00Z" });
  assert.deepEqual(fork.entries.filter((e) => typeof e.id === "string").map((e) => e.id), ["u1", "a1", "u2", "a2"]);
  assert.equal((fork.header.panel as JsonObject).parentRecordId, "parent");
});

test("工具调用中间不是合法 fork 边界，最终回复是", () => {
  const call = message("call", "u", "assistant", [{ type: "toolCall", id: "tool" }], { stopReason: "toolUse" });
  const result = message("result", "call", "toolResult", [{ type: "toolResult", toolCallId: "tool" }]);
  const final = message("final", "result", "assistant", [{ type: "text", text: "完成" }]);
  assert.equal(isLegalForkBoundary(call), false);
  assert.equal(isLegalForkBoundary(result), false);
  assert.equal(isLegalForkBoundary(final), true);
});

test("fork 在压缩点前不继承摘要，在压缩点及之后继承摘要", () => {
  const source:TranscriptDocument={header:{type:"session"},entries:[
    message("u",null,"user","before"),message("a","u","assistant","answer"),
    {type:"compaction",id:"c",parentId:"a",summary:"summary",firstKeptEntryId:"c",tokensBefore:10},
    message("post","c","user","after")
  ]},metadata=(id:string)=>({recordId:`fork-${id}`,parentRecordId:"parent",forkedFromMessageId:id,createdAt:"2026-07-24T00:00:00Z"});
  assert.deepEqual(deriveFork(source,"a",metadata("a")).entries.map(entry=>entry.id),["u","a"]);
  assert.deepEqual(deriveFork(source,"c",metadata("c")).entries.map(entry=>entry.id),["u","a","c"]);
  assert.deepEqual(deriveFork(source,"post",metadata("post")).entries.map(entry=>entry.id),["u","a","c","post"]);
});
