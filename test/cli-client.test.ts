import test from "node:test";
import assert from "node:assert/strict";
import { completedRunStatus } from "../src/gateway/cli-client.js";

test("从 trajectory 中按 runId 识别 session.ended", () => {
  const lines = [
    { type: "session.ended", runId: "old", data: { status: "success" } },
    { type: "context.compiled", runId: "wanted" },
    { type: "session.ended", runId: "wanted", data: { status: "success" } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  assert.equal(completedRunStatus(lines, "wanted"), "success");
  assert.equal(completedRunStatus(lines, "missing"), undefined);
});

test("忽略正在写入的半行并保留失败状态", () => {
  const lines = `${JSON.stringify({ type: "session.ended", runId: "failed-run", data: { status: "error" } })}\n{"type":`;
  assert.equal(completedRunStatus(lines, "failed-run"), "error");
});
