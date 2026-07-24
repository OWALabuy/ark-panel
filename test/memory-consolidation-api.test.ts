import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelMemoryConsolidationApi } from "../src/server/memory-consolidation-api.js";
import { MemoryConsolidationStore } from "../src/storage/memory-consolidation.js";
import type { BridgeService } from "../src/gateway/bridge-service.js";

const document = { header: { type: "session", version: 3, id: "session" }, entries: [
  { type: "message", id: "u1", parentId: null, message: { role: "user", content: "My preference" } },
  { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "Noted" } }
] };

test("eligible 会话在独立受限 bridge 生成整份候选并确认，来源 transcript 不变", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-api-")), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  const sourceJson = JSON.stringify(document), calls: unknown[] = [];
  const sources = { async memorySource() { return { record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: "rev", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: "eligible" as const }, document, overrides: { modelOverride: "provider/model", thinkingLevel: "high" } }; } };
  const bridge = { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) { calls.push(request); await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" }); return { runId: "run", sessionId: "temporary", entries: [{ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: "# Memory\n\n- Stable preference" } }] }; } } as unknown as BridgeService;
  const tools = { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["memory_search"] }; },
    async refreshMemoryIndex(agentIds: readonly string[]) { calls.push({ indexed: agentIds }); } };
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(data), sources, new Map([["agent", {
    runtimeAgentId: "panel-memory-agent", workspaceRoot: workspace, indexAgentIds: ["agent", "panel-agent-runtime", "panel-memory-agent"]
  }]]), bridge, tools);
  const candidate = await api.candidate("record"); assert.equal(candidate.content, "# Memory\n\n- Stable preference"); assert.equal(JSON.stringify(document), sourceJson);
  assert.deepEqual((calls[0] as { overrides: unknown }).overrides, { modelOverride: "provider/model", thinkingLevel: "high" });
  const ledger = await api.confirm(candidate.batchId, candidate.contentHash); assert.match(await readFile(join(workspace, ledger.targetPath), "utf8"), /Stable preference/);
  assert.deepEqual((calls.at(-1) as { indexed: string[] }).indexed, ["agent", "panel-agent-runtime", "panel-memory-agent"]);
});

test("再次整理只发送 checkpoint 后原文，并显式合并上一版已确认会话记忆", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-rolling-")), data = join(root, "data"), workspace = join(root, "workspace"); await mkdir(data); await mkdir(workspace);
  let current = structuredClone(document), revision = "rev-1"; const calls: Array<{ historyThroughPreviousRun: typeof document; latestUserMessage: string; lifecycle?: (event: unknown) => Promise<void> }> = [];
  const sources = { async memorySource() { return { record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision, updatedAt: "now", messageCount: current.entries.length, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: "eligible" as const }, document: current, overrides: {} }; } };
  const bridge = { async generate(request: typeof calls[number]) { calls.push(request); await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" });
    const content = calls.length === 1 ? "# Memory\n\n- Existing preference" : "# Memory\n\n- Existing preference\n- New decision";
    return { runId: "run", sessionId: "temporary", entries: [{ type: "message", id: "answer", parentId: null, message: { role: "assistant", content } }] }; } } as unknown as BridgeService;
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(data), sources, new Map([["agent", {
    runtimeAgentId: "panel-memory-agent", workspaceRoot: workspace, indexAgentIds: ["agent", "panel-agent-runtime", "panel-memory-agent"]
  }]]), bridge,
    { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["memory_get", "memory_search"] }; },
      async refreshMemoryIndex() {} });
  assert.deepEqual(await api.status("record"), { available: true, eligible: true, pending: true });
  const first = await api.candidate("record"), firstLedger = await api.confirm(first.batchId, first.contentHash);
  assert.deepEqual(await api.status("record"), { available: true, eligible: true, pending: false });
  current = { ...current, entries: [...current.entries,
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "New decision" } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "Recorded" } }] }; revision = "rev-2";
  assert.deepEqual(await api.status("record"), { available: true, eligible: true, pending: true });
  const second = await api.candidate("record");
  assert.deepEqual(calls[1]!.historyThroughPreviousRun.entries.map(entry => entry.id), ["u2", "a2"]);
  assert.match(calls[1]!.latestUserMessage, /上一版已确认会话记忆/); assert.match(calls[1]!.latestUserMessage, /Existing preference/);
  const secondLedger = await api.confirm(second.batchId, second.contentHash);
  assert.equal(secondLedger.targetPath, firstLedger.targetPath);
  assert.equal(await readFile(join(workspace, secondLedger.targetPath), "utf8"), "# Memory\n\n- Existing preference\n- New decision\n");
});

test("pending 状态不暴露 checkpoint，scratch 或未配置 runtime 不阻止直接 compact", async () => {
  const root=await mkdtemp(join(tmpdir(),"panel-memory-status-"));await mkdir(join(root,"data"));await mkdir(join(root,"workspace"));
  let disposition:"eligible"|"scratch"="scratch",agentId="agent";
  const sources={async memorySource(){return{record:{recordId:"record",agentId,sourceKind:"panel" as const,sourceKey:"record",revision:"rev",updatedAt:"now",messageCount:2,title:"title",archived:false,hidden:false,pinned:false,memoryDisposition:disposition},document,overrides:{}}}};
  const api=new PanelMemoryConsolidationApi(new MemoryConsolidationStore(join(root,"data")),sources,new Map([["agent",{runtimeAgentId:"memory",workspaceRoot:join(root,"workspace"),indexAgentIds:["agent"]}]]),{} as BridgeService,{async effectiveTools(){return{agentId:"memory",scope:"effective-session-tools" as const,toolIds:[]}},async refreshMemoryIndex(){}});
  assert.deepEqual(await api.status("record"),{available:true,eligible:false,pending:false});
  disposition="eligible";agentId="unconfigured";
  const value=await api.status("record");assert.deepEqual(value,{available:false,eligible:true,pending:false});
  assert.equal("checkpointEntryId" in value,false);
});

test("scratch 来源与含副作用工具的 runtime 在调用模型前被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-deny-")); await mkdir(join(root, "data")); await mkdir(join(root, "workspace")); let bridgeCalls = 0;
  const source = (disposition: "eligible" | "scratch") => ({ record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: "rev", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: disposition }, document, overrides: {} });
  let disposition: "eligible" | "scratch" = "scratch";
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(join(root, "data")), { async memorySource() { return source(disposition); } },
    new Map([["agent", { runtimeAgentId: "panel-memory-agent", workspaceRoot: join(root, "workspace"), indexAgentIds: ["agent", "panel-memory-agent"] }]]), { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) { await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" }); bridgeCalls++; throw new Error("unexpected"); } } as unknown as BridgeService,
    { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["exec"] }; }, async refreshMemoryIndex() {} });
  await assert.rejects(api.candidate("record"), /MEMORY_SOURCE_NOT_ELIGIBLE/); disposition = "eligible";
  await assert.rejects(api.candidate("record"), /MEMORY_RUNTIME_NOT_RESTRICTED/); assert.equal(bridgeCalls, 0);
});

test("候选生成期间离开原分支时拒绝保存候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-branch-")); await mkdir(join(root, "data")); await mkdir(join(root, "workspace")); let branched = false;
  const sources = { async memorySource() { return { record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: branched ? "rev-2" : "rev-1", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: "eligible" as const }, document: branched ? { ...document, entries: [document.entries[0]!, { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: "other branch" } }] } : document, overrides: {} }; } };
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(join(root, "data")), sources,
    new Map([["agent", { runtimeAgentId: "panel-memory-agent", workspaceRoot: join(root, "workspace"), indexAgentIds: ["agent", "panel-memory-agent"] }]]),
    { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) { await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" }); branched = true; return { runId: "run", sessionId: "temporary", entries: [{ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: "candidate" } }] }; } } as unknown as BridgeService,
    { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: [] }; }, async refreshMemoryIndex() {} });
  await assert.rejects(api.candidate("record"), /MEMORY_SOURCE_CHANGED_DURING_PREVIEW/);
});

test("索引刷新失败不回滚已确认记忆，重试确认会再次刷新", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-index-retry-")), data = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(data); await mkdir(workspace); let refreshes = 0;
  const sources = { async memorySource() { return { record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: "rev", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: "eligible" as const }, document, overrides: {} }; } };
  const bridge = { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) {
    await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" });
    return { runId: "run", sessionId: "temporary", entries: [{ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: "durable memory" } }] };
  } } as unknown as BridgeService;
  const store = new MemoryConsolidationStore(data);
  const api = new PanelMemoryConsolidationApi(store, sources, new Map([["agent", {
    runtimeAgentId: "panel-memory-agent", workspaceRoot: workspace, indexAgentIds: ["agent", "panel-agent-runtime", "panel-memory-agent"]
  }]]), bridge, {
    async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["memory_search"] }; },
    async refreshMemoryIndex() { if (++refreshes === 1) throw new Error("fixture failure"); }
  });
  const candidate = await api.candidate("record");
  await assert.rejects(api.confirm(candidate.batchId, candidate.contentHash), /MEMORY_INDEX_REFRESH_FAILED/);
  assert.match(await readFile(join(workspace, candidate.targetPath), "utf8"), /durable memory/);
  assert.equal(await store.checkpoint("record"), candidate.throughEntryId);
  const ledger = await api.confirm(candidate.batchId, candidate.contentHash);
  assert.equal(ledger.batchId, candidate.batchId); assert.equal(refreshes, 2);
});
