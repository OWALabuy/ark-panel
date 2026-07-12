import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelSession, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
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
