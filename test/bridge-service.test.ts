import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeService } from "../src/gateway/bridge-service.js";
import type { BridgeLifecycleEvent, BridgeMaterializer, CreatedSession, GatewayClient } from "../src/gateway/adapter.js";

test("bridge 成功和失败都先注销并清理", async () => {
  for (const fail of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "bridge-service-")); const id = "11111111-1111-4111-8111-111111111111";
    const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:key", transcriptPath: join(root, `${id}.jsonl`) };
    await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
    const events: string[] = [];
    const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { events.push("create"); return created; },
      async send() { events.push("send"); return { runId: "run" }; }, async waitForCompletion() { events.push("wait"); if (fail) throw new Error("failed"); },
      async abort() { events.push("abort"); }, async deleteSession() { events.push("delete"); } };
    const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return [{ type: "message" }]; },
      verifyAndStripSubmittedUser(entries) { return entries; } };
    const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
    const call = service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "虚构", latestUserEntryId: "panel-user", idempotencyKey: "same" });
    if (fail) await assert.rejects(call, /failed/); else await call;
    assert.equal(events.at(-1), "delete");
    if (fail) assert.ok(events.includes("abort"));
  }
});

test("bridge 在临时 session 清理前汇总本轮 artifact 与专属 outputs", async t => {
  const sessions = await mkdtemp(join(tmpdir(), "bridge-output-sessions-")); const workspace = await mkdtemp(join(tmpdir(), "bridge-output-workspace-"));
  t.after(() => Promise.all([rm(sessions, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]));
  const runUuid = "12345678-1234-4234-8234-123456789abc", id = "11111111-1111-4111-8111-111111111111";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:key", transcriptPath: join(sessions, `${id}.jsonl`) };
  await writeFile(join(sessions, `${id}.jsonl.deleted.fixture`), "x"); const order: string[] = [];
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; },
    async send(_key, message, _idempotency, attachments) {
      assert.equal(attachments?.[0]?.fileName, "input.docx");
      assert.match(message, /仅当用户明确要求生成可下载文件/); assert.match(message, new RegExp(`${runUuid}/outputs`));
      assert.match(message, /不要将用户上传的输入附件复制到该目录/);
      const output = join(workspace, ".openclaw", "tmp", "ark-panel", runUuid, "outputs", "answer.txt"); await writeFile(output, "answer");
      return { runId: "gateway-run" };
    }, async waitForCompletion() {}, async abort() {}, async deleteSession() { order.push("cleanup"); },
    async collectRunArtifacts(_key, runId) { assert.equal(runId, "gateway-run"); order.push("artifacts"); return [{ source: "artifact", fileName: "image.png", bytes: Buffer.from("png") }]; } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return [{ type: "message" }]; },
    verifyAndStripSubmittedUser(entries, expected) { assert.match(expected, /ark-panel 运行指令/); return entries; } };
  const lifecycle: BridgeLifecycleEvent[] = [];
  const service = new BridgeService(client, materializer, new Map([["runtime", sessions]]), undefined,
    { send: async (key, message, idempotencyKey, attachments) => await client.send(key, message, idempotencyKey, attachments) });
  const result = await service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] },
    latestUserMessage: "input", latestUserEntryId: "u", idempotencyKey: runUuid,
    attachments: [{ fileName: "input.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "UEs=" }],
    outputCapture: { workspaceRoot: workspace, cleanupRoot: join(workspace, "cleanup") }, lifecycle: async event => { lifecycle.push(event); if (event.type === "entries_materialized") order.push("durable"); } });
  assert.deepEqual(result.outputs?.map(output => [output.source, output.fileName]), [["artifact", "image.png"], ["output-directory", "answer.txt"]]);
  assert.deepEqual(order, ["artifacts", "durable", "cleanup"]);
  assert.equal(lifecycle.at(-1)?.type, "entries_materialized");
});

test("没有 outputCapture 时 gateway 和验证器收到未改写的面板原文", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-no-output-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "12121212-1212-4212-8212-121212121212", original = "请直接回答，不生成文件";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:no-output", transcriptPath: join(root, `${id}.jsonl`) };
  await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; },
    async send(_key, message) { assert.equal(message, original); return { runId: "run" }; }, async waitForCompletion() {}, async abort() {}, async deleteSession() {} };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; },
    verifyAndStripSubmittedUser(entries, expected) { assert.equal(expected, original); return entries; } };
  const result = await new BridgeService(client, materializer, new Map([["runtime", root]])).generate({ runtimeAgentId: "runtime",
    historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: original, latestUserEntryId: "u", idempotencyKey: "key" });
  assert.deepEqual(result.entries, []);
});

test("连续 20 轮 fixture 生成后无 transcript/trajectory artifact 累积", async t => {
  const root=await mkdtemp(join(tmpdir(),"bridge-durability-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,"sessions.json"),"{}");let sequence=0;
  const client:GatewayClient={async version(){return"2026.6.11"},async createSession(){sequence++;const id=`00000000-0000-4000-8000-${String(sequence).padStart(12,"0")}`;const transcriptPath=join(root,`${id}.jsonl`);await writeFile(transcriptPath,"fixture\n");await writeFile(join(root,`${id}.trajectory.jsonl`),"trajectory\n");await writeFile(join(root,`${id}.trajectory-path.json`),"{}\n");return{sessionId:id,sessionKey:`agent:runtime:${id}`,transcriptPath}},async send(){return{runId:`run-${sequence}`}},async waitForCompletion(){},async abort(){},async deleteSession(sessionKey){const id=sessionKey.split(":").at(-1)!;await writeFile(join(root,`${id}.jsonl.deleted.fixture`),await readFile(join(root,`${id}.jsonl`)));await import("node:fs/promises").then(fs=>fs.rm(join(root,`${id}.jsonl`)));await writeFile(join(root,"sessions.json"),"{}")}};
  const materializer:BridgeMaterializer={async replaceCreatedTranscript(){return 0},async readNewEntries(){return[{type:"message",message:{role:"user",content:"fixture"}},{type:"message",message:{role:"assistant",content:"ok"}}]},verifyAndStripSubmittedUser(entries){return entries.slice(1)}};
  const service=new BridgeService(client,materializer,new Map([["runtime",root]]));
  for(let i=0;i<20;i++){const result=await service.generate({runtimeAgentId:"runtime",historyThroughPreviousRun:{header:{type:"session"},entries:[]},latestUserMessage:"fixture",latestUserEntryId:`u${i}`,idempotencyKey:`k${i}`});assert.equal(result.entries.length,1)}
  assert.deepEqual(await readdir(root),["sessions.json"]);assert.equal(await readFile(join(root,"sessions.json"),"utf8"),"{}");
});

test("bridge 在发送前把会话 override 以 patch 应用到临时 session", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-overrides-"));
  const id = "22222222-2222-4222-8222-222222222222";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:key", transcriptPath: join(root, `${id}.jsonl`) };
  await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
  const events: string[] = [];
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { events.push("create"); return created; },
    async applySessionOverrides(key, overrides) { assert.equal(key, created.sessionKey); assert.deepEqual(overrides, { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" }); events.push("patch"); },
    async send() { events.push("send"); return { runId: "run" }; }, async waitForCompletion() {}, async abort() {}, async deleteSession() { events.push("delete"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { events.push("materialize"); return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  await service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "hello", latestUserEntryId: "user", idempotencyKey: "key",
    overrides: { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" } });
  assert.deepEqual(events.slice(0, 4), ["create", "materialize", "patch", "send"]);
});

test("bridge 在 send 前接入流并只转发本轮 run，观察失败不阻止生成", async t => {
  for (const attachFails of [false,true]) await t.test(attachFails?"降级":"转发",async t=>{
    const root=await mkdtemp(join(tmpdir(),"bridge-stream-"));t.after(()=>rm(root,{recursive:true,force:true}));const id="29292929-2929-4929-8929-292929292929";
    const created:CreatedSession={sessionId:id,sessionKey:"agent:runtime:stream",transcriptPath:join(root,`${id}.jsonl`)};await writeFile(join(root,`${id}.jsonl.deleted.fixture`),"x");
    const order:string[]=[],stream:unknown[]=[];let unsubscribed=false;
    const client:GatewayClient={async version(){return"2026.6.11"},async createSession(){return created},async send(){order.push("send");return{runId:"wanted"}},async waitForCompletion(){},async abort(){},async deleteSession(){}};
    const materializer:BridgeMaterializer={async replaceCreatedTranscript(){return 0},async readNewEntries(){return[]},verifyAndStripSubmittedUser(entries){return entries}};
    const observer={async observe(_key:string,listener:(event:import("../src/gateway/stream-client.js").GatewayStreamEvent)=>void){order.push("observe");if(attachFails)throw new Error("offline");listener({type:"assistant_text",runId:"other",sessionKey:created.sessionKey,upstreamSeq:1,text:"wrong",deltaText:"",replace:false});listener({type:"assistant_text",runId:"wanted",sessionKey:created.sessionKey,upstreamSeq:2,text:"right",deltaText:"",replace:false});return()=>{unsubscribed=true}}};
    const service=new BridgeService(client,materializer,new Map([["runtime",root]]),observer);await service.generate({runtimeAgentId:"runtime",historyThroughPreviousRun:{header:{type:"session"},entries:[]},latestUserMessage:"x",latestUserEntryId:"u",idempotencyKey:"wanted",stream:event=>stream.push(event)});
    assert.deepEqual(order.slice(0,2),["observe","send"]);if(attachFails)assert.deepEqual(stream,[]);else{assert.equal((stream[0] as {text:string}).text,"right");assert.equal(unsubscribed,true)}
  })
});

test("bridge lifecycle 按持久化边界顺序 await，并在 entries 持久化后才清理", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-lifecycle-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "33333333-3333-4333-8333-333333333333";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:lifecycle", transcriptPath: join(root, `${id}.jsonl`) };
  await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
  const order: string[] = []; const lifecycleEvents: BridgeLifecycleEvent[] = [];
  const client: GatewayClient = {
    async version() { return "2026.6.11"; },
    async createSession() { order.push("create"); return created; },
    async send() { order.push("send"); return { runId: "gateway-run" }; },
    async waitForCompletion() { order.push("wait"); }, async abort() { order.push("abort"); },
    async deleteSession() { order.push("cleanup"); }
  };
  const materializedEntries = [{ type: "message", message: { role: "assistant", content: "result" } }];
  const materializer: BridgeMaterializer = {
    async replaceCreatedTranscript() { order.push("replace"); return 7; },
    async readNewEntries() { order.push("read"); return materializedEntries; },
    verifyAndStripSubmittedUser(entries) { order.push("verify"); return entries; }
  };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  const result = await service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] },
    latestUserMessage: "private prompt", latestUserEntryId: "panel-user", idempotencyKey: "same", lifecycle: async event => {
      lifecycleEvents.push(event); order.push(`lifecycle:${event.type}:start`);
      await Promise.resolve(); order.push(`lifecycle:${event.type}:end`);
    } });

  assert.deepEqual(result.entries, materializedEntries);
  assert.deepEqual(lifecycleEvents, [
    { type: "temporary_session_created", runtimeAgentId: "runtime", sessionId: id, sessionKey: created.sessionKey, transcriptPath: created.transcriptPath },
    { type: "history_materialized", previousEntryCount: 7 },
    { type: "gateway_send_accepted", gatewayRunId: "gateway-run" },
    { type: "entries_materialized", entries: materializedEntries }
  ]);
  assert.ok(order.indexOf("lifecycle:temporary_session_created:end") < order.indexOf("replace"));
  assert.ok(order.indexOf("lifecycle:history_materialized:end") < order.indexOf("send"));
  assert.ok(order.indexOf("lifecycle:gateway_send_accepted:end") < order.indexOf("wait"));
  assert.ok(order.indexOf("lifecycle:entries_materialized:end") < order.indexOf("cleanup"));
  assert.equal(JSON.stringify(lifecycleEvents.slice(0, 3)).includes("private prompt"), false);
});

test("bridge lifecycle 失败会 abort 并 cleanup，且保留 lifecycle 主错误", async t => {
  for (const failedType of ["temporary_session_created", "history_materialized", "gateway_send_accepted", "entries_materialized"] as const) {
    await t.test(failedType, async t => {
      const root = await mkdtemp(join(tmpdir(), "bridge-lifecycle-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
      const id = "44444444-4444-4444-8444-444444444444";
      const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:failure", transcriptPath: join(root, `${id}.jsonl`) };
      await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
      const order: string[] = [];
      const client: GatewayClient = {
        async version() { return "2026.6.11"; }, async createSession() { return created; },
        async send() { order.push("send"); return { runId: "run-after-send" }; }, async waitForCompletion() { order.push("wait"); },
        async abort(_key, runId) { order.push(`abort:${runId ?? "none"}`); },
        async deleteSession() { order.push("cleanup"); throw new Error("delete cleanup failure"); }
      };
      const materializer: BridgeMaterializer = {
        async replaceCreatedTranscript() { order.push("replace"); return 0; }, async readNewEntries() { order.push("read"); return [{ type: "message" }]; },
        verifyAndStripSubmittedUser(entries) { return entries; }
      };
      const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
      await assert.rejects(service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] },
        latestUserMessage: "secret", latestUserEntryId: "panel-user", idempotencyKey: "same", lifecycle: async event => {
          order.push(`lifecycle:${event.type}`); if (event.type === failedType) throw new Error(`persist failed: ${failedType}`);
        } }), new RegExp(`persist failed: ${failedType}`));
      assert.ok(order.some(value => value.startsWith("abort:")));
      assert.ok(order.includes("cleanup"));
      if (failedType === "temporary_session_created") assert.equal(order.includes("replace"), false);
      if (failedType === "history_materialized") assert.equal(order.includes("send"), false);
      if (failedType === "gateway_send_accepted") assert.equal(order.includes("wait"), false);
      if (failedType === "entries_materialized") assert.ok(order.indexOf("lifecycle:entries_materialized") < order.indexOf("cleanup"));
    });
  }
});

test("bridge 在 send 后 lifecycle 持久化期间收到 abort 不会漏停 gateway run", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-send-abort-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "55555555-5555-4555-8555-555555555555", controller = new AbortController();
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:abort-race", transcriptPath: join(root, `${id}.jsonl`) };
  await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x"); const order: string[] = [];
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; },
    async send() { order.push("send"); return { runId: "gateway-run" }; }, async waitForCompletion() { order.push("wait"); },
    async abort(_key, runId) { order.push(`abort:${runId}`); }, async deleteSession() { order.push("cleanup"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  await assert.rejects(service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] },
    latestUserMessage: "prompt", latestUserEntryId: "user", idempotencyKey: "key", signal: controller.signal,
    lifecycle: async event => { if (event.type === "gateway_send_accepted") controller.abort(); } }), /BRIDGE_ABORTED/);
  assert.equal(order.filter(event => event === "abort:gateway-run").length, 1);
  assert.equal(order.includes("wait"), false); assert.equal(order.at(-1), "cleanup");
});

test("显式停止的 abort RPC 未确认时不谎报成功，也不清理仍可能运行的 session", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-abort-unconfirmed-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "12121212-1212-4212-8212-121212121212", controller = new AbortController(); let deleted = false, cleanupPending = 0;
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:uncertain", transcriptPath: join(root, `${id}.jsonl`) };
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; }, async send() { return { runId: "run" }; },
    async waitForCompletion(_session, _run, signal) { await new Promise<void>((resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("BRIDGE_ABORTED")), { once: true })); },
    async abort() { throw new Error("OPENCLAW_CLI_TIMEOUT"); }, async deleteSession() { deleted = true; } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  const pending = service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "x",
    latestUserEntryId: "user", idempotencyKey: "key", signal: controller.signal, cleanupFailed: async () => { cleanupPending++; } });
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
  await assert.rejects(pending, /RUN_ABORT_UNCONFIRMED/); assert.equal(deleted, false); assert.equal(cleanupPending, 1);
});

test("entries 已 durable 后 cleanup 失败不推翻结果，并发出 best-effort cleanup_failed", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cleanup-failed-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "66666666-6666-4666-8666-666666666666";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:cleanup-failed", transcriptPath: join(root, `${id}.jsonl`) };
  const events: string[] = [];
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; }, async send() { return { runId: "run" }; },
    async waitForCompletion() {}, async abort() {}, async deleteSession() { throw new Error("cleanup unavailable"); } };
  const entries = [{ type: "message", message: { role: "assistant", content: "durable" } }];
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return entries; }, verifyAndStripSubmittedUser(value) { return value; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  const result = await service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "prompt",
    latestUserEntryId: "user", idempotencyKey: "key", lifecycle: async event => { events.push(event.type); },
    cleanupFailed: async () => { events.push("cleanup_failed"); throw new Error("notification failed"); } });
  assert.deepEqual(result.entries, entries); assert.equal(events.at(-1), "cleanup_failed");
});

test("成功结果可在清理前返回，由持久化调用方接管恢复责任", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-deferred-cleanup-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "77777777-7777-4777-8777-777777777777"; let deleted = false;
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:deferred", transcriptPath: join(root, `${id}.jsonl`) };
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; },
    async send() { return { runId: "run" }; }, async waitForCompletion() {}, async abort() {}, async deleteSession() { deleted = true; } };
  const entries = [{ type: "message", message: { role: "assistant", content: "done" } }];
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return entries; }, verifyAndStripSubmittedUser(value) { return value; } };
  const result = await new BridgeService(client, materializer, new Map([["runtime", root]])).generate({ runtimeAgentId: "runtime",
    historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "prompt", latestUserEntryId: "user",
    idempotencyKey: "key", deferSuccessfulCleanup: true, lifecycle: async () => undefined });
  assert.deepEqual(result.entries, entries); assert.equal(deleted, false);
});

test("主流程与 cleanup 同时失败时保留主错误并登记后续清理", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-double-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:double-failure", transcriptPath: join(root, `${id}.jsonl`) };
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { return created; }, async send() { return { runId: "run" }; },
    async waitForCompletion() { throw new Error("gateway failed"); }, async abort() {}, async deleteSession() { throw new Error("cleanup failed"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  let cleanupFailed = 0;
  await assert.rejects(service.generate({
    runtimeAgentId: "runtime",
    historyThroughPreviousRun: { header: { type: "session" }, entries: [] },
    latestUserMessage: "hello",
    latestUserEntryId: "user-entry",
    idempotencyKey: "run-id",
    cleanupFailed: async () => { cleanupFailed += 1; }
  }), /gateway failed/);
  assert.equal(cleanupFailed, 1);
});

test("cleanupOrphanedSession 只在 abort/release 确认后注销并删除 artifacts", async t => {
  for (const abortFails of [false, true]) await t.test(abortFails ? "abort 未确认时保留 artifacts" : "abort 成功", async t => {
    const root = await mkdtemp(join(tmpdir(), "bridge-orphan-")); t.after(() => rm(root, { recursive: true, force: true }));
    const id = abortFails ? "77777777-7777-4777-8777-777777777777" : "88888888-8888-4888-8888-888888888888";
    await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x"); await writeFile(join(root, `${id}.trajectory.jsonl`), "x");
    const order: string[] = [];
    const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { throw new Error("unused"); }, async send() { throw new Error("unused"); },
      async waitForCompletion() {}, async abort(key, runId) { order.push(`abort:${key}:${runId}`); if (abortFails) throw new Error("already gone"); },
      async deleteSession(key) { order.push(`delete:${key}`); } };
    const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
    const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
    const cleanup = service.cleanupOrphanedSession({ runtimeAgentId: "runtime", sessionId: id, sessionKey: "agent:runtime:orphan", gatewayRunId: "gateway-run" });
    if (abortFails) {
      await assert.rejects(cleanup, /already gone/); assert.deepEqual(order, ["abort:agent:runtime:orphan:gateway-run"]);
      assert.deepEqual((await readdir(root)).sort(), [`${id}.jsonl.deleted.fixture`, `${id}.trajectory.jsonl`].sort());
    } else {
      assert.deepEqual(await cleanup, [`${id}.jsonl.deleted.fixture`, `${id}.trajectory.jsonl`]);
      assert.deepEqual(order, ["abort:agent:runtime:orphan:gateway-run", "delete:agent:runtime:orphan"]); assert.deepEqual(await readdir(root), []);
    }
  });
});

test("cleanupOrphanedSession 不吞严格 cleanup 错误", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-orphan-cleanup-error-")); t.after(() => rm(root, { recursive: true, force: true }));
  const id = "99999999-9999-4999-8999-999999999999";
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { throw new Error("unused"); }, async send() { throw new Error("unused"); },
    async waitForCompletion() {}, async abort() {}, async deleteSession() { throw new Error("strict cleanup failed"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  await assert.rejects(service.cleanupOrphanedSession({ runtimeAgentId: "runtime", sessionId: id, sessionKey: "agent:runtime:orphan" }), /strict cleanup failed/);
});

test("compact 使用 typed RPC 并从原 transcript 采纳 rotation 前的已验证 entry", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-compact-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "sessions.json"), "{}"); const order: string[] = [];
  const created = { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionKey: "agent:runtime:key", transcriptPath: join(root, "a.jsonl") };
  const entry = { type: "compaction", id: "c1", parentId: "a1", summary: "summary", firstKeptEntryId: "a1", tokensBefore: 20 };
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { order.push("create"); return created; },
    async compactSession() { order.push("compact"); return { compacted: true, sessionId: "successor", sessionFile: join(root, "successor.jsonl") }; },
    async send() { throw new Error("command text must not be sent"); }, async waitForCompletion() {}, async abort() {},
    async deleteSession() { order.push("delete"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { order.push("materialize"); return 1; },
    async readNewEntries() { return []; }, verifyAndStripSubmittedUser(value) { return value; },
    async readAndVerifyCompaction(target) { assert.equal(target.transcriptPath, created.transcriptPath); order.push("verify-original"); return entry; } };
  const result = await new BridgeService(client, materializer, new Map([["runtime", root]])).compact({
    runtimeAgentId: "runtime", history: { header: { type: "session" }, entries: [{ type: "message", id: "a1" }] },
    overrides: {}
  });
  assert.deepEqual(result, { compacted: true, entry });
  assert.deepEqual(order, ["create", "materialize", "compact", "verify-original", "delete"]);
});
