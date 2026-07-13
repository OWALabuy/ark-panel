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
