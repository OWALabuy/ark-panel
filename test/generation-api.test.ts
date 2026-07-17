import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitPanelTranscript, createPanelSession, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
import { PanelGenerationApi } from "../src/server/generation-api.js";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import type { BridgeRequest } from "../src/gateway/adapter.js";
import { listSessionAttachments, readSessionAttachmentBytes, storeSessionAttachment } from "../src/storage/attachments.js";

test("附件原样交给 OpenClaw，输入与本轮模型产出作为消息块持久化", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-attachments-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp(join(tmpdir(), "generation-workspace-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const officeBytes = Buffer.from("raw-office-fixture");
  const uploaded = await storeSessionAttachment(root, { fileName: "notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: officeBytes },
  { agentId: "claude", recordId: metadata.recordId, messageId: "pending_11111111-1111-4111-8111-111111111111", role: "user" });
  const api = new PanelGenerationApi({ async generate(request) {
    assert.equal(request.attachments?.[0]?.content, officeBytes.toString("base64"));
    assert.equal(request.outputCapture?.workspaceRoot, workspace);
    const entries = [{ type: "message", id: "answer", parentId: request.latestUserEntryId,
      message: { role: "assistant", content: [{ type: "text", text: "文件已生成" }] } }];
    await request.lifecycle?.({ type: "entries_materialized", entries, outputs: [
      { source: "output-directory", fileName: "reports/result.md", mimeType: "text/markdown; charset=utf-8", bytes: Buffer.from("# result") }
    ] });
    return { runId: request.idempotencyKey, sessionId: "temp", entries };
  } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]), workspaceByAgent: new Map([["claude", workspace]]) });
  const runId = "41414141-4141-4141-8141-414141414141";
  await api.create(metadata.recordId, "分析附件", runId, undefined, [uploaded.manifest.attachmentId]);
  for (let index = 0; index < 200 && (await api.get(runId))?.status !== "completed"; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await api.get(runId))?.status, "completed");
  const { document } = await loadPanelSession(root, "claude", metadata.recordId);
  const userContent = (document.entries[0]!.message as { content: Array<Record<string, unknown>> }).content;
  assert.equal(userContent[1]?.attachmentId, uploaded.manifest.attachmentId);
  const assistantContent = (document.entries[1]!.message as { content: Array<Record<string, unknown>> }).content;
  assert.equal(assistantContent[1]?.disposition, "output"); assert.equal(assistantContent[1]?.fileName, "result.md");
  const stored = await listSessionAttachments(root, "claude", metadata.recordId); assert.equal(stored.length, 2);
  const output = stored.find(item => item.reference.role === "assistant")!;
  assert.equal(output.manifest.mimeType, "text/markdown");
  assert.equal((await readSessionAttachmentBytes(root, "claude", metadata.recordId, output.manifest.attachmentId)).toString(), "# result");
});

test("GenerationApi 只在完整 bridge 成功后原子提交 user 和 run，并保持 parent 链", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-api-"));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session", version: 3 }, entries: [
    { type: "message", id: "previous", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "旧回复" }] } }
  ] });
  const api = new PanelGenerationApi({ async generate(request) { return { runId: "run", sessionId: "temp", entries: [
    { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: [{ type: "text", text: "新回复" }] } }
  ] }; } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime-claude"]]) });
  await api.generate(metadata.recordId, "新问题", new AbortController().signal);
  const { document } = await loadPanelSession(root, "claude", metadata.recordId);
  assert.equal(document.entries.length, 3); assert.equal(document.entries[1]?.parentId, "previous"); assert.equal(document.entries[2]?.parentId, document.entries[1]?.id);
});

test("bridge 失败不写入 user entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-api-")); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const api = new PanelGenerationApi({ async generate() { throw new Error("failed"); } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await assert.rejects(api.generate(metadata.recordId, "不会提交", new AbortController().signal), /failed/);
  assert.equal((await loadPanelSession(root, "claude", metadata.recordId)).document.entries.length, 0);
});

test("GenerationApi 把持久化会话设置传给下一轮 bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-overrides-"));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  await updatePanelMetadata(root, "claude", metadata.recordId, current => ({ ...current, modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" }));
  let seen: unknown;
  const api = new PanelGenerationApi({ async generate(request) { seen = request.overrides; return { runId: request.idempotencyKey, sessionId: "temp", entries: [] }; } },
    { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await api.generate(metadata.recordId, "hello", new AbortController().signal);
  assert.deepEqual(seen, { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" });
});

test("同一 idempotency key 共享并缓存结果，其他并发写被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-retry-")); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  let calls = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const api = new PanelGenerationApi({ async generate(request) { calls++; await gate; return { runId: request.idempotencyKey, sessionId: "temp", entries: [
    { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
  ] }; } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  const signal = new AbortController().signal, runId = "11111111-1111-4111-8111-111111111111";
  const first = api.generate(metadata.recordId, "same", signal, runId); const retry = api.generate(metadata.recordId, "same", signal, runId);
  await assert.rejects(api.generate(metadata.recordId, "other", signal, "22222222-2222-4222-8222-222222222222"), /SESSION_BUSY/);
  release(); assert.deepEqual(await first, await retry); assert.equal(calls, 1);
  await api.generate(metadata.recordId, "same", signal, runId); assert.equal(calls, 1);
  await assert.rejects(api.generate(metadata.recordId, "different", signal, runId), /IDEMPOTENCY_KEY_REUSED/);
});

test("revision 冲突在调用 bridge 前被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "generation-revision-")); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  let calls = 0; const api = new PanelGenerationApi({ async generate() { calls++; throw new Error("should not run"); } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await assert.rejects(api.generate(metadata.recordId, "message", new AbortController().signal, undefined, "stale"), /REVISION_CONFLICT/); assert.equal(calls, 0);
  const stat = await lstat(join(root,"sessions","claude",metadata.recordId,"transcript.jsonl")); assert.ok(`${stat.size}:${stat.mtimeMs}`);
});

test("completed 幂等缓存严格有界并淘汰最旧结果", async () => {
  const root=await mkdtemp(join(tmpdir(),"generation-cache-"));const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let calls=0;
  const api=new PanelGenerationApi({async generate(request){calls++;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:`a${calls}`,parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]]),completedCacheLimit:2});
  const signal=new AbortController().signal,ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
  for(const id of ids)await api.generate(metadata.recordId,id,signal,id);assert.equal(api.completedCacheSize(),2);assert.equal(calls,3);
  await api.generate(metadata.recordId,ids[0]!,signal,ids[0]!);assert.equal(calls,4);assert.equal(api.completedCacheSize(),2);
});

test("超出上下文预算时在 bridge 前拒绝且不修改 transcript", async () => {
  const root=await mkdtemp(join(tmpdir(),"generation-budget-"));const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[{type:"message",id:"u1",parentId:null,message:{role:"user",content:"x".repeat(500)}}]});let calls=0;
  const api=new PanelGenerationApi({async generate(){calls++;throw new Error("不应调用")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]]),contextBudget:new ConservativeContextBudget(40)});
  await assert.rejects(api.generate(metadata.recordId,"next",new AbortController().signal),/会话历史过长/);assert.equal(calls,0);
  assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,1);
});

test("斜杠命令在 bridge 前被拒绝且不修改 transcript", async () => {
  const root=await mkdtemp(join(tmpdir(),"generation-command-"));const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let calls=0;
  const api=new PanelGenerationApi({async generate(){calls++;return{runId:"run",sessionId:"temp",entries:[]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  await assert.rejects(api.generate(metadata.recordId,"  /status",new AbortController().signal),/SLASH_COMMANDS_UNSUPPORTED/);assert.equal(calls,0);
  assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,0);
});

test("abort 或失败不会提交半个 user/run，失败的幂等 key 可以安全重试", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let calls=0;
  const api=new PanelGenerationApi({async generate(request){calls++;if(calls===1)throw new Error("fixture failure");if(request.signal?.aborted)throw new Error("BRIDGE_ABORTED");return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:"complete",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="77777777-7777-4777-8777-777777777777";
  await assert.rejects(api.generate(metadata.recordId,"retry",new AbortController().signal,runId),/fixture failure/);
  assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,0);
  await api.generate(metadata.recordId,"retry",new AbortController().signal,runId);
  assert.equal(calls,2);assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,2);

  const aborted=new AbortController();aborted.abort();
  await assert.rejects(api.generate(metadata.recordId,"abort",aborted.signal,"88888888-8888-4888-8888-888888888888"),/BRIDGE_ABORTED/);
  assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,2);
});

test("后台 run 先持久化再快速返回，持久幂等、会话互斥并在终态擦除正文", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-runs-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const api=new PanelGenerationApi({async generate(request){calls++;await request.lifecycle?.({type:"temporary_session_created",runtimeAgentId:"runtime",sessionId:"temp",sessionKey:"agent:runtime:temp",transcriptPath:"/tmp/temp.jsonl"});await gate;await request.lifecycle?.({type:"gateway_send_accepted",gatewayRunId:"gateway"});await request.lifecycle?.({type:"entries_materialized",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]});return{runId:"gateway",sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",created=await api.create(metadata.recordId,"private prompt",runId);
  assert.equal(created.status,"accepted");assert.equal(created.newlyCreated,true);
  const persisted=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal(persisted.message,"private prompt");assert.equal(typeof persisted.plannedUserEntryId,"string");
  assert.equal((await api.create(metadata.recordId,"private prompt",runId)).newlyCreated,false);for(let i=0;i<100&&calls===0;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);
  await assert.rejects(api.create(metadata.recordId,"different",runId),/IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.create(metadata.recordId,"other","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),/SESSION_BUSY/);
  release();for(let i=0;i<100&&(await api.get(runId))?.status!=="completed";i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await api.get(runId))?.status,"completed");const terminal=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));
  assert.equal("message" in terminal,false);assert.equal("stagedEntries" in terminal,false);assert.equal(terminal.gatewayRunId,"gateway");
});

test("后台 run 将停止未确认记录为 failed 而不是 aborted", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-abort-unconfirmed-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  const api=new PanelGenerationApi({async generate(){throw new Error("RUN_ABORT_UNCONFIRMED")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="13131313-1313-4313-8313-131313131313";await api.create(metadata.recordId,"message",runId);
  for(let i=0;i<100&&(await api.get(runId))?.status!=="failed";i++)await new Promise(resolve=>setTimeout(resolve,5));
  const run=await api.get(runId);assert.equal(run?.status,"failed");assert.equal(run?.error?.code,"RUN_ABORT_UNCONFIRMED");
});

test("run 订阅先给快照、终态可重订阅，重启恢复 staged entries 而不重复调用模型", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-recover-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",api=new PanelGenerationApi({async generate(request){await gate;return{runId:id,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  await api.create(metadata.recordId,"hello",id);const seen:string[]=[];const unsubscribe=await api.subscribe(id,run=>seen.push(run.status));assert.equal(seen[0] === "accepted" || seen[0] === "running",true);release();
  for(let i=0;i<100&&(await api.get(id))?.status!=="completed";i++)await new Promise(resolve=>setTimeout(resolve,5));unsubscribe?.();
  const terminal:string[]=[];await api.subscribe(id,run=>terminal.push(run.status));assert.deepEqual(terminal,["completed"]);

  const recoveryId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",planned="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",now=new Date().toISOString();
  const {PanelRunStore}=await import("../src/server/run-store.js");const store=new PanelRunStore(root);await store.put({version:1,runId:recoveryId,recordId:metadata.recordId,requestHash:"hash",sequence:4,status:"materializing",createdAt:now,updatedAt:now,message:"recovered",plannedUserEntryId:planned,stagedEntries:[{type:"message",id:"recovered-answer",parentId:planned,message:{role:"assistant",content:"done"}}]});
  let calls=0;const recovered=new PanelGenerationApi({async generate(){calls++;throw new Error("must not replay")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await recovered.initialize();
  assert.equal(calls,0);assert.equal((await recovered.get(recoveryId))?.status,"completed");assert.ok((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.some(entry=>entry.id===planned));
});

test("流式文本与工具状态只存在于运行快照，终态由 transcript 替换且不持久化增量", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-stream-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  let bridgeRequest: BridgeRequest|undefined;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const api=new PanelGenerationApi({async generate(request){bridgeRequest=request;await gate;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"最终结果"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="45454545-4545-4545-8545-454545454545";await api.create(metadata.recordId,"hello",runId);
  for(let index=0;index<100&&!bridgeRequest;index++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(bridgeRequest?.stream);
  const seen:import("../src/server/run-store.js").PublicPanelRun[]=[];const unsubscribe=await api.subscribe(runId,run=>seen.push(run));
  bridgeRequest!.stream!({type:"assistant_text",upstreamSeq:1,text:"临时",deltaText:"临",replace:false});
  bridgeRequest!.stream!({type:"tool",upstreamSeq:2,callId:"call",name:"exec",phase:"started",args:{command:"true"}});
  bridgeRequest!.stream!({type:"tool",upstreamSeq:3,callId:"call",name:"exec",phase:"completed"});
  for(let index=0;index<100&&!seen.some(run=>run.stream?.tools[0]?.phase==="completed");index++)await new Promise(resolve=>setTimeout(resolve,2));
  const live=[...seen].reverse().find(run=>run.stream?.tools.length);assert.equal(live?.stream?.text,"临时");assert.equal(live?.stream?.tools[0]?.phase,"completed");assert.deepEqual(live?.stream?.tools[0]?.args,{command:"true"});
  release();for(let index=0;index<100&&(await api.get(runId))?.status!=="completed";index++)await new Promise(resolve=>setTimeout(resolve,2));
  const terminal=await api.get(runId);assert.equal(terminal?.status,"completed");assert.equal(terminal?.stream,undefined);unsubscribe?.();
  const persisted=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal("stream" in persisted,false);
  assert.match(JSON.stringify((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.at(-1)),/最终结果/);
});

test("不同会话并发流互不串线，停止后迟到增量被丢弃", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-stream-concurrent-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]}),second=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  const requests=new Map<string,BridgeRequest>();let releaseSecond!:()=>void;const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve});
  const api=new PanelGenerationApi({async generate(request){requests.set(request.idempotencyKey,request);if(request.idempotencyKey.startsWith("61")){
    await new Promise<void>((_resolve,reject)=>request.signal?.addEventListener("abort",()=>reject(new Error("BRIDGE_ABORTED")),{once:true}));throw new Error("unreachable");
  }await secondGate;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"second done"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const firstId="61616161-6161-4161-8161-616161616161",secondId="62626262-6262-4262-8262-626262626262";
  await Promise.all([api.create(first.recordId,"one",firstId),api.create(second.recordId,"two",secondId)]);
  for(let index=0;index<100&&requests.size<2;index++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(requests.size,2);
  requests.get(firstId)!.stream!({type:"assistant_text",upstreamSeq:1,text:"first only",deltaText:"first only",replace:false});
  requests.get(secondId)!.stream!({type:"assistant_text",upstreamSeq:1,text:"second only",deltaText:"second only",replace:false});
  for(let index=0;index<100&&(!(await api.get(firstId))?.stream||!(await api.get(secondId))?.stream);index++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await api.get(firstId))?.stream?.text,"first only");assert.equal((await api.get(secondId))?.stream?.text,"second only");
  await api.abortRun(firstId);requests.get(firstId)!.stream!({type:"assistant_text",upstreamSeq:2,text:"late",deltaText:"late",replace:false});
  for(let index=0;index<100&&(await api.get(firstId))?.status!=="aborted";index++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await api.get(firstId))?.status,"aborted");assert.equal((await api.get(firstId))?.stream,undefined);
  releaseSecond();for(let index=0;index<100&&(await api.get(secondId))?.status!=="completed";index++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal((await api.get(secondId))?.status,"completed");
});

test("run store 拒绝符号链接根目录", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-run-symlink-")),outside=await mkdtemp(join(tmpdir(),"generation-run-outside-"));t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]));
  await symlink(outside,join(root,"runs"));const {PanelRunStore}=await import("../src/server/run-store.js");await assert.rejects(new PanelRunStore(root).initialize(),/根目录不安全/);
});

test("committing 已取得提交权后不可取消，重启会清理无法续观的 gateway orphan", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-commit-claim-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});const cleaned:string[]=[];
  const api=new PanelGenerationApi({async generate(){throw new Error("not called")},async cleanupOrphanedSession(request){cleaned.push(request.sessionKey);return[]}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await api.initialize();
  const {PanelRunStore}=await import("../src/server/run-store.js");const store=new PanelRunStore(root),now=new Date().toISOString(),committingId="12121212-1212-4121-8121-121212121212";
  await store.put({version:1,runId:committingId,recordId:metadata.recordId,requestHash:"hash",sequence:3,status:"committing",createdAt:now,updatedAt:now});
  const claim=await api.abortRun(committingId);assert.equal(claim?.status,"committing");assert.equal(claim?.canAbort,false);
  const orphanId="34343434-3434-4343-8343-343434343434";await store.put({version:1,runId:orphanId,recordId:metadata.recordId,requestHash:"hash2",sequence:3,status:"running",createdAt:now,updatedAt:now,runtimeAgentId:"runtime",temporarySessionId:"temp",temporarySessionKey:"agent:runtime:temp",gatewayRunId:"gateway"});
  const restarted=new PanelGenerationApi({async generate(){throw new Error("must not replay")},async cleanupOrphanedSession(request){cleaned.push(request.sessionKey);return[]}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await restarted.initialize();
  assert.equal((await restarted.get(orphanId))?.status,"failed");assert.deepEqual(cleaned,["agent:runtime:temp"]);
});

test("transcript 已原子提交但 run 终态持久化失败时，重启恢复为 completed 而非 failed", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-after-rename-"));t.after(()=>rm(root,{recursive:true,force:true}));const planned="56565656-5656-4565-8565-565656565656";
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});await commitPanelTranscript(root,metadata,{header:{type:"session"},entries:[{type:"message",id:planned,parentId:null,message:{role:"user",content:"already committed"}},{type:"message",id:"answer",parentId:planned,message:{role:"assistant",content:"done"}}]});
  const {PanelRunStore}=await import("../src/server/run-store.js");const store=new PanelRunStore(root),now=new Date().toISOString(),runId="78787878-7878-4787-8787-787878787878";await store.put({version:1,runId,recordId:metadata.recordId,requestHash:"hash",sequence:5,status:"committing",createdAt:now,updatedAt:now,message:"already committed",plannedUserEntryId:planned,stagedEntries:[]});
  let calls=0;const api=new PanelGenerationApi({async generate(){calls++;throw new Error("must not replay")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await api.initialize();assert.equal(calls,0);assert.equal((await api.get(runId))?.status,"completed");const persisted=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal("message" in persisted,false);
});

test("staged 恢复提交失败时基于 latest 状态清理 orphan 并持久化 cleanup 结果", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-staged-cleanup-"));t.after(()=>rm(root,{recursive:true,force:true}));const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  const {PanelRunStore}=await import("../src/server/run-store.js");const store=new PanelRunStore(root),now=new Date().toISOString(),runId="90909090-9090-4909-8909-909090909090",planned="91919191-9191-4919-8919-919191919191";
  await store.put({version:1,runId,recordId:metadata.recordId,requestHash:"hash",sequence:7,status:"materializing",createdAt:now,updatedAt:now,message:"staged",plannedUserEntryId:planned,baseRevision:"stale",stagedEntries:[{type:"message",id:"answer",parentId:planned,message:{role:"assistant",content:"done"}}],runtimeAgentId:"runtime",temporarySessionId:"temp",temporarySessionKey:"agent:runtime:staged",gatewayRunId:"gateway",cleanupPending:true});
  const cleaned:string[]=[];const api=new PanelGenerationApi({async generate(){throw new Error("must not replay")},async cleanupOrphanedSession(request){cleaned.push(request.sessionKey);return[]}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await api.initialize();
  const terminal=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal(terminal.status,"failed");assert.equal(terminal.cleanupPending,false);assert.ok(terminal.sequence>7);assert.deepEqual(cleaned,["agent:runtime:staged"]);assert.equal("stagedEntries" in terminal,false);
});
