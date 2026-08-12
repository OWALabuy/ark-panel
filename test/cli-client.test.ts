import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completedRunStatus, GatewayRunError, OpenClawCliClient, parseSessionContextUsage, trajectoryRunState } from "../src/gateway/cli-client.js";
import { GatewayControlError, resolveGatewayControlTransport } from "../src/gateway/stream-client.js";
import { deferred, tempFixture, waitFor, withTimeout } from "./test-helpers.js";

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

interface ClientFixtureOptions {
  abortResponses?: Array<Record<string, unknown>>;
}

async function clientFixture(t: TestContext, options: ClientFixtureOptions = {}) {
  const root = await tempFixture(t, "panel-cli-"), sessionId = "11111111-1111-4111-8111-111111111111";
  let sentParams: Record<string, unknown> | undefined, abortCalls = 0;
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), gatewayRunTimeoutMs: 30, watcherGraceMs: 80, pollIntervalMs: 5,
    commandRunner: async (_executable, args) => {
      const method = args[2], params = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
      if (method === "sessions.create") return JSON.stringify({ key: `agent:runtime:${String(params.key)}`, sessionId });
      if (method === "sessions.send") { sentParams = params; return JSON.stringify({ runId: "run" }); }
      if (method === "sessions.abort") {
        const call = abortCalls++;
        const responses = options.abortResponses ?? [];
        return JSON.stringify(responses[Math.min(call, responses.length - 1)] ?? { ok: true, status: "no-active-run", abortedRunId: null });
      }
      return "{}";
    } });
  const created = await client.createSession("runtime");
  return { client, root, created, sessionId, sentParams: () => sentParams, abortCalls: () => abortCalls };
}

async function markFileUnread(path: string): Promise<number> {
  // Make atime older than mtime so the next data read advances it under the CI filesystem's relatime policy.
  await utimes(path, new Date(0), new Date());
  return (await stat(path)).atimeMs;
}

async function waitForFileRead(path: string, previousAtimeMs: number, description: string): Promise<void> {
  await waitFor(async () => (await stat(path)).atimeMs > previousAtimeMs, description);
}

test("gateway timeout 与 watcher grace 分离，并在 grace 内接住 terminal", async t => {
  const x = await clientFixture(t); await x.client.send(x.created.sessionKey, "hello", "key");
  assert.equal(x.sentParams()?.timeoutMs, 30);
  const waiting = x.client.waitForCompletion(x.sessionId, "run");
  const terminalWritten = deferred();
  // The 45 ms timer is intentional: this assertion requires terminal visibility after the 30 ms gateway timeout but within the 80 ms watcher grace.
  const terminalTimer = setTimeout(() => void writeFile(join(x.root, `${x.sessionId}.trajectory.jsonl`), `${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "success" } })}\n`).then(() => terminalWritten.resolve(), terminalWritten.reject), 45);
  t.after(() => clearTimeout(terminalTimer));
  await Promise.all([waiting, terminalWritten.promise]);
});

test("send 原样透传结构化附件，包括 Office 文件", async t => {
  const x = await clientFixture(t);
  const attachments = [{ fileName: "预算.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: "UEsDBA==" }];
  await x.client.send(x.created.sessionKey, "请查看附件", "key", attachments);
  assert.deepEqual(x.sentParams()?.attachments, attachments);
});

test("生成控制 RPC 复用持久 transport，create 直接采用返回的 sessionId", async t => {
  const root = await tempFixture(t, "panel-persistent-rpc-");
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

test("生产拒绝 transport 不会回落到逐次 Gateway CLI RPC", async () => {
  let cliCalls = 0;
  const client = new OpenClawCliClient({ sessionsRoots: new Map(), rpc: resolveGatewayControlTransport(),
    commandRunner: async () => { cliCalls++; throw new Error("CLI fallback must not run"); } });
  await assert.rejects(client.status(), error => error instanceof GatewayControlError && error.code === "GATEWAY_TRANSPORT_UNAVAILABLE");
  assert.equal(cliCalls, 0);
});

test("sessions.list 只采用目标会话的 OpenClaw fresh 上下文用量", async t => {
  const key = "agent:runtime:panel-fixture";
  assert.deepEqual(parseSessionContextUsage({ sessions: [
    { key: "agent:runtime:other", totalTokens: 999, totalTokensFresh: true, contextTokens: 1_000 },
    { key, totalTokens: 12_345, totalTokensFresh: true, contextTokens: 200_000 }
  ] }, key), { source: "openclaw-session", totalTokens: 12_345, contextTokens: 200_000, totalTokensFresh: true });
  assert.deepEqual(parseSessionContextUsage({ sessions: [
    { key, totalTokens: 12_345, totalTokensFresh: false, contextTokens: 200_000 }
  ] }, key), { source: "openclaw-session", totalTokens: null, contextTokens: 200_000, totalTokensFresh: false });

  const root = await tempFixture(t, "panel-session-usage-");
  let observed: { method: string; params: unknown } | undefined;
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), rpc: { async request(method, params) {
    observed = { method, params }; return { sessions: [{ key, totalTokens: 7, totalTokensFresh: true, contextTokens: 100 }] };
  } } });
  assert.equal((await client.sessionContextUsage("runtime", key))?.totalTokens, 7);
  assert.deepEqual(observed, { method: "sessions.list", params: { agentId: "runtime", search: key, limit: 10 } });
  await assert.rejects(client.sessionContextUsage("other", key), /RUNTIME_NOT_CONFIGURED/);
});

test("compact 仅调用 sessions.compact typed RPC 并拒绝异步 pending", async t => {
  const root = await tempFixture(t, "panel-cli-compact-"), calls: string[] = [];
  let pending = false, timeout: number | undefined;
  const successor = "33333333-3333-4333-8333-333333333333", successorPath = join(root, `${successor}.jsonl`);
  const client = new OpenClawCliClient({ sessionsRoots: new Map([["runtime", root]]), gatewayRunTimeoutMs: 54_321, rpc: { async request(method, _params, timeoutMs) {
    calls.push(method); timeout = timeoutMs;
    if (method !== "sessions.compact") throw new Error("unexpected");
    return pending ? { ok: true, compacted: false, result: { details: { pending: true } } } :
      { ok: true, compacted: true, result: { sessionId: successor, sessionFile: successorPath } };
  } } });
  assert.deepEqual(await client.compactSession("agent:runtime:key"), { compacted: true, sessionId: successor, sessionFile: successorPath });
  assert.equal(timeout, 54_321);
  pending = true; await assert.rejects(client.compactSession("agent:runtime:key"), /ASYNC_UNSUPPORTED/);
  assert.deepEqual(calls, ["sessions.compact", "sessions.compact"]);
});

test("configuredTools 调用已配置 runtime 的 tools.catalog", async t => {
  const root = await tempFixture(t, "panel-cli-tools-");
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

test("effectiveTools 读取临时 session 经 policy 过滤后的实际工具", async t => {
  const root = await tempFixture(t, "panel-cli-effective-tools-"); let observed: { method: string; params: Record<string, unknown> } | undefined;
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
  const root = await tempFixture(t, "panel-cli-artifact-");
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

test("增量 trajectory 正确处理跨 poll 调用 append 的 UTF-8 半字符", async t => {
  const x = await clientFixture(t), path = join(x.root, `${x.sessionId}.trajectory.jsonl`);
  const runId="run-中文",line = Buffer.from(`${JSON.stringify({ type: "session.ended", runId, data: { status: "success" } })}\n`);
  const marker = Buffer.from("中"), position = line.indexOf(marker);assert.ok(position>0);
  await writeFile(path,line.subarray(0,position+1));const unreadAtime=await markFileUnread(path);
  const waiting=x.client.waitForCompletion(x.sessionId,runId);waiting.catch(()=>undefined);
  await waitForFileRead(path,unreadAtime,"first UTF-8 byte trajectory poll");
  await appendFile(path,line.subarray(position+1));
  await withTimeout(waiting,"cross-poll UTF-8 trajectory completion");
});

test("未观察到 trajectory 与真实上游 timeout 使用稳定错误码", async t => {
  const missing = await clientFixture(t);
  await assert.rejects(missing.client.waitForCompletion(missing.sessionId, "run"), (error: unknown) => error instanceof GatewayRunError && error.code === "GATEWAY_RUN_NOT_STARTED");
  const timed = await clientFixture(t);
  await writeFile(join(timed.root, `${timed.sessionId}.trajectory.jsonl`), `${JSON.stringify({ type: "session.ended", runId: "run", data: { status: "error", timedOut: true } })}\n`);
  await assert.rejects(timed.client.waitForCompletion(timed.sessionId, "run"), (error: unknown) => error instanceof GatewayRunError && error.code === "GATEWAY_RUN_TIMEOUT");
});

test("AbortSignal 立即打断 watcher", async t => {
  const x = await clientFixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(x.client.waitForCompletion(x.sessionId, "run", controller.signal), /BRIDGE_ABORTED/);
});

test("abort RPC 返回后轮询等待 terminal，再确认 no-active-run", async t => {
  const x = await clientFixture(t, { abortResponses: [
    { ok: true, status: "aborted", abortedRunId: "run" },
    { ok: true, status: "no-active-run", abortedRunId: null }
  ] }),path=join(x.root,`${x.sessionId}.trajectory.jsonl`);
  const nonTerminal=`${JSON.stringify({type:"context.compiled",runId:"run"})}\n`;assert.equal(completedRunStatus(nonTerminal,"run"),undefined);
  await writeFile(path,nonTerminal);const unreadAtime=await markFileUnread(path);
  let settled=false;const aborting=x.client.abort(x.created.sessionKey,"run");void aborting.then(()=>{settled=true},()=>{settled=true});
  await waitForFileRead(path,unreadAtime,"post-abort terminal release poll");
  assert.equal(settled,false);assert.equal(x.abortCalls(),1);
  await appendFile(path,`${JSON.stringify({type:"session.ended",runId:"run",data:{status:"interrupted",aborted:true}})}\n`);
  await withTimeout(aborting,"abort terminal release and inactive confirmation");assert.equal(x.abortCalls(),2);
});

test("abort runId 不匹配会拒绝清理；no-active-run 无需 trajectory", async t => {
  const mismatch = await clientFixture(t, { abortResponses: [{ ok: true, status: "aborted", abortedRunId: "other" }] });
  await assert.rejects(mismatch.client.abort(mismatch.created.sessionKey, "run"), /OPENCLAW_ABORT_RUN_MISMATCH/);
  const inactive = await clientFixture(t, { abortResponses: [{ ok: true, status: "no-active-run", abortedRunId: null }] });
  await inactive.client.abort(inactive.created.sessionKey, "run"); assert.equal(inactive.abortCalls(), 1);
});
