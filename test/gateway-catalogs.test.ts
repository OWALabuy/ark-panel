import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandsCatalog, parseConfiguredToolsCatalog, parseGatewayStatus, parseModelsCatalog, sessionPatchParams } from "../src/gateway/cli-client.js";

test("commands.list 只暴露稳定的规范 DTO", () => {
  assert.deepEqual(parseCommandsCatalog({ commands: [{ name: "think", nativeName: "think", textAliases: ["/think", 3], description: "Set level", category: "options", source: "native", scope: "both", acceptsArgs: true,
    args: [{ name: "level", type: "string", required: false, dynamic: true, choices: [{ value: "high", label: "High" }] }], futureField: true }] }), { commands: [{ name: "think", nativeName: "think", textAliases: ["/think"], description: "Set level", category: "options", source: "native", scope: "both", acceptsArgs: true,
      args: [{ name: "level", type: "string", required: false, dynamic: true, choices: [{ value: "high", label: "High" }] }] }] });
  assert.throws(() => parseCommandsCatalog({ commands: [{ acceptsArgs: false }] }), /COMMAND_NAME/);
});

test("models list 规范化 count 并拒绝缺少关键字段", () => {
  const result = parseModelsCatalog({ count: 99, models: [{ key: "p/m", name: "Model", input: "text", contextWindow: 1000, available: true, tags: ["default", 1], missing: false, local: false }] });
  assert.deepEqual(result, { count: 1, models: [{ key: "p/m", name: "Model", input: "text", contextWindow: 1000, available: true, tags: ["default"], missing: false }] });
  assert.throws(() => parseModelsCatalog({ models: [{ key: "p/m" }] }), /INVALID_MODEL/);
});

test("status 要求顶层对象并保留全局状态 payload", () => {
  const status = { runtimeVersion: "2026.6.11", tasks: { active: 1 } };
  assert.deepEqual(parseGatewayStatus(status), status);
  assert.throws(() => parseGatewayStatus([]), /INVALID_STATUS/);
});

test("tools.catalog 只保留稳定配置目录 DTO", () => {
  assert.deepEqual(parseConfiguredToolsCatalog({ agentId: "panel-runtime-agent", profiles: [{ id: "full" }], groups: [{ id: "core", label: "Core", source: "core", tools: [
    { id: "read", label: "Read", description: "Read files", source: "core", risk: "low", tags: ["files", 3], defaultProfiles: ["coding", 4], future: true }
  ] }] }), { agentId: "panel-runtime-agent", scope: "configured-runtime-catalog", groups: [{ id: "core", label: "Core", source: "core", tools: [
    { id: "read", label: "Read", description: "Read files", source: "core", risk: "low", tags: ["files"], defaultProfiles: ["coding"] }
  ] }] });
  assert.throws(() => parseConfiguredToolsCatalog({ agentId: "a", groups: [{ id: "x", label: "X", source: "channel", tools: [] }] }), /INVALID_TOOL_CATALOG_GROUP/);
});

test("session override 映射成 sessions.patch 的上游字段", () => {
  assert.deepEqual(sessionPatchParams("agent:runtime:key", { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "on" }),
    { key: "agent:runtime:key", model: "provider/model", thinkingLevel: "high", reasoningLevel: "on" });
  assert.equal("modelOverride" in sessionPatchParams("key", { modelOverride: "provider/model" }), false);
});
