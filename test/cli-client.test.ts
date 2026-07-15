import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completedRunStatus, GatewayRunError, OpenClawCliClient, trajectoryRunState } from "../src/gateway/cli-client.js";

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

test("保留 terminal 的安全诊断字段并区分上游 timeout/interrupt", async () => {
  const timed = trajectoryRunState(JSON.stringify({ type: "session.ended", runId: "run", ts: "now", seq: 7,
    data: { status: "error", timedOut: true, promptError: "secret" } }), "run");
  assert.deepEqual(timed.lastObserved, { type: "session.ended", status: "error", ts: "now", seq: 7, timedOut: true });
  const interrupted = trajectoryRunState(JSON.stringify({ type: "session.ended", runId: "run", data: { status: "interrupted" } }), "run");
  assert.equal(interrupted.terminalStatus, "interrupted");
});

async function clientFixture(abortResponses: Array<Record<string, unknown>> = []) {
  const root = await mkdtemp(join(tmpdir(), "panel-cli-")), sessionId = "11111111-1111-4111-8111-111111111111";
  let sentParams: Record<string, unknown> | undefined, abortCalls = 0, createdKey = "";
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), gatewayRunTimeoutMs: 30, watcherGraceMs: 80, pollIntervalMs: 5,
    commandRunner: async (_executable, args) => {
      if (args[0] === "sessions") return JSON.stringify({ sessions: [{ key: createdKey, sessionId }] });
      const method = args[2], params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
      if (method === "sessions.create") { createdKey = String(params.key); return "{}"; }
      if (method === "sessions.send") { sentParams = params; return JSON.stringify({ runId: "run" }); }
      if (method === "sessions.abort") return JSON.stringify(abortResponses[Math.min(abortCalls++, abortResponses.length - 1)] ?? { ok: true, status: "no-active-run", abortedRunId: null });
      return "{}";
    } });
  const created = await client.createSession("runtime");
  return { client, root, created, sessionId, sentParams: () => sentParams, abortCalls: () => abortCalls };
}

test("gateway timeout 与 watcher grace 分离，并在 grace 内接住 terminal", async () => {
  const x = await clientFixture(); await x.client.send(x.created.sessionKey, "hello", "key");
  assert.equal(x.sentParams()?.timeoutMs, 30);
  const waiting = x.client.waitForCompletion(x.sessionId, "run");
  setTimeout(() => void writeFile(join(x.root, `${x.sessionId}.trajectory.jsonl`), `${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "success" } })}\n`), 45);
  await waiting;
});

test("增量 trajectory 正确处理跨 append 的 UTF-8 字符", async () => {
  const x = await clientFixture(), path = join(x.root, `${x.sessionId}.trajectory.jsonl`);
  const line = Buffer.from(`${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "success", note: "中文" } })}\n`);
  const marker = Buffer.from("中"), position = line.indexOf(marker); await writeFile(path, line.subarray(0, position + 1));
  setTimeout(() => void appendFile(path, line.subarray(position + 1)), 10);
  await x.client.waitForCompletion(x.sessionId, "run");
});

test("未观察到 trajectory 与真实上游 timeout 使用稳定错误码", async () => {
  const missing = await clientFixture();
  await assert.rejects(missing.client.waitForCompletion(missing.sessionId, "run"), (error: unknown) => error instanceof GatewayRunError && error.code === "GATEWAY_RUN_NOT_STARTED");
  const timed = await clientFixture();
  await writeFile(join(timed.root, `${timed.sessionId}.trajectory.jsonl`), `${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "error", timedOut: true } })}\n`);
  await assert.rejects(timed.client.waitForCompletion(timed.sessionId, "run"), (error: unknown) => error instanceof GatewayRunError && error.code === "GATEWAY_RUN_TIMEOUT");
});

test("AbortSignal 立即打断 watcher", async () => {
  const x = await clientFixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(x.client.waitForCompletion(x.sessionId, "run", controller.signal), /BRIDGE_ABORTED/);
});

test("abort 等 terminal 后继续确认 no-active-run", async () => {
  const x = await clientFixture([{ ok: true, status: "aborted", abortedRunId: "run" }, { ok: true, status: "no-active-run", abortedRunId: null }]);
  setTimeout(() => void writeFile(join(x.root, `${x.sessionId}.trajectory.jsonl`), `${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "interrupted", aborted: true } })}\n`), 15);
  await x.client.abort(x.created.sessionKey, "run"); assert.equal(x.abortCalls(), 2);
});

test("abort runId 不匹配会拒绝清理；no-active-run 无需 trajectory", async () => {
  const mismatch = await clientFixture([{ ok: true, status: "aborted", abortedRunId: "other" }]);
  await assert.rejects(mismatch.client.abort(mismatch.created.sessionKey, "run"), /OPENCLAW_ABORT_RUN_MISMATCH/);
  const inactive = await clientFixture([{ ok: true, status: "no-active-run", abortedRunId: null }]);
  await inactive.client.abort(inactive.created.sessionKey, "run"); assert.equal(inactive.abortCalls(), 1);
});
