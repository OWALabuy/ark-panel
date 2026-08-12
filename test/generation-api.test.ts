import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitPanelTranscript, createPanelSession, loadPanelSession, updatePanelMetadata } from "../src/storage/panel-sessions.js";
import { PanelGenerationApi } from "../src/server/generation-api.js";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import type { BridgeRequest } from "../src/gateway/adapter.js";
import { listSessionAttachments, readSessionAttachmentBytes, storeSessionAttachment } from "../src/storage/attachments.js";
import { PanelRunStore, type PanelRunRecord } from "../src/server/run-store.js";
import { deferred, tempFixture, waitFor, withTimeout, writeThenFailBeforeDirectorySync } from "./test-helpers.js";
import { GatewayControlError } from "../src/gateway/stream-client.js";

interface RunStoreTestHooks {
  onDirectoryScan?(): void;
  onRecordRead?(runId: string): void;
  beforeRecordRead?(runId: string): Promise<void>;
  writeRunRecord?(path: string, data: string): Promise<void>;
}
const TestPanelRunStore = PanelRunStore as unknown as new (dataRoot: string, hooks: RunStoreTestHooks) => PanelRunStore;
// Like output capture's race hooks, these runtime-only seams are reached through a local structural
// cast; the exported constructors and GenerationConfig intentionally do not expose them.
const TestPanelGenerationApi = PanelGenerationApi as unknown as new (
  bridge: ConstructorParameters<typeof PanelGenerationApi>[0], config: ConstructorParameters<typeof PanelGenerationApi>[1],
  hooks: { createRunStore(dataRoot: string): PanelRunStore }
) => PanelGenerationApi;

function generationApiWithRunStoreHooks(bridge: ConstructorParameters<typeof PanelGenerationApi>[0],
  config: ConstructorParameters<typeof PanelGenerationApi>[1], hooks: RunStoreTestHooks): PanelGenerationApi {
  return new TestPanelGenerationApi(bridge, config, { createRunStore: dataRoot => new TestPanelRunStore(dataRoot, hooks) });
}

test("附件原样交给 OpenClaw，输入与本轮模型产出作为消息块持久化", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-attachments-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp(join(tmpdir(), "generation-workspace-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const officeBytes = Buffer.from("raw-office-fixture");
  const uploaded = await storeSessionAttachment(root, { fileName: "notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: officeBytes },
  { agentId: "claude", recordId: metadata.recordId, messageId: "pending_11111111-1111-4111-8111-111111111111", role: "user" });
  const api = new PanelGenerationApi({ async generate(request) {
    assert.equal(request.deferSuccessfulCleanup, true);
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
  await api.create(metadata.recordId, "分析附件", runId, undefined, [uploaded.manifest.attachmentId], true);
  await waitFor(async () => (await api.get(runId))?.status === "completed", "attachment run completion");
  await waitFor(async () => JSON.parse(await readFile(join(root, "runs", `${runId}.json`), "utf8")).cleanupPending === false,
    "deferred attachment run cleanup");
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

test("只有显式请求文件的轮次才向 bridge 提供可信 workspace 输出目录", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-output-intent-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp(join(tmpdir(), "generation-output-intent-workspace-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const ordinary = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const requested = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const captures: Array<string | undefined> = [];
  const api = new PanelGenerationApi({ async generate(request) {
    captures.push(request.outputCapture?.workspaceRoot);
    return { runId: request.idempotencyKey, sessionId: "temp", entries: [
      { type: "message", id: randomUUID(), parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
    ] };
  } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]), workspaceByAgent: new Map([["claude", workspace]]) });
  await api.generate(ordinary.recordId, "只回复文字", new AbortController().signal);
  await api.generate(requested.recordId, "生成报告文件", new AbortController().signal, randomUUID(), undefined, [], true);
  assert.deepEqual(captures, [undefined, workspace]);
});

test("重启恢复 accepted run 时保留文件产出意图", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-output-recovery-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await mkdtemp(join(tmpdir(), "generation-output-recovery-workspace-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const runId = "42424242-4242-4242-8242-424242424242", plannedUserEntryId = "43434343-4343-4343-8343-434343434343", now = new Date().toISOString();
  const { PanelRunStore } = await import("../src/server/run-store.js"); const store = new PanelRunStore(root);
  await store.put({ version: 1, runId, recordId: metadata.recordId, requestHash: "fixture", sequence: 1, status: "accepted",
    createdAt: now, updatedAt: now, message: "生成文件", plannedUserEntryId, requestOutputs: true });
  let capture: string | undefined;
  const api = new PanelGenerationApi({ async generate(request) { capture = request.outputCapture?.workspaceRoot; return {
    runId: request.idempotencyKey, sessionId: "temp", entries: [
      { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
    ] }; } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]), workspaceByAgent: new Map([["claude", workspace]]) });
  await api.initialize();
  await waitFor(async () => (await api.get(runId))?.status === "completed", "recovered output run completion");
  assert.equal((await api.get(runId))?.status, "completed"); assert.equal(capture, workspace);
});

test("续聊时把历史图片恢复为 OpenClaw image 块，其他附件降级为文字说明", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-history-attachments-")); t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const image = await storeSessionAttachment(root, { fileName: "图片.png", mimeType: "image/png", bytes: Buffer.from("image-bytes") },
    { agentId: "claude", recordId: metadata.recordId, messageId: "u-image", role: "user" });
  const office = await storeSessionAttachment(root, { fileName: "说明.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: Buffer.from("office-bytes") },
    { agentId: "claude", recordId: metadata.recordId, messageId: "u-image", role: "user" });
  await commitPanelTranscript(root, metadata, { header: { type: "session" }, entries: [
    { type: "message", id: "u-image", parentId: null, message: { role: "user", content: [
      { type: "text", text: "看图" },
      { type: "attachment", attachmentId: image.manifest.attachmentId, fileName: image.manifest.fileName, mimeType: image.manifest.mimeType },
      { type: "attachment", attachmentId: office.manifest.attachmentId, fileName: office.manifest.fileName, mimeType: office.manifest.mimeType }
    ] } },
    { type: "message", id: "a-image", parentId: "u-image", message: { role: "assistant", content: [{ type: "text", text: "看到了" }] } }
  ] });
  let history: BridgeRequest["historyThroughPreviousRun"] | undefined;
  const api = new PanelGenerationApi({ async generate(request) { history = request.historyThroughPreviousRun; return { runId: request.idempotencyKey,
    sessionId: "temp", entries: [{ type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }] }; } },
  { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await api.generate(metadata.recordId, "继续", new AbortController().signal);
  const blocks = ((history!.entries[0]!.message as { content: Array<Record<string, unknown>> }).content);
  assert.deepEqual(blocks[1], { type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" });
  assert.deepEqual(blocks[2], { type: "text", text: "[附件：说明.docx（application/vnd.openxmlformats-officedocument.wordprocessingml.document）]" });
  const durable = await loadPanelSession(root, "claude", metadata.recordId);
  assert.equal(((durable.document.entries[0]!.message as { content: Array<Record<string, unknown>> }).content[1]?.type), "attachment");
});

test("GenerationApi 只在完整 bridge 成功后原子提交 user 和 run，并保持 parent 链", async t => {
  const root = await tempFixture(t, "generation-api-");
  const metadata = await createPanelSession(root, "claude", { header: { type: "session", version: 3, panel: { recordId: "record" } }, entries: [
    { type: "message", id: "previous", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "旧回复" }] } }
  ] });
  const api = new PanelGenerationApi({ async generate(request) { return { runId: "run", sessionId: "temp", entries: [
    { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: [{ type: "text", text: "新回复" }] } }
  ], contextUsage: { source: "openclaw-session", totalTokens: 8_000, contextTokens: 200_000, totalTokensFresh: true } }; } },
  { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime-claude"]]) });
  await api.generate(metadata.recordId, "新问题", new AbortController().signal);
  const { document } = await loadPanelSession(root, "claude", metadata.recordId);
  assert.equal(document.entries.length, 3); assert.equal(document.entries[1]?.parentId, "previous"); assert.equal(document.entries[2]?.parentId, document.entries[1]?.id);
  assert.deepEqual((document.header.panel as { contextUsage?: unknown }).contextUsage, {
    source: "openclaw-session", totalTokens: 8_000, contextTokens: 200_000, totalTokensFresh: true, throughEntryId: "answer"
  });
});

test("压缩后生成从规范 active leaf 续接，不接到文件末尾 side entry", async t => {
  const root = await tempFixture(t, "generation-active-leaf-");
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
    { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-07-24T12:00:00.000Z", summary: "summary", firstKeptEntryId: "u1", tokensBefore: 10 },
    { type: "custom", id: "side", parentId: "c1", appendMode: "side" }
  ] });
  const api = new PanelGenerationApi({ async generate(request) { return { runId: request.idempotencyKey, sessionId: "temp", entries: [
    { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
  ] }; } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await api.generate(metadata.recordId, "continue", new AbortController().signal);
  const document = (await loadPanelSession(root, "claude", metadata.recordId)).document;
  const user = document.entries.find(entry => entry.message && (entry.message as { role?: string }).role === "user" && entry.id !== "u1");
  assert.equal(user?.parentId, "c1");
});

test("bridge 失败不写入 user entry", async t => {
  const root = await tempFixture(t, "generation-api-"); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const api = new PanelGenerationApi({ async generate() { throw new Error("failed"); } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await assert.rejects(api.generate(metadata.recordId, "不会提交", new AbortController().signal), /failed/);
  assert.equal((await loadPanelSession(root, "claude", metadata.recordId)).document.entries.length, 0);
});

test("GenerationApi 把持久化会话设置传给下一轮 bridge", async t => {
  const root = await tempFixture(t, "generation-overrides-");
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  await updatePanelMetadata(root, "claude", metadata.recordId, current => ({ ...current, modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" }));
  let seen: unknown;
  const api = new PanelGenerationApi({ async generate(request) { seen = request.overrides; return { runId: request.idempotencyKey, sessionId: "temp", entries: [] }; } },
    { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await api.generate(metadata.recordId, "hello", new AbortController().signal);
  assert.deepEqual(seen, { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" });
});

test("同一 idempotency key 共享并缓存结果，其他并发写被拒绝", async t => {
  const root = await tempFixture(t, "generation-retry-"); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  let calls = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const api = new PanelGenerationApi({ async generate(request) { calls++; await gate; return { runId: request.idempotencyKey, sessionId: "temp", entries: [
    { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
  ] }; } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  const signal = new AbortController().signal, runId = "11111111-1111-4111-8111-111111111111";
  const first = api.generate(metadata.recordId, "same", signal, runId); const retry = api.generate(metadata.recordId, "same", signal, runId);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, "different-revision"), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, undefined, ["att_fixture"]), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "other", signal, "22222222-2222-4222-8222-222222222222"), /SESSION_BUSY/);
  release(); assert.deepEqual(await first, await retry); assert.equal(calls, 1);
  await api.generate(metadata.recordId, "same", signal, runId, undefined, [], false); assert.equal(calls, 1);
  await assert.rejects(api.generate(metadata.recordId, "different", signal, runId), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, "different-revision"), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, undefined, ["att_fixture"]), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, undefined,
    ["att_invalid", "att_invalid"]), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.generate(metadata.recordId, "same", signal, runId, undefined, [], true), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal(calls, 1);
});

test("既有 requestOutputs false 与早期无附件 durable 指纹仍可幂等读取", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-legacy-fingerprint-")); t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "35353535-3535-4535-8535-353535353535", legacyRunId = "36363636-3636-4636-8636-363636363636";
  const now = "2026-08-12T00:00:00.000Z";
  const store = new PanelRunStore(root); await store.put({ version: 1, runId, recordId: "panel_fixture",
    requestHash: "33849afc1675c631d17f2cebee94781e24a4f8a128bdb200d6db26ca5f317147", sequence: 2,
    status: "completed", createdAt: now, updatedAt: now, finishedAt: now });
  await store.put({ version: 1, runId: legacyRunId, recordId: "panel_fixture",
    requestHash: "7719d1290bca44758cb9b4800f5067cac0072c346b968bfb7b95554cd1d4ae0e", sequence: 2,
    status: "completed", createdAt: now, updatedAt: now, finishedAt: now });
  let calls = 0;
  const api = new PanelGenerationApi({ async generate() { calls++; throw new Error("bridge must not run"); } },
    { dataRoot: root, runtimeByAgent: new Map() });
  const retry = await api.create("panel_fixture", "hello", runId, undefined, [], false);
  assert.equal(retry.newlyCreated, false); assert.equal(retry.status, "completed"); assert.equal(calls, 0);
  const legacyRetry = await api.create("panel_fixture", "hello", legacyRunId);
  assert.equal(legacyRetry.newlyCreated, false); assert.equal(legacyRetry.status, "completed"); assert.equal(calls, 0);
  await assert.rejects(api.create("panel_fixture", "hello", runId, "different-revision"), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.create("panel_fixture", "hello", legacyRunId, undefined, ["att_fixture"]), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.create("panel_fixture", "hello", legacyRunId, undefined, [], true), /IDEMPOTENCY_KEY_REUSED/);
});

test("revision 冲突在调用 bridge 前被拒绝", async t => {
  const root = await tempFixture(t, "generation-revision-"); const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  let calls = 0; const api = new PanelGenerationApi({ async generate() { calls++; throw new Error("should not run"); } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  await assert.rejects(api.generate(metadata.recordId, "message", new AbortController().signal, undefined, "stale"), /REVISION_CONFLICT/); assert.equal(calls, 0);
  const stat = await lstat(join(root,"sessions","claude",metadata.recordId,"transcript.jsonl")); assert.ok(`${stat.size}:${stat.mtimeMs}`);
});

test("completed 幂等缓存严格有界并淘汰最旧结果", async t => {
  const root=await tempFixture(t,"generation-cache-");const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let calls=0;
  const api=new PanelGenerationApi({async generate(request){calls++;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:`a${calls}`,parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]]),completedCacheLimit:2});
  const signal=new AbortController().signal,ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
  for(const id of ids)await api.generate(metadata.recordId,id,signal,id);assert.equal(api.completedCacheSize(),2);assert.equal(calls,3);
  await api.generate(metadata.recordId,ids[0]!,signal,ids[0]!);assert.equal(calls,4);assert.equal(api.completedCacheSize(),2);
});

test("超出上下文预算时在 bridge 前拒绝且不修改 transcript", async t => {
  const root=await tempFixture(t,"generation-budget-");const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[{type:"message",id:"u1",parentId:null,message:{role:"user",content:"x".repeat(500)}}]});let calls=0;
  const api=new PanelGenerationApi({async generate(){calls++;throw new Error("不应调用")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]]),contextBudget:new ConservativeContextBudget(40)});
  await assert.rejects(api.generate(metadata.recordId,"next",new AbortController().signal),/会话有效上下文过长/);assert.equal(calls,0);
  assert.equal((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.length,1);
});

test("斜杠命令在 bridge 前被拒绝且不修改 transcript", async t => {
  const root=await tempFixture(t,"generation-command-");const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});let calls=0;
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
  let calls=0;const started=deferred(),gate=deferred();
  const api=new PanelGenerationApi({async generate(request){calls++;started.resolve();await request.lifecycle?.({type:"temporary_session_created",runtimeAgentId:"runtime",sessionId:"temp",sessionKey:"agent:runtime:temp",transcriptPath:"/tmp/temp.jsonl"});await gate.promise;await request.lifecycle?.({type:"gateway_send_accepted",gatewayRunId:"gateway"});await request.lifecycle?.({type:"entries_materialized",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]});return{runId:"gateway",sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",created=await api.create(metadata.recordId,"private prompt",runId,undefined,[],true);
  assert.equal(created.status,"accepted");assert.equal(created.newlyCreated,true);
  const persisted=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal(persisted.message,"private prompt");assert.equal(persisted.requestOutputs,true);assert.equal(typeof persisted.plannedUserEntryId,"string");
  assert.equal((await api.create(metadata.recordId,"private prompt",runId,undefined,[],true)).newlyCreated,false);await withTimeout(started.promise,"background bridge start");assert.equal(calls,1);
  await assert.rejects(api.create(metadata.recordId,"private prompt",runId),/IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.create(metadata.recordId,"different",runId),/IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(api.create(metadata.recordId,"other","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),/SESSION_BUSY/);
  gate.resolve();await waitFor(async()=>(await api.get(runId))?.status==="completed","background run completion");
  assert.equal((await api.get(runId))?.status,"completed");const terminal=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));
  assert.equal("message" in terminal,false);assert.equal("requestOutputs" in terminal,false);assert.equal("stagedEntries" in terminal,false);assert.equal(terminal.gatewayRunId,"gateway");
});

test("大量终态 run 不增加创建、活跃查询或附件维护的目录扫描", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-active-index-")); t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const seed = new PanelRunStore(root), now = "2026-08-12T00:00:00.000Z";
  for (let index = 1; index <= 96; index++) {
    const id = `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const record: PanelRunRecord = { version: 1, runId: id, recordId: `terminal-${index}`, requestHash: `hash-${index}`,
      sequence: 2, status: "completed", createdAt: now, updatedAt: now, finishedAt: now };
    await seed.put(record);
  }
  const observed = { scans: 0, reads: 0, readRunIds: [] as string[] };
  const runStoreInstrumentation = {
    onDirectoryScan() { observed.scans++; },
    onRecordRead(id: string) { observed.reads++; observed.readRunIds.push(id); }
  };
  const started = deferred(), release = deferred(); t.after(() => release.resolve());
  const api = generationApiWithRunStoreHooks({ async generate(request) {
    started.resolve(); await release.promise;
    return { runId: request.idempotencyKey, sessionId: "temp", entries: [
      { type: "message", id: "answer", parentId: request.latestUserEntryId, message: { role: "assistant", content: "ok" } }
    ] };
  } }, { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) }, runStoreInstrumentation);

  await api.initialize();
  assert.deepEqual({ scans: observed.scans, reads: observed.reads }, { scans: 1, reads: 96 });
  observed.readRunIds.length = 0;
  const runId = "20202020-2020-4020-8020-202020202020";
  await api.create(metadata.recordId, "hello", runId); await withTimeout(started.promise, "indexed generation start");
  assert.equal(observed.scans, 1); assert.ok(observed.readRunIds.length > 0);
  assert.deepEqual(new Set(observed.readRunIds), new Set([runId]));

  const beforeActiveLookup = observed.reads;
  assert.equal((await api.activeForRecord(metadata.recordId))?.runId, runId);
  assert.equal(observed.reads, beforeActiveLookup + 1);
  await api.maintainAttachments(); assert.equal(observed.reads, beforeActiveLookup + 1);
  const competingRunIds = Array.from({ length: 24 }, (_, index) =>
    `21212121-2121-4121-8121-${(index + 1).toString(16).padStart(12, "0")}`);
  const competing = await Promise.allSettled(competingRunIds.map((id, index) => api.create(metadata.recordId, `other-${index}`, id)));
  assert.equal(competing.every(result => result.status === "rejected" && /SESSION_BUSY/.test(String(result.reason))), true);
  assert.deepEqual(new Set(observed.readRunIds), new Set([runId, ...competingRunIds])); assert.equal(observed.scans, 1);

  release.resolve();
  await waitFor(async () => await api.activeForRecord(metadata.recordId) === undefined, "indexed run completion");
  assert.equal(observed.scans, 1);
});

test("accepted 已 rename 但目录 sync 失败后，下一 runId 仍由权威文件判定 SESSION_BUSY", async t => {
  const root = await mkdtemp(join(tmpdir(), "generation-post-rename-busy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  let bridgeCalls = 0, writerCalls = 0, scans = 0;
  const firstRunId = "23232323-2323-4323-8323-232323232323";
  const api = generationApiWithRunStoreHooks(
    { async generate() { bridgeCalls++; throw new Error("bridge must not run"); } },
    { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) },
    { onDirectoryScan() { scans++; },
      async writeRunRecord(path, data) { writerCalls++; await writeThenFailBeforeDirectorySync(path, data); } }
  );

  await assert.rejects(api.create(metadata.recordId, "private fixture prompt", firstRunId), /parent directory sync failed/);
  const visible = JSON.parse(await readFile(join(root, "runs", `${firstRunId}.json`), "utf8"));
  assert.equal(visible.status, "accepted"); assert.equal(bridgeCalls, 0); assert.equal(writerCalls, 1);
  await assert.rejects(api.create(metadata.recordId, "second fixture prompt", "24242424-2424-4424-8424-242424242424"), /SESSION_BUSY/);
  assert.equal(bridgeCalls, 0); assert.equal(writerCalls, 1); assert.equal(scans, 2);
});

test("后台 run 将停止未确认记录为 failed 而不是 aborted", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-abort-unconfirmed-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  const api=new PanelGenerationApi({async generate(){throw new Error("RUN_ABORT_UNCONFIRMED")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="13131313-1313-4313-8313-131313131313";await api.create(metadata.recordId,"message",runId);
  await waitFor(async()=>(await api.get(runId))?.status==="failed","unconfirmed abort failure");
  const run=await api.get(runId);assert.equal(run?.status,"failed");assert.equal(run?.error?.code,"RUN_ABORT_UNCONFIRMED");
});

test("后台 run 保留稳定脱敏的 Gateway 控制错误", async t => {
  const root = await tempFixture(t, "generation-gateway-unavailable-");
  const metadata = await createPanelSession(root, "claude", { header: { type: "session" }, entries: [] });
  const api = new PanelGenerationApi({ async generate() { throw new GatewayControlError("GATEWAY_TRANSPORT_UNAVAILABLE", "private fixture prompt"); } },
    { dataRoot: root, runtimeByAgent: new Map([["claude", "runtime"]]) });
  const runId = "14141414-1414-4414-8414-141414141414";
  await api.create(metadata.recordId, "private fixture prompt", runId);
  await waitFor(async () => (await api.get(runId))?.status === "failed", "Gateway transport failure");
  const run = await api.get(runId);
  assert.deepEqual(run?.error, { code: "GATEWAY_TRANSPORT_UNAVAILABLE", message: "OpenClaw Gateway 控制通道不可用，请检查认证配置。" });
  assert.doesNotMatch(JSON.stringify(run), /private fixture prompt/);
});

test("run 订阅先给快照、终态可重订阅，重启恢复 staged entries 而不重复调用模型", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-recover-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});const gate=deferred();
  const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",api=new PanelGenerationApi({async generate(request){await gate.promise;return{runId:id,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"ok"}}]}}},{dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  await api.create(metadata.recordId,"hello",id);const seen:string[]=[];const unsubscribe=await api.subscribe(id,run=>seen.push(run.status));assert.equal(seen[0] === "accepted" || seen[0] === "running",true);gate.resolve();
  await waitFor(async()=>(await api.get(id))?.status==="completed","subscribed run completion");unsubscribe?.();
  const terminal:string[]=[];await api.subscribe(id,run=>terminal.push(run.status));assert.deepEqual(terminal,["completed"]);

  const recoveryId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",planned="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",now=new Date().toISOString();
  const {PanelRunStore}=await import("../src/server/run-store.js");const store=new PanelRunStore(root);await store.put({version:1,runId:recoveryId,recordId:metadata.recordId,requestHash:"hash",sequence:4,status:"materializing",createdAt:now,updatedAt:now,message:"recovered",plannedUserEntryId:planned,stagedEntries:[{type:"message",id:"recovered-answer",parentId:planned,message:{role:"assistant",content:"done"}}]});
  let calls=0;const recovered=new PanelGenerationApi({async generate(){calls++;throw new Error("must not replay")}}, {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});await recovered.initialize();
  assert.equal(calls,0);assert.equal((await recovered.get(recoveryId))?.status,"completed");assert.ok((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.some(entry=>entry.id===planned));
});

test("流式文本与工具状态只存在于运行快照，终态由 transcript 替换且不持久化增量", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-stream-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const metadata=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  let bridgeRequest: BridgeRequest|undefined;const requestReady=deferred(),gate=deferred();
  const api=new PanelGenerationApi({async generate(request){bridgeRequest=request;requestReady.resolve();await gate.promise;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"最终结果"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const runId="45454545-4545-4545-8545-454545454545";await api.create(metadata.recordId,"hello",runId);
  await withTimeout(requestReady.promise,"stream bridge request");assert.ok(bridgeRequest?.stream);
  const toolCompleted=deferred();const seen:import("../src/server/run-store.js").PublicPanelRun[]=[];const unsubscribe=await api.subscribe(runId,run=>{seen.push(run);if(run.stream?.tools[0]?.phase==="completed")toolCompleted.resolve()});
  bridgeRequest!.stream!({type:"assistant_text",upstreamSeq:1,text:"临时",deltaText:"临",replace:false});
  bridgeRequest!.stream!({type:"tool",upstreamSeq:2,callId:"call",name:"exec",phase:"started",args:{command:"true"}});
  bridgeRequest!.stream!({type:"tool",upstreamSeq:3,callId:"call",name:"exec",phase:"completed"});
  await withTimeout(toolCompleted.promise,"tool completion projection");
  const live=[...seen].reverse().find(run=>run.stream?.tools.length);assert.equal(live?.stream?.text,"临时");assert.equal(live?.stream?.tools[0]?.phase,"completed");assert.deepEqual(live?.stream?.tools[0]?.args,{command:"true"});
  gate.resolve();await waitFor(async()=>(await api.get(runId))?.status==="completed","stream run completion");
  const terminal=await api.get(runId);assert.equal(terminal?.status,"completed");assert.equal(terminal?.stream,undefined);unsubscribe?.();
  const persisted=JSON.parse(await readFile(join(root,"runs",`${runId}.json`),"utf8"));assert.equal("stream" in persisted,false);
  assert.match(JSON.stringify((await loadPanelSession(root,"claude",metadata.recordId)).document.entries.at(-1)),/最终结果/);
});

test("不同会话并发流互不串线，停止后迟到增量被丢弃", async t => {
  const root=await mkdtemp(join(tmpdir(),"generation-stream-concurrent-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]}),second=await createPanelSession(root,"claude",{header:{type:"session"},entries:[]});
  const requests=new Map<string,BridgeRequest>(),requestsReady=deferred();const secondGate=deferred();
  const api=new PanelGenerationApi({async generate(request){requests.set(request.idempotencyKey,request);if(requests.size===2)requestsReady.resolve();if(request.idempotencyKey.startsWith("61")){
    await new Promise<void>((_resolve,reject)=>request.signal?.addEventListener("abort",()=>reject(new Error("BRIDGE_ABORTED")),{once:true}));throw new Error("unreachable");
  }await secondGate.promise;return{runId:request.idempotencyKey,sessionId:"temp",entries:[{type:"message",id:"answer",parentId:request.latestUserEntryId,message:{role:"assistant",content:"second done"}}]}}},
    {dataRoot:root,runtimeByAgent:new Map([["claude","runtime"]])});
  const firstId="61616161-6161-4161-8161-616161616161",secondId="62626262-6262-4262-8262-626262626262";
  await Promise.all([api.create(first.recordId,"one",firstId),api.create(second.recordId,"two",secondId)]);
  await withTimeout(requestsReady.promise,"concurrent bridge requests");assert.equal(requests.size,2);
  requests.get(firstId)!.stream!({type:"assistant_text",upstreamSeq:1,text:"first only",deltaText:"first only",replace:false});
  requests.get(secondId)!.stream!({type:"assistant_text",upstreamSeq:1,text:"second only",deltaText:"second only",replace:false});
  await waitFor(async()=>Boolean((await api.get(firstId))?.stream&&(await api.get(secondId))?.stream),"both stream snapshots");
  assert.equal((await api.get(firstId))?.stream?.text,"first only");assert.equal((await api.get(secondId))?.stream?.text,"second only");
  await api.abortRun(firstId);requests.get(firstId)!.stream!({type:"assistant_text",upstreamSeq:2,text:"late",deltaText:"late",replace:false});
  await waitFor(async()=>(await api.get(firstId))?.status==="aborted","first run abort");
  assert.equal((await api.get(firstId))?.status,"aborted");assert.equal((await api.get(firstId))?.stream,undefined);
  secondGate.resolve();await waitFor(async()=>(await api.get(secondId))?.status==="completed","second run completion");
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
