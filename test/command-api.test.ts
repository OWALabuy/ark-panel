import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelSession, loadPanelSession } from "../src/storage/panel-sessions.js";
import { PANEL_COMMAND_ALLOWLIST_VERSION, PanelCommandApi, transcriptUsage } from "../src/server/command-api.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "panel-command-")), agentId = "agent", recordId = "record";
  await createPanelSession(root, agentId, { header: { type: "session", version: 3, id: "fixture" }, entries: [] }, { recordId });
  const created: Array<[string, string | undefined]> = [];
  const api = new PanelCommandApi(root, [agentId], {
    async models() { return [{ key: "provider/model", name: "Model", available: true, tags: ["alias:fast"] }, { key: "missing/model", available: false }]; },
    async commands() { return { commands: [{ name: "think" }, { name: "dynamic-skill", source: "skill" }] }; }, async status() { return { ok: true }; },
    async tools(agent) { return { agentId: `runtime-${agent}`, scope: "configured-runtime-catalog", groups: [] }; },
    async createPanel(agent, title) { created.push([agent, title]); return { recordId: "new-record" }; }
  });
  return { root, agentId, recordId, api, created };
}

test("A 类命令写 metadata 和系统事件，default 清除覆盖项", async () => {
  const x = await fixture();
  const result = await x.api.dispatch(x.recordId, { command: "/model", args: ["provider/model"] });
  assert.equal(result.allowlistVersion, PANEL_COMMAND_ALLOWLIST_VERSION); assert.equal(result.effect, "updated");
  let loaded = await loadPanelSession(x.root, x.agentId, x.recordId); assert.equal(loaded.metadata.modelOverride, "provider/model");
  assert.equal(loaded.document.entries[0]?.type, "model_change");
  await x.api.dispatch(x.recordId, { command: "reasoning", args: ["stream"] });
  loaded = await loadPanelSession(x.root, x.agentId, x.recordId); assert.equal(loaded.metadata.reasoningLevel, "stream");
  await x.api.dispatch(x.recordId, { command: "reasoning", args: ["default"] });
  assert.equal((await loadPanelSession(x.root, x.agentId, x.recordId)).metadata.reasoningLevel, undefined);
});

test("命令 allowlist 默认拒绝，模型可用性和参数受校验", async () => {
  const x = await fixture();
  await assert.rejects(x.api.dispatch(x.recordId, { command: "/bash", args: ["id"] }), /COMMAND_NOT_ALLOWED/);
  await assert.rejects(x.api.dispatch(x.recordId, { command: "/model", args: ["missing\/model"] }), /MODEL_NOT_AVAILABLE/);
  await assert.rejects(x.api.dispatch(x.recordId, { command: "/reasoning", args: ["verbose"] }), /REASONING_LEVEL_INVALID/);
  await x.api.dispatch(x.recordId, { command: "/model", args: ["fast"] });
  assert.equal((await loadPanelSession(x.root, x.agentId, x.recordId)).metadata.modelOverride, "provider/model");
});

test("思考档在派发时通过真实 override provider 校验，切模型会复核已存档位", async () => {
  const x = await fixture(); const seen: unknown[] = [];
  const api = new PanelCommandApi(x.root, [x.agentId], {
    async models() { return [{ key: "provider/model", available: true }, { key: "provider/other", available: true }]; },
    async commands() { return []; }, async status() { return {}; }, async createPanel() { return {}; },
    async validateOverrides(_agentId, overrides) { seen.push(overrides); if (overrides.modelOverride === "provider/other") throw new Error("upstream rejected"); }
  });
  await api.dispatch(x.recordId, { command: "model", args: ["provider/model"] });
  await api.dispatch(x.recordId, { command: "think", args: ["high"] });
  assert.deepEqual(seen.at(-1), { modelOverride: "provider/model", thinkingLevel: "high" });
  await assert.rejects(api.dispatch(x.recordId, { command: "model", args: ["provider/other"] }), /THINKING_LEVEL_UNSUPPORTED/);
  assert.equal((await loadPanelSession(x.root, x.agentId, x.recordId)).metadata.modelOverride, "provider/model");
});

test("C 类命令只读，new 复用面板会话创建能力", async () => {
  const x = await fixture();
  assert.deepEqual((await x.api.dispatch(x.recordId, { command: "status", args: [] })).data, { ok: true });
  assert.deepEqual((await x.api.dispatch(x.recordId, { command: "commands", args: [] })).data, { commands: [
    { name: "think", supported: true }, { name: "dynamic-skill", source: "skill", supported: false }
  ] });
  assert.deepEqual((await x.api.dispatch(x.recordId, { command: "tools", args: [] })).data, { agentId: "runtime-agent", scope: "configured-runtime-catalog", groups: [] });
  assert.deepEqual((await x.api.dispatch(x.recordId, { command: "usage", args: [] })).data, { source: "model-reported-transcript-usage", scope: "current-branch", estimated: false,
    coverage: { assistantMessages: 0, messagesWithUsage: 0, messagesWithReportedTotal: 0 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reportedTotal: null } });
  await assert.rejects(x.api.dispatch(x.recordId, { command: "dynamic-skill", args: [] }), /COMMAND_NOT_ALLOWED/);
  assert.deepEqual((await x.api.dispatch(x.recordId, { command: "new", args: ["新", "会话"] })).data, { recordId: "new-record" });
  assert.deepEqual(x.created, [[x.agentId, "新 会话"]]);
  const loaded = await loadPanelSession(x.root, x.agentId, x.recordId); assert.equal(loaded.document.entries.length, 0);
});

test("usage 只汇总当前分支中模型实际上报的 token，并公开覆盖率", () => {
  const document = { header: { type: "session" }, entries: [
    { id: "u1", parentId: null, message: { role: "user", content: [] } },
    { id: "a1", parentId: "u1", message: { role: "assistant", content: [], usage: { input: 10, output: 4, cacheRead: 3, total: 17 } } },
    { id: "u2", parentId: "a1", message: { role: "user", content: [] } },
    { id: "old-branch", parentId: "u1", message: { role: "assistant", content: [], usage: { input: 999, output: 999, total: 1998 } } },
    { id: "a2", parentId: "u2", message: { role: "assistant", content: [], usage: { input_tokens: 8, output_tokens: 2, reasoning_tokens: 1 } } }
  ] };
  assert.deepEqual(transcriptUsage(document), { source: "model-reported-transcript-usage", scope: "current-branch", estimated: false,
    coverage: { assistantMessages: 2, messagesWithUsage: 2, messagesWithReportedTotal: 1 },
    tokens: { input: 18, output: 6, cacheRead: 3, cacheWrite: 0, reasoning: 1, reportedTotal: 17 } });
});
