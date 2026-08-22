import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { GatewayClient } from "../src/gateway/adapter.js";
import {
  classifyCompactionProbeObservation,
  compactionProbeHistory,
  COMPACTION_PROBE_CONTEXT_BUDGET,
  COMPACTION_PROBE_RECENT_CHARACTER_FLOOR,
  parseCompactionLiveProbeArguments,
  runCompactionLiveProbe,
  CompactionLiveProbeError,
  type CompactionLiveProbeRequest
} from "../src/gateway/compaction-live-probe.js";
import { ConservativeContextBudget } from "../src/domain/context-budget.js";
import { tempFixture } from "./test-helpers.js";

const request: CompactionLiveProbeRequest = {
  agentId: "panel-probe-compaction",
  sessionsRoot: "/fixture/agents/panel-probe-compaction/sessions",
  configPath: "/fixture/openclaw.json",
  panelRootParent: "/fixture/panel-roots",
  workspaceRoot: "/fixture/workspace",
  expectedVersion: "2026.6.11",
  scenario: "panel-compaction-v1",
  maxCompactions: 1,
  cleanupConfirmation: "delete-created-session-v1",
  confirmation: "compaction:panel-probe-compaction:2026.6.11"
};

test("fixed fictional history forces an old prefix outside OpenClaw's retained tail", () => {
  const history = compactionProbeHistory(), recent = history.entries.slice(2);
  const recentCharacters = recent.reduce((total, entry) => {
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null ||
      !("content" in entry.message) || typeof entry.message.content !== "string") return total;
    return total + entry.message.content.length;
  }, 0);
  assert.ok(recentCharacters > COMPACTION_PROBE_RECENT_CHARACTER_FLOOR);
  const budget = new ConservativeContextBudget(COMPACTION_PROBE_CONTEXT_BUDGET);
  const before = budget.assertWithinBudget(history, "").estimatedTokens;
  const candidate = { ...history, entries: [...history.entries, { type: "compaction" as const, id: "probe-c1", parentId: "probe-a2",
    timestamp: "2026-08-14T00:01:00.000Z", summary: "Fictional bounded summary. ".repeat(2_000),
    firstKeptEntryId: "probe-u2", tokensBefore: 60_000 }] };
  const after = budget.assertWithinBudget(candidate, "").estimatedTokens;
  assert.ok(after < before, `${after} must be less than ${before}`);
});

test("compaction observation classifier returns every fixed code in priority order", () => {
  const usage = { source: "openclaw-session" as const, totalTokens: 12_000, contextTokens: 128_000, totalTokensFresh: true };
  const valid = { compacted: true, upstreamCompacted: true, createCalls: 1, compactCalls: 1, sendCalls: 0, deleteCalls: 1, usageCalls: 2,
    preUsage: usage, postUsage: { ...usage, totalTokens: 2_000 } };
  const cases = [
    [{ ...valid, compacted: false, createCalls: 0, preUsage: undefined }, "PROBE_COMPACTION_NOT_ACCEPTED"],
    [{ ...valid, compacted: false, upstreamCompacted: false, reason: "NO_EFFECTIVE_REDUCTION", createCalls: 0 },
      "PROBE_COMPACTION_NOT_ACCEPTED"],
    [{ ...valid, compacted: false, reason: "NO_EFFECTIVE_REDUCTION", createCalls: 0 }, "PROBE_PANEL_NO_EFFECTIVE_REDUCTION"],
    [{ ...valid, compacted: false, reason: "private upstream detail", createCalls: 0 }, "PROBE_COMPACTION_NOT_ACCEPTED"],
    [{ ...valid, upstreamCompacted: undefined }, "PROBE_COMPACTION_PROVENANCE_INVALID"],
    [{ ...valid, createCalls: 2, preUsage: undefined }, "PROBE_CALL_COUNTS_INVALID"],
    [{ ...valid, preUsage: undefined }, "PROBE_USAGE_MISSING"],
    [{ ...valid, preUsage: { ...usage, source: "fixture" } }, "PROBE_USAGE_SOURCE_INVALID"],
    [{ ...valid, preUsage: { ...usage, totalTokensFresh: false } }, "PROBE_USAGE_STALE"],
    [{ ...valid, preUsage: { ...usage, totalTokensFresh: "true" } }, "PROBE_USAGE_STALE"],
    [{ ...valid, preUsage: { ...usage, totalTokens: null } }, "PROBE_USAGE_VALUES_INVALID"],
    [{ ...valid, postUsage: { ...usage, totalTokens: 2_000, contextTokens: 64_000 } }, "PROBE_CONTEXT_WINDOW_CHANGED"],
    [{ ...valid, postUsage: { ...usage, totalTokens: 12_000 } }, "PROBE_USAGE_NOT_REDUCED"],
    [valid, null]
  ] as const;
  for (const [observation, expected] of cases) assert.equal(classifyCompactionProbeObservation(observation), expected);
});

test("compaction probe arguments require every fixed boundary and both path inputs", () => {
  const argv = ["--agent", request.agentId, "--expected-version", request.expectedVersion,
    "--scenario", request.scenario, "--max-compactions", "1", "--cleanup",
    request.cleanupConfirmation, "--confirm", request.confirmation];
  const env = { PANEL_COMPACTION_PROBE_SESSIONS_ROOT: request.sessionsRoot,
    PANEL_COMPACTION_PROBE_CONFIG_PATH: request.configPath,
    PANEL_COMPACTION_PROBE_PANEL_ROOT_PARENT: request.panelRootParent,
    PANEL_COMPACTION_PROBE_WORKSPACE_ROOT: request.workspaceRoot };
  assert.deepEqual(parseCompactionLiveProbeArguments(argv, env), request);
  assert.throws(() => parseCompactionLiveProbeArguments(argv.slice(0, -2), env));
  assert.throws(() => parseCompactionLiveProbeArguments(argv, {}));
});

test("compiled CLI entry is gated and never echoes path inputs", () => {
  const canaries = ["/private/config-canary", "/private/sessions-canary", "/private/workspace-canary", "/private/panel-canary"];
  const result = spawnSync(process.execPath, ["dist/src/gateway/compaction-live-probe-cli.js",
    "--agent", request.agentId, "--expected-version", request.expectedVersion, "--scenario", request.scenario,
    "--max-compactions", "1", "--cleanup", request.cleanupConfirmation, "--confirm", request.confirmation], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: { ...process.env,
      PANEL_ALLOW_COMPACTION_LIVE_PROBE: "0", PANEL_COMPACTION_PROBE_CONFIG_PATH: canaries[0],
      PANEL_COMPACTION_PROBE_SESSIONS_ROOT: canaries[1], PANEL_COMPACTION_PROBE_WORKSPACE_ROOT: canaries[2],
      PANEL_COMPACTION_PROBE_PANEL_ROOT_PARENT: canaries[3] }
  });
  assert.notEqual(result.status, 0); const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.match(output, /"errorCode":"PROBE_GATE_REQUIRED"/u);
  for (const canary of canaries) assert.equal(output.includes(canary), false);
});

interface FixtureOverrides {
  gate?: string;
  version?: string;
  tools?: readonly string[];
  compactFails?: boolean;
  abortFails?: boolean;
  deleteFails?: boolean;
  postTotalTokens?: number;
  preFresh?: boolean;
  postFresh?: boolean;
  postContextTokens?: number;
  emptyRegistryBefore?: boolean;
  emptyRegistryAfterCleanup?: boolean;
}

async function fixture(t: import("node:test").TestContext, overrides: FixtureOverrides = {}) {
  const root = await tempFixture(t, "compaction-live-probe-"), sessionsRoot = join(root, "agents", request.agentId, "sessions");
  const configPath = join(root, "openclaw.json"), panelRootParent = join(root, "panel-roots"), workspaceRoot = join(root, "workspace");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  if (overrides.emptyRegistryBefore) await writeFile(join(sessionsRoot, "sessions.json"), "{}", { mode: 0o600 });
  await mkdir(panelRootParent, { mode: 0o700 });
  await mkdir(workspaceRoot, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "local" }, bindings: [],
    agents: { list: [{ id: request.agentId, workspace: workspaceRoot }] } }));
  const actualRequest = { ...request, sessionsRoot, configPath, panelRootParent, workspaceRoot }, calls: string[] = [];
  const sessionId = "11111111-1111-4111-8111-111111111111", sessionKey = `agent:${request.agentId}:temporary`;
  const transcriptPath = join(sessionsRoot, `${sessionId}.jsonl`); let compacted = false;
  const client: GatewayClient = {
    async version() { calls.push("version"); return overrides.version ?? "2026.6.11"; },
    async createSession() { calls.push("create"); await writeFile(transcriptPath, `${JSON.stringify({ type: "session", version: 3,
      id: sessionId, timestamp: "2026-08-14T00:00:00.000Z", cwd: workspaceRoot })}\n`);
      return { sessionId, sessionKey, transcriptPath }; },
    async effectiveTools() { calls.push("effective-tools"); return { agentId: request.agentId,
      scope: "effective-session-tools", toolIds: [...(overrides.tools ?? [])] }; },
    async sessionContextUsage(_agent, key) { calls.push(compacted ? "post-usage" : "pre-usage"); assert.equal(key, sessionKey);
      return { source: "openclaw-session", totalTokens: compacted ? overrides.postTotalTokens ?? 2_000 : 12_000,
        contextTokens: compacted ? overrides.postContextTokens ?? 128_000 : 128_000,
        totalTokensFresh: compacted ? overrides.postFresh ?? true : overrides.preFresh ?? true }; },
    async compactSession(key) { calls.push("compact"); assert.equal(key, sessionKey); compacted = true;
      if (overrides.compactFails) throw new Error("private compact failure");
      const history = (await readFile(transcriptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: string });
      await appendFile(transcriptPath, `${JSON.stringify({ type: "compaction", id: "probe-c1", parentId: "probe-a2",
        timestamp: "2026-08-14T00:01:00.000Z", summary: "Fictional short summary.", firstKeptEntryId: "probe-u2", tokensBefore: 12_000 })}\n`);
      assert.equal(history.at(-1)?.id, "probe-a2"); return { compacted: true };
    },
    async send() { calls.push("send"); throw new Error("send forbidden"); }, async waitForCompletion() {},
    async abort() { calls.push("abort"); if (overrides.abortFails) throw new Error("private abort failure"); },
    async deleteSession(key) { calls.push("delete"); assert.equal(key, sessionKey);
      if (overrides.deleteFails) throw new Error("private delete failure"); await rm(transcriptPath);
      if (overrides.emptyRegistryAfterCleanup) await writeFile(join(sessionsRoot, "sessions.json"), "{}", { mode: 0o600 }); }
  };
  const dependencies = { env: { PANEL_ALLOW_COMPACTION_LIVE_PROBE: overrides.gate ?? "1" }, client };
  return { request: actualRequest, dependencies, calls, root };
}

test("fake transport drives the production compaction chain with same-session fresh usage and reload", async t => {
  const value = await fixture(t), report = await runCompactionLiveProbe(value.request, value.dependencies);
  assert.deepEqual(report.observation, { createCalls: 1, compactCalls: 1, sendCalls: 0, sameSessionUsage: true,
    prefixPreserved: true, effectiveReduction: true, tokensBefore: 12_000, postTotalTokens: 2_000, contextTokens: 128_000 });
  assert.notEqual(report.reload.revisionBefore, report.reload.revisionAfter);
  assert.deepEqual({ ...report.reload, revisionBefore: "redacted", revisionAfter: "redacted" },
    { revisionBefore: "redacted", revisionAfter: "redacted", revisionChanged: true, usageAtCurrentTip: true, matchesPost: true });
  assert.deepEqual(report.cleanup, { confirmed: true, completed: true, residualCount: 0 });
  assert.deepEqual(value.calls, ["version", "version", "create", "effective-tools", "pre-usage", "compact", "post-usage", "version", "delete"]);
  assert.deepEqual((await readdir(value.root)).sort(), ["agents", "openclaw.json", "panel-roots", "workspace"]);
  assert.deepEqual(await readdir(value.request.panelRootParent), []);
});

test("compaction cleanup accepts only the canonical empty OpenClaw session registry", async t => {
  for (const overrides of [{ emptyRegistryBefore: true, emptyRegistryAfterCleanup: true },
    { emptyRegistryAfterCleanup: true }] satisfies FixtureOverrides[]) {
    const value = await fixture(t, overrides);
    assert.equal((await runCompactionLiveProbe(value.request, value.dependencies)).status, "passed");
    assert.deepEqual(await readdir(value.request.sessionsRoot), ["sessions.json"]);
  }
  const invalid = await fixture(t); await writeFile(join(invalid.request.sessionsRoot, "sessions.json"),
    JSON.stringify({ private: "fixture" }), { mode: 0o600 });
  await assert.rejects(runCompactionLiveProbe(invalid.request, invalid.dependencies),
    (error: unknown) => (error as CompactionLiveProbeError).code === "PROBE_ROOT_CONTENTS_UNSAFE");
  assert.equal(invalid.calls.includes("create"), false);
});

test("gate and version reject before create; effective-tools failure cleans before handoff", async t => {
  for (const [overrides, code] of [[{ gate: "0" }, "PROBE_GATE_REQUIRED"], [{ version: "2026.6.12" }, "PROBE_VERSION_MISMATCH"],
    [{ tools: ["read"] }, "PROBE_EFFECTIVE_TOOLS_MISMATCH"]] as const) {
    const value = await fixture(t, overrides); await assert.rejects(runCompactionLiveProbe(value.request, value.dependencies), (error: unknown) => {
      assert.equal((error as CompactionLiveProbeError).code, code); return true;
    });
    assert.equal(value.calls.includes("compact"), false); assert.equal(value.calls.includes("send"), false);
    if (overrides.tools) assert.deepEqual(value.calls, ["version", "version", "create", "effective-tools", "version", "delete"]);
    else assert.equal(value.calls.includes("create"), false);
  }
});

test("config target and exact workspace are verified before create", async t => {
  for (const config of [{ gateway: { mode: "local" }, bindings: [], agents: { list: [] } },
    { gateway: { mode: "local" }, bindings: [], agents: { list: [{ id: request.agentId, workspace: "/wrong" }] } },
    { gateway: { mode: "local" }, bindings: [], agents: { list: [{ id: request.agentId, workspace: "/one" },
      { id: request.agentId, workspace: "/two" }] } }] as const) {
    const value = await fixture(t); await writeFile(value.request.configPath, JSON.stringify(config));
    await assert.rejects(runCompactionLiveProbe(value.request, value.dependencies), (error: unknown) => {
      assert.match((error as CompactionLiveProbeError).code, /PROBE_AGENT_(?:CONFIG_INVALID|WORKSPACE_MISMATCH)/u); return true;
    });
    assert.equal(value.calls.includes("create"), false);
  }
});

test("compaction config overrides are rejected before create so the fixed cut point remains pinned", async t => {
  for (const compaction of [{ keepRecentTokens: 20_001 }, { reserveTokens: 16_385 },
    { keepRecentTokens: 20_000, reserveTokens: 16_384 }]) {
    const value = await fixture(t); await writeFile(value.request.configPath, JSON.stringify({ gateway: { mode: "local" }, bindings: [],
      agents: { defaults: { compaction }, list: [{ id: request.agentId, workspace: value.request.workspaceRoot }] } }));
    await assert.rejects(runCompactionLiveProbe(value.request, value.dependencies), (error: unknown) => {
      assert.equal((error as CompactionLiveProbeError).code, "PROBE_COMPACTION_CONFIG_OVERRIDE"); return true;
    });
    assert.equal(value.calls.includes("create"), false);
  }
});

test("fresh decreasing same-window usage is mandatory", async t => {
  for (const [overrides, code] of [[{ preFresh: false }, "PROBE_USAGE_STALE"],
    [{ postFresh: false }, "PROBE_USAGE_STALE"], [{ postTotalTokens: -1 }, "PROBE_USAGE_VALUES_INVALID"],
    [{ postTotalTokens: 12_000 }, "PROBE_USAGE_NOT_REDUCED"], [{ postTotalTokens: 13_000 }, "PROBE_USAGE_NOT_REDUCED"],
    [{ postContextTokens: 64_000 }, "PROBE_CONTEXT_WINDOW_CHANGED"]] satisfies readonly [FixtureOverrides, string][]) {
    const value = await fixture(t, overrides);
    await assert.rejects(runCompactionLiveProbe(value.request, value.dependencies), (error: unknown) => {
      const observed = error as CompactionLiveProbeError;
      assert.equal(observed.code, code); assert.equal(observed.cleanupCode, null); return true;
    });
    assert.equal(value.calls.includes("delete"), true);
    assert.deepEqual(await readdir(value.request.panelRootParent), []);
  }
});

test("unknown compact outcome and cleanup failures never produce a pass", async t => {
  const compact = await fixture(t, { compactFails: true });
  await assert.rejects(runCompactionLiveProbe(compact.request, compact.dependencies), (error: unknown) => {
    const observed = error as CompactionLiveProbeError;
    assert.equal(observed.code, "PROBE_EXECUTION_FAILED"); assert.equal(observed.cleanupCode, null); return true;
  });
  assert.deepEqual(compact.calls.slice(-3), ["abort", "version", "delete"]);

  const retained = await fixture(t, { compactFails: true, abortFails: true });
  await assert.rejects(runCompactionLiveProbe(retained.request, retained.dependencies), (error: unknown) => {
    const observed = error as CompactionLiveProbeError;
    assert.equal(observed.code, "PROBE_EXECUTION_FAILED"); assert.equal(observed.cleanupCode, "PROBE_RUNTIME_CLEANUP_FAILED");
    assert.equal(JSON.stringify(observed).includes("private"), false); return true;
  });
  assert.equal(retained.calls.includes("delete"), false);

  const deleteFailure = await fixture(t, { deleteFails: true });
  await assert.rejects(runCompactionLiveProbe(deleteFailure.request, deleteFailure.dependencies), (error: unknown) => {
    const observed = error as CompactionLiveProbeError;
    assert.equal(observed.code, "PROBE_CLEANUP_FAILED"); assert.equal(observed.cleanupCode, "PROBE_RUNTIME_CLEANUP_FAILED"); return true;
  });
});

test("panel cleanup failure is classified separately and the report is withheld", async t => {
  const value = await fixture(t), panelPath = join(value.request.panelRootParent, "owned-fixture");
  await mkdir(panelPath, { mode: 0o700 });
  const dependencies = { ...value.dependencies, async createOwnedPanelRoot() {
    return { path: panelPath, async cleanup() { throw new Error("private panel cleanup failure"); } };
  } };
  await assert.rejects(runCompactionLiveProbe(value.request, dependencies), (error: unknown) => {
    const observed = error as CompactionLiveProbeError;
    assert.equal(observed.code, "PROBE_CLEANUP_FAILED"); assert.equal(observed.cleanupCode, "PROBE_PANEL_CLEANUP_FAILED");
    assert.equal(JSON.stringify(observed).includes("private"), false); return true;
  });
});
