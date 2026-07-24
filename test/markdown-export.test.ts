import assert from "node:assert/strict";
import test from "node:test";
import { exportTranscriptMarkdown, markdownFilename } from "../src/domain/markdown-export.js";

test("Markdown 导出只包含当前分支并可读呈现结构化块", () => {
  const markdown = exportTranscriptMarkdown({ header: { type: "session", secretPath: "/home/private" }, entries: [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T01:02:03Z", message: { role: "user", content: [{ type: "text", text: "问题" }] } },
    { type: "message", id: "old", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "旧分支" }] } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [
      { type: "thinking", thinking: "推理" }, { type: "tool_use", name: "read", input: { file: "fixture" } }, { type: "tool_result", content: "结果" }, { type: "text", text: "回答" }
    ] } }
  ] }, "示例", "claude", new Date("2026-07-02T00:00:00Z"));
  assert.match(markdown, /^# 示例/m); assert.match(markdown, /## User · 2026-07-01/); assert.match(markdown, /<summary>Thinking<\/summary>/);
  assert.match(markdown, /Tool call: read/); assert.match(markdown, /Tool result/); assert.match(markdown, /回答/);
  assert.doesNotMatch(markdown, /旧分支|secretPath|\/home\/private/);
});

test("导出文件名移除路径和控制字符", () => {
  assert.equal(markdownFilename("../../坏/标题\r\n"), "坏 标题.md");
  assert.equal(markdownFilename("..."), "conversation.md");
});

test("Markdown 导出按原顺序保留消息并加入可折叠压缩摘要", () => {
  const markdown=exportTranscriptMarkdown({header:{type:"session"},entries:[
    {type:"message",id:"u",parentId:null,message:{role:"user",content:"before"}},
    {type:"compaction",id:"c",parentId:"u",timestamp:"2026-07-24T01:00:00Z",summary:"## Durable summary",firstKeptEntryId:"c",tokensBefore:50},
    {type:"message",id:"a",parentId:"c",message:{role:"assistant",content:"after"}}
  ]},"Compacted","agent");
  assert.ok(markdown.indexOf("before")<markdown.indexOf("Context compacted"));
  assert.ok(markdown.indexOf("Context compacted")<markdown.indexOf("after"));
  assert.match(markdown,/<summary>Compaction summary<\/summary>[\s\S]*Durable summary/);
});
