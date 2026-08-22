import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { GatewayClient } from "../src/gateway/adapter.js";
import { liveProbeRuntimeSnapshot } from "../src/gateway/live-probe-preflight.js";
import { RuntimeAcceptanceError, parseRuntimeAcceptanceArguments, runRuntimeAcceptance,
  workspaceSnapshot, type RuntimeAcceptanceDependencies, type RuntimeAcceptanceRequest } from "../src/gateway/runtime-acceptance.js";
import { tempFixture } from "./test-helpers.js";

const agentId = "panel-runtime-probe-fixture";
const base: RuntimeAcceptanceRequest = { agentId, configPath: "/fixture/openclaw.json",
  sessionsRoot: `/fixture/agents/${agentId}/sessions`, workspaceRoot: "/fixture/workspace",
  expectedVersion: "2026.6.11", scenario: "memory-search-canary-v1", maxRuns: 1,
  cleanupConfirmation: "delete-created-session-v1", confirmation: `runtime-acceptance:${agentId}:2026.6.11` };
const argv = ["--agent", agentId, "--expected-version", "2026.6.11", "--scenario", "memory-search-canary-v1",
  "--max-runs", "1", "--cleanup", "delete-created-session-v1", "--confirm", base.confirmation];

test("runtime acceptance arguments require one explicit fixed target", () => {
  const env = { PANEL_RUNTIME_ACCEPTANCE_CONFIG_PATH: base.configPath, PANEL_RUNTIME_ACCEPTANCE_SESSIONS_ROOT: base.sessionsRoot,
    PANEL_RUNTIME_ACCEPTANCE_WORKSPACE_ROOT: base.workspaceRoot };
  assert.deepEqual(parseRuntimeAcceptanceArguments(argv, env), base);
  assert.throws(() => parseRuntimeAcceptanceArguments(argv.slice(0, -2), env), RuntimeAcceptanceError);
  assert.throws(() => parseRuntimeAcceptanceArguments(argv, {}), RuntimeAcceptanceError);
});

test("shared workspace snapshot preserves bootstrap-plus-memory compatibility", async t => {
  const root = await tempFixture(t, "workspace-snapshot-compat-"); await mkdir(join(root, "memory")); await mkdir(join(root, "unrelated"));
  await writeFile(join(root, "AGENTS.md"), "agents"); await writeFile(join(root, "memory", "fact.md"), "fact");
  const before = await workspaceSnapshot(root); await writeFile(join(root, "unrelated", "ignored.txt"), "ignored");
  assert.deepEqual(await workspaceSnapshot(root), before); assert.deepEqual(Object.keys(before), ["fileCount", "hash"]);
});

test("compiled CLI rejects invalid arguments without leaking paths, credentials, or message markers", () => {
  const privateValues = ["/private/config-canary", "/private/sessions-canary", "/private/workspace-canary",
    "private-token-canary", "ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1"];
  const env = { ...process.env, PANEL_RUNTIME_ACCEPTANCE_CONFIG_PATH: privateValues[0],
    PANEL_RUNTIME_ACCEPTANCE_SESSIONS_ROOT: privateValues[1], PANEL_RUNTIME_ACCEPTANCE_WORKSPACE_ROOT: privateValues[2],
    PANEL_OPENCLAW_GATEWAY_TOKEN: privateValues[3], PANEL_ALLOW_RUNTIME_ACCEPTANCE: "1" };
  const result = spawnSync(process.execPath, ["dist/src/gateway/runtime-acceptance-cli.js", "--unknown", "fixture"],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.equal(result.signal, null);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.match(output, /"errorCode":"PROBE_ARGUMENTS_INVALID"/u);
  for (const value of privateValues) assert.equal(output.includes(value), false);
});

async function fixture(t: import("node:test").TestContext, overrides: { gate?: string; tools?: string[]; waitFails?: boolean;
  configuredTools?: string[]; bootstrapNames?: string[]; rootIdentityMismatch?: boolean; resultText?: string;
  resultBlocks?: boolean; preexistingRootFile?: boolean;
  emptyRegistryBefore?: boolean; emptyRegistryAfterCleanup?: boolean; invalidRegistryBefore?: boolean;
  transcriptMutation?: "assistant-result" | "duplicate-result" | "unmatched-result" | "out-of-order" } = {}) {
  const root = await tempFixture(t, "runtime-acceptance-"), workspaceRoot = join(root, "workspace");
  const sessionsRoot = join(root, "agents", agentId, "sessions"), configPath = join(root, "openclaw.json");
  await mkdir(join(workspaceRoot, "memory"), { recursive: true, mode: 0o700 });
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  if (overrides.preexistingRootFile) await writeFile(join(sessionsRoot, "preexisting.jsonl"), "fixture\n", { mode: 0o600 });
  if (overrides.emptyRegistryBefore || overrides.invalidRegistryBefore) await writeFile(join(sessionsRoot, "sessions.json"),
    overrides.invalidRegistryBefore ? JSON.stringify({ private: "fixture" }) : "{}", { mode: 0o600 });
  await writeFile(join(workspaceRoot, "memory", "ark-panel-runtime-acceptance.md"),
    "# Fictional ark-panel runtime acceptance canary\n\nARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1\nARK_PANEL_RUNTIME_ACCEPTANCE_RESULT_V1\n",
    { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" }, bindings: [], agents: { list: [{ id: agentId, workspace: workspaceRoot }] } }));
  const request = { ...base, configPath, sessionsRoot, workspaceRoot }, calls: string[] = [];
  const sessionId = "11111111-1111-4111-8111-111111111111", sessionKey = `agent:${agentId}:temporary`;
  const transcriptPath = join(sessionsRoot, `${sessionId}.jsonl`); let deletedTranscript = "";
  const client: GatewayClient = {
    async version() { calls.push("version"); return "2026.6.11"; },
    async configuredTools() { calls.push("configured-tools"); return { agentId, scope: "configured-runtime-catalog", groups: [{ id: "fixture",
      label: "Fixture", source: "core", tools: (overrides.configuredTools ?? ["browser", "canvas", "memory_search"]).map(id => ({ id,
        label: id, description: "fixture", source: "core", defaultProfiles: [] })) }] }; },
    async createSession(id) { calls.push(`create:${id}`); await writeFile(transcriptPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
      return { sessionId, sessionKey, transcriptPath }; },
    async effectiveTools() { calls.push("tools"); return { agentId, scope: "effective-session-tools", toolIds: overrides.tools ?? ["memory_search"] }; },
    async send(key, _prompt, runId) { calls.push("send"); assert.equal(key, sessionKey);
      const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "fixture" } };
      const call = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [
        { type: "tool_use", id: "call-1", name: "memory_search", input: { query: "ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1" } }] } };
      const result = { type: "message", id: "r1", parentId: "a1", message: { role: overrides.transcriptMutation === "assistant-result" ? "assistant" : "toolResult", content: [
        { type: "tool_result", tool_use_id: overrides.transcriptMutation === "unmatched-result" ? "other-call" : "call-1",
          content: overrides.resultBlocks ? [{ type: "text", text: "ARK_PANEL_RUNTIME_ACCEPTANCE_RESULT_V1" }] :
            overrides.resultText ?? "ARK_PANEL_RUNTIME_ACCEPTANCE_RESULT_V1" }] } };
      const summary = { type: "message", id: "a2", parentId: "r1", message: { role: "assistant", content: JSON.stringify({
        bootstrapNames: overrides.bootstrapNames ?? ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md", "MEMORY.md"], skillNames: ["fixture-skill"] }) } };
      const entries = overrides.transcriptMutation === "out-of-order" ? [user, result, call, summary] : [user, call, result,
        ...(overrides.transcriptMutation === "duplicate-result" ? [{ ...result, id: "r2" }] : []), summary];
      await writeFile(transcriptPath, `${await readFile(transcriptPath, "utf8")}${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
      return { runId }; },
    async waitForCompletion() { calls.push("wait"); if (overrides.waitFails) throw new Error("unknown outcome"); },
    async abort(_key, runId) { calls.push(`abort:${runId ?? "none"}`); },
    async deleteSession() { calls.push("delete"); deletedTranscript = await readFile(transcriptPath, "utf8"); await rm(transcriptPath);
      if (overrides.emptyRegistryAfterCleanup) await writeFile(join(sessionsRoot, "sessions.json"), "{}", { mode: 0o600 }); }
  };
  let rootChecks = 0;
  const dependencies: RuntimeAcceptanceDependencies = { env: { PANEL_ALLOW_RUNTIME_ACCEPTANCE: overrides.gate ?? "1" }, client,
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
    ...(overrides.rootIdentityMismatch ? { async inspectRoot(_path: string, _agent: string, expected?: { dev: bigint; ino: bigint }) {
      rootChecks++; if (expected && rootChecks >= 3) throw new RuntimeAcceptanceError("PROBE_ROOT_CHANGED"); return expected ?? { dev: 1n, ino: 2n }; } } : {}) };
  return { request, dependencies, calls, root, deletedTranscript: () => deletedTranscript };
}

test("one fake run proves the direct memory_search canary result and exact cleanup", async t => {
  const value = await fixture(t), report = await runRuntimeAcceptance(value.request, value.dependencies);
  assert.deepEqual(report, { schemaVersion: 1, probe: "runtime-acceptance", status: "passed", version: "2026.6.11",
    target: { agentId },
    scenario: "memory-search-canary-v1", preflight: { explicitTarget: true, doubleGate: true, zeroBindings: true,
      sessionsRootIsolated: true, workspacePinned: true, effectiveToolsExact: true }, observation: { createCalls: 1,
      sendCalls: 1, memorySearchCalls: 1, canaryResultObserved: true, workspaceUnchanged: true },
    bootstrap: { "AGENTS.md": true, "TOOLS.md": true, "SOUL.md": true, "USER.md": true, "MEMORY.md": true },
    skills: { count: 1, injected: true }, requiredTools: { browser: true, canvas: true, memory_search: true },
    completion: { authoritativeRunCompleted: true }, cleanup: { confirmed: true, completed: true, residualCount: 0 } });
  assert.deepEqual(value.calls, [`version`, "configured-tools", `create:${agentId}`, "tools", "send", "wait", "version", "delete"]);
  assert.deepEqual(await readdir(value.request.sessionsRoot), []);
});

test("missing configured tools fail before create and incomplete bootstrap fails after terminal cleanup", async t => {
  const configured = await fixture(t, { configuredTools: ["memory_search"] });
  await assert.rejects(runRuntimeAcceptance(configured.request, configured.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_CONFIGURED_TOOLS_MISSING");
  assert.equal(configured.calls.some(call => call.startsWith("create:")), false); assert.equal(configured.calls.includes("send"), false);
  const bootstrap = await fixture(t, { bootstrapNames: ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md"] });
  await assert.rejects(runRuntimeAcceptance(bootstrap.request, bootstrap.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_BOOTSTRAP_INCOMPLETE");
  assert.equal(bootstrap.calls.includes("wait"), true); assert.equal(bootstrap.calls.includes("delete"), true);
});

test("pinned runtime root identity is required at cleanup", async t => {
  const value = await fixture(t, { rootIdentityMismatch: true });
  await assert.rejects(runRuntimeAcceptance(value.request, value.dependencies), (error: unknown) => {
    const failure = error as RuntimeAcceptanceError; assert.equal(failure.cleanupCode, "PROBE_CLEANUP_FAILED"); return true;
  });
  assert.equal(value.calls.includes("delete"), false);
});

test("query echo and no-result text cannot satisfy the distinct result marker", async t => {
  for (const resultText of ["ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1", "No results for ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1"]) {
    const value = await fixture(t, { resultText });
    await assert.rejects(runRuntimeAcceptance(value.request, value.dependencies),
      (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_MEMORY_RESULT_INVALID");
    assert.equal(value.calls.includes("delete"), true);
  }
});

test("tool result sequence rejects assistant forgery, duplicate, unmatched, and out-of-order rows", async t => {
  for (const transcriptMutation of ["assistant-result", "duplicate-result", "unmatched-result", "out-of-order"] as const) {
    const value = await fixture(t, { transcriptMutation });
    await assert.rejects(runRuntimeAcceptance(value.request, value.dependencies),
      (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_MEMORY_RESULT_INVALID");
    assert.equal(value.calls.includes("delete"), true);
  }
});

test("TOCTOU rechecks stop before create and before materialization", async t => {
  const beforeCreate = await fixture(t); const baseConfig = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, digest: "fixture" };
  beforeCreate.dependencies.inspectConfig = async (_path, _agent, expected) => {
    if (beforeCreate.calls.includes("configured-tools")) throw new RuntimeAcceptanceError("PROBE_CONFIG_CHANGED");
    return expected ?? baseConfig;
  };
  await assert.rejects(runRuntimeAcceptance(beforeCreate.request, beforeCreate.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_CONFIG_CHANGED");
  assert.equal(beforeCreate.calls.some(call => call.startsWith("create:")), false);

  const beforeWrite = await fixture(t); let createdChecks = 0;
  beforeWrite.dependencies.inspectCreated = async () => {
    if (++createdChecks === 2) throw new RuntimeAcceptanceError("PROBE_CREATED_SESSION_INVALID");
  };
  await assert.rejects(runRuntimeAcceptance(beforeWrite.request, beforeWrite.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_CREATED_SESSION_INVALID");
  assert.equal(beforeWrite.calls.includes("send"), false); assert.equal(beforeWrite.calls.includes("delete"), true);
  assert.equal(beforeWrite.deletedTranscript().includes("cwd"), false, "materializer must not write after the second identity check fails");
});

test("an isolated runtime requires an empty sessions root and accepts text-block tool results", async t => {
  const dirty = await fixture(t, { preexistingRootFile: true });
  await assert.rejects(runRuntimeAcceptance(dirty.request, dirty.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_ROOT_CONTENTS_UNSAFE");
  assert.equal(dirty.calls.some(call => call.startsWith("create:")), false);
  const blocks = await fixture(t, { resultBlocks: true });
  assert.equal((await runRuntimeAcceptance(blocks.request, blocks.dependencies)).status, "passed");
});

test("runtime registry snapshot is bounded and detects path replacement during its read", async t => {
  const root = await tempFixture(t, "runtime-registry-snapshot-");
  const registry = join(root, "sessions.json");
  await writeFile(registry, `${" ".repeat(1_024)}{}`, { mode: 0o600 });
  await assert.rejects(liveProbeRuntimeSnapshot(root),
    (error: unknown) => (error as { code?: string }).code === "PROBE_ROOT_TOO_LARGE");

  await writeFile(registry, "{}", { mode: 0o600 });
  await assert.rejects(liveProbeRuntimeSnapshot(root, undefined, { async afterRegistryRead(path) {
    const moved = join(root, "sessions.original.json");
    await rename(path, moved); await writeFile(path, "{}", { mode: 0o600 }); await rm(moved);
  } }), (error: unknown) => (error as { code?: string }).code === "PROBE_ROOT_CHANGED");
});

test("an owner-only empty OpenClaw session registry is normalized but nonempty registry state fails closed", async t => {
  const existing = await fixture(t, { emptyRegistryBefore: true, emptyRegistryAfterCleanup: true });
  assert.equal((await runRuntimeAcceptance(existing.request, existing.dependencies)).status, "passed");
  assert.deepEqual(await readdir(existing.request.sessionsRoot), ["sessions.json"]);
  const created = await fixture(t, { emptyRegistryAfterCleanup: true });
  assert.equal((await runRuntimeAcceptance(created.request, created.dependencies)).status, "passed");
  assert.deepEqual(await readdir(created.request.sessionsRoot), ["sessions.json"]);
  const invalid = await fixture(t, { invalidRegistryBefore: true });
  await assert.rejects(runRuntimeAcceptance(invalid.request, invalid.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_ROOT_CONTENTS_UNSAFE");
  assert.equal(invalid.calls.some(call => call.startsWith("create:")), false);
});

test("gate and exact-tool mismatch reject before send; unknown outcome aborts once without retry", async t => {
  const gated = await fixture(t, { gate: "0" }); await assert.rejects(runRuntimeAcceptance(gated.request, gated.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_GATE_REQUIRED");
  const tools = await fixture(t, { tools: ["memory_search", "read"] }); await assert.rejects(runRuntimeAcceptance(tools.request, tools.dependencies),
    (error: unknown) => (error as RuntimeAcceptanceError).code === "PROBE_EFFECTIVE_TOOLS_MISMATCH");
  assert.equal(tools.calls.includes("send"), false); assert.equal(tools.calls.includes("delete"), true);
  const unknown = await fixture(t, { waitFails: true }); await assert.rejects(runRuntimeAcceptance(unknown.request, unknown.dependencies));
  assert.equal(unknown.calls.filter(call => call === "send").length, 1);
  assert.deepEqual(unknown.calls.filter(call => call.startsWith("abort:")), ["abort:22222222-2222-4222-8222-222222222222"]);
  assert.equal(unknown.calls.includes("delete"), true);
});
