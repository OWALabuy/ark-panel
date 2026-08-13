import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { CreatedSession } from "../src/gateway/adapter.js";
import type { GatewayStreamEvent } from "../src/gateway/stream-client.js";
import { observeToolSchemaFrame, type ToolSchemaCollector } from "../src/gateway/stream-schema-observation.js";
import { inspectToolResultProbeConfig, inspectToolResultProbeRoot, parseToolResultSchemaProbeArguments, runToolResultSchemaProbe,
  ToolResultSchemaProbeError, type ToolResultSchemaProbeDependencies, type ToolResultSchemaProbeRequest } from "../src/gateway/tool-result-schema-probe.js";
import { deferred, tempFixture } from "./test-helpers.js";

const request: ToolResultSchemaProbeRequest = { agentId: "panel-probe-fixture", sessionsRoot: "/fixture/agents/panel-probe-fixture/sessions",
  configPath: "/fixture/openclaw.json", expectedVersion: "2026.6.11", scenario: "exec-printf-v1", maxToolCalls: 1,
  cleanupConfirmation: "delete-created-session-v1", confirmation: "tool-result-schema:panel-probe-fixture:2026.6.11" };
const argv = ["--agent", request.agentId, "--expected-version", request.expectedVersion, "--scenario", request.scenario, "--max-tool-calls", "1", "--cleanup",
  request.cleanupConfirmation, "--confirm", request.confirmation];
const pathEnvironment = { PANEL_TOOL_RESULT_SCHEMA_SESSIONS_ROOT: request.sessionsRoot, PANEL_TOOL_RESULT_SCHEMA_CONFIG_PATH: request.configPath };
const created: CreatedSession = { sessionId: "11111111-1111-4111-8111-111111111111", sessionKey: "agent:panel-probe-fixture:temporary",
  transcriptPath: "/fixture/agents/panel-probe-fixture/sessions/11111111-1111-4111-8111-111111111111.jsonl" };

function fixture(overrides: { gate?: string; version?: string; tools?: readonly string[]; cleanupFails?: boolean; sendFails?: boolean;
  disconnect?: boolean; secondTool?: boolean; endpointOverride?: boolean; acceptedRunId?: string; wrongName?: boolean; wrongArgs?: boolean;
  resultError?: boolean; inspectCreatedFails?: boolean; equalSequence?: boolean; extraTerminal?: boolean } = {}):
  { dependencies: ToolResultSchemaProbeDependencies; calls: string[] } {
  const calls: string[] = []; let collector: ToolSchemaCollector | undefined, listener: ((event: GatewayStreamEvent) => void) | undefined;
  const terminal = deferred();
  const client = { async version() { calls.push("version"); return overrides.version ?? "2026.6.11"; },
    async createSession() { calls.push("create"); return created; }, async effectiveTools() { calls.push("tools");
      return { agentId: request.agentId, scope: "effective-session-tools" as const, toolIds: [...(overrides.tools ?? ["exec"])] }; },
    async send(_key: string, _message: string, runId: string) {
      calls.push("send"); if (overrides.sendFails) throw new Error("private send failure");
      queueMicrotask(() => {
        if (overrides.disconnect) { listener?.({ type: "connection", state: "disconnected" }); return; }
        const toolName = overrides.wrongName ? "read" : "exec", command = overrides.wrongArgs ? "printf wrong" : "printf ark-tool-result-schema-probe";
        const rawStart = { runId, sessionKey: created.sessionKey, seq: 1, stream: "tool", data: { phase: "start", toolCallId: "private-call", name: toolName, args: { command } } };
        observeToolSchemaFrame(collector!, "session.tool", rawStart); listener?.({ type: "tool", runId, sessionKey: created.sessionKey, upstreamSeq: 1,
          callId: "private-call", name: toolName, phase: "started", args: { command } });
        if (overrides.secondTool) {
          const rawSecond = { runId, sessionKey: created.sessionKey, seq: 2, stream: "tool", data: { phase: "start", toolCallId: "second-call", name: "exec",
            args: { command: "printf ark-tool-result-schema-probe" } } };
          observeToolSchemaFrame(collector!, "session.tool", rawSecond); listener?.({ type: "tool", runId, sessionKey: created.sessionKey, upstreamSeq: 2,
            callId: "second-call", name: "exec", phase: "started", args: { command: "printf ark-tool-result-schema-probe" } }); return;
        }
        const rawResult = { runId, sessionKey: created.sessionKey, seq: overrides.equalSequence ? 1 : 2, stream: "tool", data: { phase: "result", toolCallId: "private-call",
          stdout: "ark-tool-result-schema-probe", output: { path: "/private/path", secret: "private result" }, isError: overrides.resultError ?? false } };
        observeToolSchemaFrame(collector!, "session.tool", rawResult); listener?.({ type: "tool", runId, sessionKey: created.sessionKey, upstreamSeq: 2,
          callId: "private-call", name: "exec", phase: "completed" }); terminal.resolve();
        if (overrides.extraTerminal) observeToolSchemaFrame(collector!, "session.tool", { runId, sessionKey: created.sessionKey, seq: 3, stream: "tool",
          data: { phase: "result", toolCallId: "unattributed-call", stdout: "ark-tool-result-schema-probe", isError: false } });
      }); return { runId: overrides.acceptedRunId ?? runId };
    }, async waitForCompletion() { calls.push("wait"); await terminal.promise; }, async abort(_key: string, runId: string) {
      calls.push("abort"); calls.push(`abort-run:${runId}`); },
    async deleteSession() { calls.push("delete"); } };
  const observer = { async observe(_sessionKey: string, next: (event: GatewayStreamEvent) => void) { calls.push("observe"); listener = next;
      next({ type: "connection", state: "connected" }); return () => calls.push("unsubscribe"); },
    stop() { calls.push("stop"); } };
  const dependencies: ToolResultSchemaProbeDependencies = { env: { PANEL_ALLOW_TOOL_RESULT_SCHEMA_PROBE: overrides.gate ?? "1",
      ...(overrides.endpointOverride ? { PANEL_OPENCLAW_GATEWAY_URL: "wss://private.example" } : {}) },
    async loadAuth() { calls.push("auth"); return {}; }, createConnection(_auth, schemaCollector) { calls.push(schemaCollector ? "schema-connection" : "control-connection");
      if (schemaCollector) collector = schemaCollector; return { client, observer }; },
    async cleanup() { calls.push("cleanup"); if (overrides.cleanupFails) throw new Error("private cleanup path"); return 3; },
    randomUUID: () => "22222222-2222-4222-8222-222222222222", setTimer: () => setTimeout(() => {}, 60_000), clearTimer: clearTimeout,
    async inspectConfig(_path, _agent, expected) { calls.push(expected ? "config-recheck" : "config");
      return expected ?? { dev: 3n, ino: 4n, size: 5n, mtimeNs: 6n, digest: "fixture-digest" }; },
    async inspectRoot(_root, _agent, expected) { calls.push(expected ? "root-recheck" : "root"); return expected ?? { dev: 1n, ino: 2n }; },
    async inspectCreated() { calls.push("inspect-created"); if (overrides.inspectCreatedFails) throw new ToolResultSchemaProbeError("PROBE_CREATED_SESSION_INVALID"); } };
  return { dependencies, calls };
}

test("probe arguments require every explicit fixed boundary exactly once", () => {
  assert.deepEqual(parseToolResultSchemaProbeArguments(argv, pathEnvironment), request);
  for (const mutation of [argv.slice(0, -2), [...argv, "--extra", "value"], [...argv, "--agent", request.agentId],
    argv.map(value => value === "exec-printf-v1" ? "free-prompt" : value), argv.map(value => value === "1" ? "2" : value),
    argv.map(value => value === request.confirmation ? "yes" : value), argv.map(value => value === request.agentId ? "ordinary-agent" : value)]) {
    assert.throws(() => parseToolResultSchemaProbeArguments(mutation, pathEnvironment), ToolResultSchemaProbeError);
  }
  assert.throws(() => parseToolResultSchemaProbeArguments(argv, {}), ToolResultSchemaProbeError);
});

test("supported silent npm entry never echoes explicit path environment values", () => {
  const configCanary = "/private/config-path-canary", rootCanary = "/private/sessions-root-canary";
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "test:tool-result-schema-probe", "--", "--invalid"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env, PANEL_TOOL_RESULT_SCHEMA_CONFIG_PATH: configCanary,
      PANEL_TOOL_RESULT_SCHEMA_SESSIONS_ROOT: rootCanary }
  });
  assert.notEqual(result.status, 0); const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(output.includes(configCanary), false); assert.equal(output.includes(rootCanary), false);
});

test("config and root preflight reject bindings, malformed data, path mismatch, and symlinks", async t => {
  const root = await tempFixture(t, "tool-result-schema-preflight-");
  const config = join(root, "openclaw.json"), agentRoot = join(root, "agents", request.agentId, "sessions"); await mkdir(agentRoot, { recursive: true });
  await writeFile(config, JSON.stringify({ gateway: { mode: "local" }, bindings: [] })); await inspectToolResultProbeConfig(config, request.agentId);
  await writeFile(config, JSON.stringify({ gateway: { mode: "remote", remote: {} }, bindings: [] }));
  await assert.rejects(inspectToolResultProbeConfig(config, request.agentId), /PROBE_GATEWAY_NOT_LOCAL/u);
  await writeFile(config, JSON.stringify({ gateway: { mode: "local" }, bindings: [{ agentId: request.agentId }] }));
  await assert.rejects(inspectToolResultProbeConfig(config, request.agentId), /PROBE_BINDINGS_PRESENT/u);
  await writeFile(config, JSON.stringify({ gateway: { mode: "local" }, bindings: [{ agentId: "other-agent" }] }));
  await assert.rejects(inspectToolResultProbeConfig(config, request.agentId), /PROBE_BINDINGS_PRESENT/u);
  await writeFile(config, JSON.stringify({ gateway: { mode: "local" }, bindings: [{}] }));
  await assert.rejects(inspectToolResultProbeConfig(config, request.agentId), /PROBE_BINDINGS_INVALID/u);
  const identity = await inspectToolResultProbeRoot(agentRoot, request.agentId); await inspectToolResultProbeRoot(agentRoot, request.agentId, identity);
  await assert.rejects(inspectToolResultProbeRoot(root, request.agentId), /PROBE_ROOT_UNSAFE/u);
  const realParent = join(root, "real"), linkedParent = join(root, "linked");
  const nestedRoot = join(realParent, "agents", request.agentId, "sessions"); await mkdir(nestedRoot, { recursive: true }); await symlink(realParent, linkedParent);
  await assert.rejects(inspectToolResultProbeRoot(join(linkedParent, "agents", request.agentId, "sessions"), request.agentId), /PROBE_ROOT_UNSAFE/u);
});

test("gate, version, and exact effective-tool failures happen before send", async () => {
  for (const [overrides, code] of [[{ gate: "0" }, "PROBE_GATE_REQUIRED"], [{ endpointOverride: true }, "PROBE_ENDPOINT_OVERRIDE_FORBIDDEN"],
    [{ version: "2026.6.12" }, "PROBE_VERSION_MISMATCH"],
    [{ tools: [] }, "PROBE_EFFECTIVE_TOOLS_MISMATCH"], [{ tools: ["exec", "read"] }, "PROBE_EFFECTIVE_TOOLS_MISMATCH"]] as const) {
    const { dependencies, calls } = fixture(overrides); await assert.rejects(runToolResultSchemaProbe(request, dependencies), (error: unknown) => {
      assert.equal((error as ToolResultSchemaProbeError).code, code); return true;
    }); assert.equal(calls.includes("send"), false); if (calls.includes("create")) assert.equal(calls.includes("cleanup"), true);
  }
});

test("probe latches one terminal shape, completes authoritatively, cleans, and leaks no values", async () => {
  const { dependencies, calls } = fixture(); const report = await runToolResultSchemaProbe(request, dependencies);
  assert.deepEqual(calls, ["config", "root", "auth", "config-recheck", "control-connection", "version", "root-recheck", "create", "inspect-created", "schema-connection", "tools",
    "observe", "root-recheck", "send", "wait", "unsubscribe", "stop", "root-recheck", "cleanup", "root-recheck", "stop"]);
  assert.deepEqual(Object.keys(report), ["schemaVersion", "probe", "status", "version", "scenario", "preflight", "observation", "completion", "cleanup"]);
  assert.equal(report.observation.events[1]?.field, "terminalData"); assert.deepEqual(report.observation.events[1]?.shape?.candidateKinds, { stdout: "string", output: "object" });
  const encoded = JSON.stringify(report); assert.ok(Buffer.byteLength(encoded) < 8_192);
  for (const canary of [request.agentId, request.sessionsRoot, request.configPath, created.sessionId, created.sessionKey, "private-call", "/private/path", "private result"])
    assert.equal(encoded.includes(canary), false, `report leaked ${canary}`);
});

test("stream failure and a second tool fail closed; cleanup failure is separately classified", async () => {
  for (const overrides of [{ disconnect: true }, { secondTool: true }]) {
    const { dependencies, calls } = fixture(overrides); await assert.rejects(runToolResultSchemaProbe(request, dependencies), (error: unknown) => {
      const value = error as ToolResultSchemaProbeError; assert.match(value.code, /PROBE_(?:STREAM_DISCONNECTED|TOOL_LIMIT_EXCEEDED)/u); return true;
    }); assert.equal(calls.includes("abort"), true); assert.equal(calls.includes("cleanup"), true);
  }
  const mismatch = fixture({ acceptedRunId: "33333333-3333-4333-8333-333333333333" });
  await assert.rejects(runToolResultSchemaProbe(request, mismatch.dependencies), (error: unknown) => {
    assert.equal((error as ToolResultSchemaProbeError).code, "PROBE_RUN_ID_MISMATCH"); return true;
  });
  assert.equal(mismatch.calls.includes("abort"), true); assert.equal(mismatch.calls.includes("cleanup"), true);
  assert.equal(mismatch.calls.includes("abort-run:33333333-3333-4333-8333-333333333333"), true);
  const { dependencies } = fixture({ tools: [], cleanupFails: true }); await assert.rejects(runToolResultSchemaProbe(request, dependencies), (error: unknown) => {
    const value = error as ToolResultSchemaProbeError; assert.equal(value.code, "PROBE_EFFECTIVE_TOOLS_MISMATCH"); assert.equal(value.cleanupCode, "PROBE_CLEANUP_FAILED");
    assert.equal(JSON.stringify(value).includes("private"), false); return true;
  });
});

test("wrong invocation, failed result, and a wrong created root never produce a pass", async () => {
  for (const overrides of [{ wrongName: true }, { wrongArgs: true }, { resultError: true }, { inspectCreatedFails: true }]) {
    const { dependencies, calls } = fixture(overrides); await assert.rejects(runToolResultSchemaProbe(request, dependencies));
    if (overrides.inspectCreatedFails) assert.equal(calls.includes("send"), false);
    assert.equal(calls.includes("cleanup"), true);
  }
});

test("equal sequence and an additional unattributed terminal fail the exact lifecycle", async () => {
  for (const overrides of [{ equalSequence: true }, { extraTerminal: true }]) {
    const { dependencies, calls } = fixture(overrides);
    await assert.rejects(runToolResultSchemaProbe(request, dependencies), (error: unknown) => {
      assert.equal((error as ToolResultSchemaProbeError).code, "PROBE_OBSERVATION_INCOMPLETE"); return true;
    });
    assert.equal(calls.includes("cleanup"), true);
  }
});

test("collector terminal promise follows sanitized raw frames even when normalized terminal has no name", async () => {
  const collector = (await import("../src/gateway/stream-schema-observation.js")).createToolSchemaCollector(created.sessionKey, "raw-run");
  let settled = false; collector.terminal.then(() => { settled = true; });
  observeToolSchemaFrame(collector, "session.tool", { runId: "raw-run", sessionKey: created.sessionKey, seq: 1, stream: "tool",
    data: { phase: "start", toolCallId: "private-call", name: "exec", args: {} } });
  observeToolSchemaFrame(collector, "session.tool", { runId: "raw-run", sessionKey: created.sessionKey, seq: 2, stream: "tool",
    data: { phase: "result", toolCallId: "private-call", stdout: "private result" } });
  await collector.terminal; assert.equal(settled, true); assert.equal(collector.finish().events[1]?.field, "terminalData");
});
