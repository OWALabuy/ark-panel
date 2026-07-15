import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitPanelTranscript, createPanelSession, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
import { PanelGenerationApi } from "../src/server/generation-api.js";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";

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
