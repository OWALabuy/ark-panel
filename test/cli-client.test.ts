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
  let sentParams: Record<string, unknown> | undefined, abortCalls = 0;
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), gatewayRunTimeoutMs: 30, watcherGraceMs: 80, pollIntervalMs: 5,
    commandRunner: async (_executable, args) => {
      const method = args[2], params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
      if (method === "sessions.create") return JSON.stringify({ key: `agent:runtime:${String(params.key)}`, sessionId });
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

test("send 原样透传结构化附件，包括 Office 文件", async () => {
  const x = await clientFixture();
  const attachments = [{ fileName: "预算.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "UEsDBA==" }];
  await x.client.send(x.created.sessionKey, "请查看附件", "key", attachments);
  assert.deepEqual(x.sentParams()?.attachments, attachments);
});

test("生成控制 RPC 复用持久 transport，create 直接采用返回的 sessionId", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-persistent-rpc-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), commandRunner: async () => {
    throw new Error("generation RPC must not spawn CLI");
  }, rpc: { async request(method, rawParams) {
    const params = rawParams as Record<string, unknown>; calls.push({ method, params });
    if (method === "sessions.create") return { key: `agent:runtime:${String(params.key)}`, sessionId };
    if (method === "sessions.send") return { runId: "run" };
    if (method === "sessions.delete") return { ok: true };
    throw new Error(`unexpected ${method}`);
  } } });
  const created = await client.createSession("runtime");
  await client.send(created.sessionKey, "hello", "key");
  await client.deleteSession(created.sessionKey);
  assert.equal(created.sessionId, sessionId);
  assert.deepEqual(calls.map(call => call.method), ["sessions.create", "sessions.send", "sessions.delete"]);
  assert.match(String(calls[0]?.params.label), /^panel bridge [0-9a-f]{8}$/);
});

test("configuredTools 调用已配置 runtime 的 tools.catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-cli-tools-"));
  let observed: { method: string; params: Record<string, unknown> } | undefined;
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), commandRunner: async (_executable, args) => {
    const method = String(args[2]), params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
    observed = { method, params };
    return JSON.stringify({ agentId: "runtime", groups: [{ id: "core", label: "Core", source: "core", tools: [
      { id: "read", label: "Read", description: "Read files", source: "core" }
    ] }] });
  } });
  const catalog = await client.configuredTools("runtime");
  assert.deepEqual(observed, { method: "tools.catalog", params: { agentId: "runtime", includePlugins: true } });
  assert.equal(catalog.scope, "configured-runtime-catalog");
  await assert.rejects(client.configuredTools("other"), /RUNTIME_NOT_CONFIGURED/);
});

test("effectiveTools 读取临时 session 经 policy 过滤后的实际工具", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-cli-effective-tools-")); let observed: { method: string; params: Record<string, unknown> } | undefined;
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), commandRunner: async (_executable, args) => {
    const method = String(args[2]), params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>; observed = { method, params };
    return JSON.stringify({ agentId: "runtime", groups: [{ id: "core", tools: [{ id: "memory_search" }, { id: "memory_get" }] }] });
  } });
  assert.deepEqual(await client.effectiveTools("runtime", "agent:runtime:temporary"), { agentId: "runtime", scope: "effective-session-tools", toolIds: ["memory_get", "memory_search"] });
  assert.deepEqual(observed, { method: "tools.effective", params: { agentId: "runtime", sessionKey: "agent:runtime:temporary" } });
  await assert.rejects(client.effectiveTools("other", "agent:other:temporary"), /RUNTIME_NOT_CONFIGURED/);
});

test("记忆索引刷新仅接受 allowlist agent，并以结构化 CLI 参数顺序执行", async () => {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const client = new OpenClawCliClient({ sessionsRoots: new Map(), memoryIndexAgentIds: new Set(["agent", "panel-agent-runtime"]),
    memoryIndexTimeoutMs: 1_234, commandRunner: async (_executable, args, timeoutMs) => {
      calls.push({ args, timeoutMs }); return args[0] === "--version" ? "OpenClaw 2026.6.11" : "";
    } });
  await client.refreshMemoryIndex(["agent", "panel-agent-runtime", "agent"]);
  assert.deepEqual(calls, [
    { args: ["--version"], timeoutMs: 15_000 },
    { args: ["memory", "index", "--agent", "agent"], timeoutMs: 1_234 },
    { args: ["memory", "index", "--agent", "panel-agent-runtime"], timeoutMs: 1_234 }
  ]);
  await assert.rejects(client.refreshMemoryIndex(["other"]), /MEMORY_INDEX_AGENT_NOT_ALLOWED/);
  assert.equal(calls.length, 3);
});

test("按本轮 runId 采集 OpenClaw 明确登记的内联 artifact", async t => {
  const root = await mkdtemp(join(tmpdir(), "panel-cli-artifact-")); t.after(() => import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })));
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), commandRunner: async (_executable, args) => {
    const method = String(args[2]), params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>; calls.push({ method, params });
    if (method === "artifacts.list") return JSON.stringify({ artifacts: [
      { id: "a1", type: "file", title: "answer.pdf", mimeType: "application/pdf", download: { mode: "bytes" } },
      { id: "a2", type: "file", title: "unsafe", download: { mode: "unsupported" } }
    ] });
    if (method === "artifacts.download") return JSON.stringify({ artifact: {}, encoding: "base64", data: "cGRm" });
    return "{}";
  } });
  const outputs = await client.collectRunArtifacts("agent:runtime:key", "run-1");
  assert.equal(outputs.length, 1); assert.equal(outputs[0]?.fileName, "answer.pdf"); assert.equal(Buffer.from(outputs[0]!.bytes).toString(), "pdf");
  assert.deepEqual(calls.map(call => call.params.runId), ["run-1", "run-1"]);
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
