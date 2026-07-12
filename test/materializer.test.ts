import test from "node:test";
import assert from "node:assert/strict";
import { FileBridgeMaterializer } from "../src/gateway/materializer.js";

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
