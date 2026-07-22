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
  const tools = { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["memory_search"] }; } };
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(data), sources, new Map([["agent", { runtimeAgentId: "panel-memory-agent", workspaceRoot: workspace }]]), bridge, tools);
  const candidate = await api.candidate("record"); assert.equal(candidate.content, "# Memory\n\n- Stable preference"); assert.equal(JSON.stringify(document), sourceJson);
  assert.deepEqual((calls[0] as { overrides: unknown }).overrides, { modelOverride: "provider/model", thinkingLevel: "high" });
  const ledger = await api.confirm(candidate.batchId, candidate.contentHash); assert.match(await readFile(join(workspace, ledger.targetPath), "utf8"), /Stable preference/);
});

test("scratch 来源与含副作用工具的 runtime 在调用模型前被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-deny-")); await mkdir(join(root, "data")); await mkdir(join(root, "workspace")); let bridgeCalls = 0;
  const source = (disposition: "eligible" | "scratch") => ({ record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: "rev", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: disposition }, document, overrides: {} });
  let disposition: "eligible" | "scratch" = "scratch";
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(join(root, "data")), { async memorySource() { return source(disposition); } },
    new Map([["agent", { runtimeAgentId: "panel-memory-agent", workspaceRoot: join(root, "workspace") }]]), { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) { await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" }); bridgeCalls++; throw new Error("unexpected"); } } as unknown as BridgeService,
    { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: ["exec"] }; } });
  await assert.rejects(api.candidate("record"), /MEMORY_SOURCE_NOT_ELIGIBLE/); disposition = "eligible";
  await assert.rejects(api.candidate("record"), /MEMORY_RUNTIME_NOT_RESTRICTED/); assert.equal(bridgeCalls, 0);
});

test("候选生成期间离开原分支时拒绝保存候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-branch-")); await mkdir(join(root, "data")); await mkdir(join(root, "workspace")); let branched = false;
  const sources = { async memorySource() { return { record: { recordId: "record", agentId: "agent", sourceKind: "panel" as const, sourceKey: "record", revision: branched ? "rev-2" : "rev-1", updatedAt: "now", messageCount: 2, title: "title", archived: false, hidden: false, pinned: false, memoryDisposition: "eligible" as const }, document: branched ? { ...document, entries: [document.entries[0]!, { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: "other branch" } }] } : document, overrides: {} }; } };
  const api = new PanelMemoryConsolidationApi(new MemoryConsolidationStore(join(root, "data")), sources,
    new Map([["agent", { runtimeAgentId: "panel-memory-agent", workspaceRoot: join(root, "workspace") }]]),
    { async generate(request: { lifecycle?: (event: unknown) => Promise<void> }) { await request.lifecycle?.({ type: "temporary_session_created", runtimeAgentId: "panel-memory-agent", sessionId: "temporary", sessionKey: "agent:panel-memory-agent:temporary", transcriptPath: "/fixture" }); branched = true; return { runId: "run", sessionId: "temporary", entries: [{ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: "candidate" } }] }; } } as unknown as BridgeService,
    { async effectiveTools() { return { agentId: "panel-memory-agent", scope: "effective-session-tools" as const, toolIds: [] }; } });
  await assert.rejects(api.candidate("record"), /MEMORY_SOURCE_CHANGED_DURING_PREVIEW/);
});
