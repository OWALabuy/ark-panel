import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CreatedSession, GatewayClient } from "./adapter.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { FileBridgeMaterializer } from "./materializer.js";
import { inspectLiveProbeConfig, inspectLiveProbeCreatedSession, inspectLiveProbeRoot, liveProbeCreatedIdentityValid,
  type LiveProbeConfigIdentity, type LiveProbeRootIdentity } from "./live-probe-preflight.js";
import type { JsonObject } from "../domain/transcript.js";

const VERSION = "2026.6.11";
const SCENARIO = "memory-search-canary-v1";
const CLEANUP_CONFIRMATION = "delete-created-session-v1";
const QUERY_MARKER = "ARK_PANEL_RUNTIME_ACCEPTANCE_QUERY_V1";
const RESULT_MARKER = "ARK_PANEL_RUNTIME_ACCEPTANCE_RESULT_V1";
const CANARY_RELATIVE_PATH = "memory/ark-panel-runtime-acceptance.md";
const CANARY_CONTENT = `# Fictional ark-panel runtime acceptance canary\n\n${QUERY_MARKER}\n${RESULT_MARKER}\n`;
const BOOTSTRAP = ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md", "MEMORY.md"] as const;
const REQUIRED_CONFIGURED_TOOLS = ["browser", "canvas", "memory_search"] as const;
const MAX_WORKSPACE_FILES = 1_000;
const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_FILES = 1_000;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;

export interface RuntimeAcceptanceRequest {
  agentId: string; configPath: string; sessionsRoot: string; workspaceRoot: string; expectedVersion: string;
  scenario: string; maxRuns: number; cleanupConfirmation: string; confirmation: string;
}

export interface RuntimeAcceptanceReport {
  schemaVersion: 1; probe: "runtime-acceptance"; status: "passed"; version: "2026.6.11"; scenario: "memory-search-canary-v1";
  target: Readonly<{ agentId: string }>;
  preflight: Readonly<{ explicitTarget: true; doubleGate: true; zeroBindings: true; sessionsRootIsolated: true;
    workspacePinned: true; effectiveToolsExact: true }>;
  observation: Readonly<{ createCalls: 1; sendCalls: 1; memorySearchCalls: 1; canaryResultObserved: true; workspaceUnchanged: true }>;
  bootstrap: Readonly<Record<typeof BOOTSTRAP[number], true>>;
  skills: Readonly<{ count: number; injected: true }>;
  requiredTools: Readonly<{ browser: true; canvas: true; memory_search: true }>;
  completion: Readonly<{ authoritativeRunCompleted: true }>;
  cleanup: Readonly<{ confirmed: true; completed: true; residualCount: 0 }>;
}

export class RuntimeAcceptanceError extends Error {
  constructor(readonly code: string, readonly cleanupCode: string | null = null) { super(code); this.name = "RuntimeAcceptanceError"; }
}

export interface WorkspaceIdentity { dev: bigint; ino: bigint }
export interface WorkspaceSnapshot { fileCount: number; hash: string }
interface RootEntry { name: string; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; digest: string }

export interface RuntimeAcceptanceDependencies {
  env: NodeJS.ProcessEnv;
  client: GatewayClient;
  randomUUID(): string;
  inspectConfig?(path: string, agentId: string, expected?: LiveProbeConfigIdentity, workspaceRoot?: string): Promise<LiveProbeConfigIdentity>;
  inspectRoot?(path: string, agentId: string, expected?: LiveProbeRootIdentity): Promise<LiveProbeRootIdentity>;
  inspectWorkspace?(path: string, expected?: WorkspaceIdentity): Promise<WorkspaceIdentity>;
  inspectCreated?(created: CreatedSession, request: RuntimeAcceptanceRequest, root: LiveProbeRootIdentity): Promise<void>;
  cleanup?(client: GatewayClient, created: CreatedSession, request: RuntimeAcceptanceRequest,
    expectedRoot: LiveProbeRootIdentity): Promise<readonly string[]>;
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key); if (!value) throw new RuntimeAcceptanceError("PROBE_ARGUMENTS_INVALID"); return value;
}

export function parseRuntimeAcceptanceArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RuntimeAcceptanceRequest {
  const allowed = new Set(["--agent", "--expected-version", "--scenario", "--max-runs", "--cleanup", "--confirm"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) throw new RuntimeAcceptanceError("PROBE_ARGUMENTS_INVALID");
    values.set(flag, value);
  }
  const configPath = env.PANEL_RUNTIME_ACCEPTANCE_CONFIG_PATH, sessionsRoot = env.PANEL_RUNTIME_ACCEPTANCE_SESSIONS_ROOT;
  const workspaceRoot = env.PANEL_RUNTIME_ACCEPTANCE_WORKSPACE_ROOT;
  if (values.size !== allowed.size || !configPath || !sessionsRoot || !workspaceRoot) throw new RuntimeAcceptanceError("PROBE_ARGUMENTS_INVALID");
  const rawRuns = required(values, "--max-runs");
  const request: RuntimeAcceptanceRequest = { agentId: required(values, "--agent"), configPath, sessionsRoot, workspaceRoot,
    expectedVersion: required(values, "--expected-version"), scenario: required(values, "--scenario"),
    maxRuns: /^\d+$/u.test(rawRuns) ? Number(rawRuns) : Number.NaN, cleanupConfirmation: required(values, "--cleanup"),
    confirmation: required(values, "--confirm") };
  validateRequest(request); return request;
}

function validateRequest(request: RuntimeAcceptanceRequest): void {
  const allowedAgent = request.agentId === "paneltest" ||
    /^panel-(?:(?:runtime-probe-[a-z0-9-]{1,48})|(?:[a-z0-9-]{1,48}-runtime))$/u.test(request.agentId);
  if (!allowedAgent || !isAbsolute(request.configPath) ||
    !isAbsolute(request.sessionsRoot) || !isAbsolute(request.workspaceRoot) || request.expectedVersion !== VERSION ||
    request.scenario !== SCENARIO || request.maxRuns !== 1 || request.cleanupConfirmation !== CLEANUP_CONFIRMATION ||
    request.confirmation !== `runtime-acceptance:${request.agentId}:${VERSION}`) throw new RuntimeAcceptanceError("PROBE_ARGUMENTS_INVALID");
}

async function inspectWorkspace(root: string, expected?: WorkspaceIdentity): Promise<WorkspaceIdentity> {
  if (await realpath(root) !== resolve(root)) throw new RuntimeAcceptanceError("PROBE_WORKSPACE_UNSAFE");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o077n) !== 0n) {
      throw new RuntimeAcceptanceError("PROBE_WORKSPACE_UNSAFE");
    }
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) throw new RuntimeAcceptanceError("PROBE_WORKSPACE_CHANGED");
    return identity;
  } finally { await handle.close(); }
}

async function regularBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error("snapshot only supports files"); return await handle.readFile(); }
  finally { await handle.close(); }
}

async function collectWorkspace(root: string, path: string, out: Array<{ path: string; hash: string }>): Promise<void> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) throw new Error("workspace snapshot 遇到符号链接");
  if (stat.isFile()) { out.push({ path: relative(root, path), hash: createHash("sha256").update(await regularBytes(path)).digest("hex") }); return; }
  if (!stat.isDirectory()) throw new Error("workspace snapshot 遇到特殊文件");
  for (const name of (await readdir(path)).sort()) await collectWorkspace(root, join(path, name), out);
}

export async function workspaceSnapshot(workspace: string): Promise<WorkspaceSnapshot> {
  const files: Array<{ path: string; hash: string }> = [];
  for (const name of BOOTSTRAP) await collectWorkspace(workspace, join(workspace, name), files);
  await collectWorkspace(workspace, join(workspace, "memory"), files);
  return { fileCount: files.length, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

interface ProbeWorkspaceSnapshot { fileCount: number; bytes: number; hash: string }
async function probeWorkspaceSnapshot(root: string): Promise<ProbeWorkspaceSnapshot> {
  const values: Array<{ path: string; digest: string }> = []; let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      throw new RuntimeAcceptanceError("PROBE_WORKSPACE_UNSAFE");
    }
    if (stat.isFile()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 ||
          (typeof process.getuid === "function" && current.uid !== process.getuid()) || (current.mode & 0o077) !== 0) {
          throw new RuntimeAcceptanceError("PROBE_WORKSPACE_CHANGED");
        }
        const value = await handle.readFile(); bytes += value.length;
        if (++values.length > MAX_WORKSPACE_FILES || bytes > MAX_WORKSPACE_BYTES) throw new RuntimeAcceptanceError("PROBE_WORKSPACE_TOO_LARGE");
        values.push({ path: relative(root, path), digest: createHash("sha256").update(value).digest("hex") });
      } finally { await handle.close(); }
      return;
    }
    if (!stat.isDirectory()) throw new RuntimeAcceptanceError("PROBE_WORKSPACE_UNSAFE");
    for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  };
  await walk(root); return { fileCount: values.length, bytes, hash: createHash("sha256").update(JSON.stringify(values)).digest("hex") };
}

async function inspectCanary(workspaceRoot: string): Promise<void> {
  const path = join(workspaceRoot, CANARY_RELATIVE_PATH), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 || await handle.readFile("utf8") !== CANARY_CONTENT) throw new RuntimeAcceptanceError("PROBE_CANARY_INVALID");
  }
  finally { await handle.close(); }
}

async function rootSnapshot(root: string): Promise<readonly RootEntry[]> {
  const values: RootEntry[] = []; let bytes = 0;
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) || (before.mode & 0o077n) !== 0n) {
      throw new RuntimeAcceptanceError("PROBE_ROOT_CONTENTS_UNSAFE");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1n) throw new RuntimeAcceptanceError("PROBE_ROOT_CHANGED");
      const contents = await handle.readFile(); bytes += contents.length;
      if (values.length >= MAX_RUNTIME_FILES || bytes > MAX_RUNTIME_BYTES) throw new RuntimeAcceptanceError("PROBE_ROOT_TOO_LARGE");
      values.push({ name, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs,
        digest: createHash("sha256").update(contents).digest("hex") });
    } finally { await handle.close(); }
  }
  return values;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function resultText(block: JsonObject): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.flatMap(raw => {
    const value = object(raw); return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
  return typeof block.text === "string" ? block.text : "";
}

function directMemorySearch(entries: readonly JsonObject[]): string | undefined {
  const calls: Array<{ entry: JsonObject; index: number; id: string; query: string }> = [];
  const results: Array<{ entry: JsonObject; index: number; id: string; content: string }> = [];
  for (const [index, entry] of entries.entries()) {
    const message = object(entry.message), content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = object(raw); if (!block) continue;
      if (block.type === "tool_use" || block.type === "toolCall") {
        const input = object(block.input ?? block.args), id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : "";
        if (message?.role !== "assistant" || block.name !== "memory_search" || !id || typeof input?.query !== "string") return undefined;
        calls.push({ entry, index, id, query: input.query });
      }
      if (block.type === "tool_result" || block.type === "toolResult") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : typeof block.toolCallId === "string" ? block.toolCallId : "";
        if (message?.role !== "toolResult" || !id) return undefined;
        results.push({ entry, index, id, content: resultText(block) });
      }
    }
  }
  const call = calls[0], result = results[0];
  if (calls.length !== 1 || results.length !== 1 || !call || !result || call.query !== QUERY_MARKER || result.id !== call.id ||
    result.index <= call.index || typeof call.entry.id !== "string" || result.entry.parentId !== call.entry.id ||
    !result.content.includes(RESULT_MARKER) || typeof result.entry.id !== "string") return undefined;
  const summaries = entries.flatMap((entry, index) => {
    if (index <= result.index || entry.parentId !== result.entry.id) return [];
    const message = object(entry.message); if (message?.role !== "assistant") return [];
    if (typeof message.content === "string") return [{ text: message.content }];
    if (!Array.isArray(message.content)) return [];
    const texts = message.content.flatMap(raw => {
      const block = object(raw); return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    });
    return texts.length ? [{ text: texts.join("\n") }] : [];
  });
  return summaries.length === 1 ? summaries[0]!.text : undefined;
}

function runtimeSummary(text: string): { bootstrap: Record<typeof BOOTSTRAP[number], true>; skillCount: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new RuntimeAcceptanceError("PROBE_MODEL_REPORT_INVALID"); }
  const value = object(parsed);
  if (!value || !isDeepStrictEqual(Object.keys(value).sort(), ["bootstrapNames", "skillNames"]) ||
    !Array.isArray(value.bootstrapNames) || !Array.isArray(value.skillNames)) throw new RuntimeAcceptanceError("PROBE_MODEL_REPORT_INVALID");
  const bootstrapNames = value.bootstrapNames;
  if (bootstrapNames.length !== BOOTSTRAP.length || !bootstrapNames.every(name => typeof name === "string") ||
    !isDeepStrictEqual([...new Set(bootstrapNames)].sort(), [...BOOTSTRAP].sort())) throw new RuntimeAcceptanceError("PROBE_BOOTSTRAP_INCOMPLETE");
  const skills = value.skillNames;
  if (!skills.length || skills.length > 100 || !skills.every(name => typeof name === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(name)) ||
    new Set(skills).size !== skills.length) throw new RuntimeAcceptanceError("PROBE_SKILLS_INVALID");
  return { bootstrap: Object.fromEntries(BOOTSTRAP.map(name => [name, true])) as Record<typeof BOOTSTRAP[number], true>,
    skillCount: skills.length };
}

function primaryCode(error: unknown): string { return error instanceof RuntimeAcceptanceError ? error.code : "PROBE_EXECUTION_FAILED"; }

export async function runRuntimeAcceptance(request: RuntimeAcceptanceRequest,
  dependencies: RuntimeAcceptanceDependencies): Promise<RuntimeAcceptanceReport> {
  validateRequest(request);
  if (dependencies.env.PANEL_ALLOW_RUNTIME_ACCEPTANCE !== "1") throw new RuntimeAcceptanceError("PROBE_GATE_REQUIRED");
  if (dependencies.env.PANEL_OPENCLAW_GATEWAY_URL !== undefined || dependencies.env.OPENCLAW_GATEWAY_PORT !== undefined) {
    throw new RuntimeAcceptanceError("PROBE_ENDPOINT_OVERRIDE_FORBIDDEN");
  }
  const fail = (code: string) => new RuntimeAcceptanceError(code);
  const inspectConfig = dependencies.inspectConfig ?? ((path, agent, expected, workspace) => inspectLiveProbeConfig(path, agent, expected, fail, workspace));
  const inspectRoot = dependencies.inspectRoot ?? ((path, agent, expected) => inspectLiveProbeRoot(path, agent, expected, fail));
  const checkWorkspace = dependencies.inspectWorkspace ?? inspectWorkspace;
  const inspectCreated = dependencies.inspectCreated ?? ((created, value, root) => inspectLiveProbeCreatedSession(created, value.sessionsRoot, value.agentId, root, fail));
  const roots = new Map([[request.agentId, request.sessionsRoot]]);
  const cleanup = dependencies.cleanup ?? ((client, created, _request, expectedRoot) => unregisterAndClean(client, { runtimeAgentId: request.agentId,
    sessionId: created.sessionId, sessionKey: created.sessionKey, runtimeSessionsRoot: request.sessionsRoot, allowedRuntimeRoots: roots,
    expectedRuntimeRootIdentity: expectedRoot }));
  const configIdentity = await inspectConfig(request.configPath, request.agentId, undefined, request.workspaceRoot);
  const rootIdentity = await inspectRoot(request.sessionsRoot, request.agentId), workspaceIdentity = await checkWorkspace(request.workspaceRoot);
  await inspectCanary(request.workspaceRoot); const beforeWorkspace = await probeWorkspaceSnapshot(request.workspaceRoot);
  const beforeRoot = await rootSnapshot(request.sessionsRoot);
  if (beforeRoot.length !== 0) throw new RuntimeAcceptanceError("PROBE_ROOT_NOT_EMPTY");
  await inspectConfig(request.configPath, request.agentId, configIdentity, request.workspaceRoot);
  if (await dependencies.client.version() !== request.expectedVersion) throw new RuntimeAcceptanceError("PROBE_VERSION_MISMATCH");
  let created: CreatedSession | undefined, acceptedRunId: string | undefined, sendAttempted = false, complete = false;
  let primary: unknown, cleanupCode: string | null = null, report: RuntimeAcceptanceReport | undefined;
  const materializer = new FileBridgeMaterializer();
  try {
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity); await checkWorkspace(request.workspaceRoot, workspaceIdentity);
    const configured = await dependencies.client.configuredTools?.(request.agentId);
    const configuredIds = configured?.groups.flatMap(group => group.tools.map(tool => tool.id));
    if (!configured || configured.agentId !== request.agentId || !configuredIds ||
      REQUIRED_CONFIGURED_TOOLS.some(tool => !configuredIds.includes(tool))) throw new RuntimeAcceptanceError("PROBE_CONFIGURED_TOOLS_MISSING");
    await inspectConfig(request.configPath, request.agentId, configIdentity, request.workspaceRoot);
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity); await checkWorkspace(request.workspaceRoot, workspaceIdentity);
    const candidate = await dependencies.client.createSession(request.agentId); created = candidate;
    if (!liveProbeCreatedIdentityValid(candidate, request.sessionsRoot, request.agentId)) throw new RuntimeAcceptanceError("PROBE_CREATED_SESSION_INVALID");
    await inspectCreated(created, request, rootIdentity);
    const tools = await dependencies.client.effectiveTools?.(request.agentId, created.sessionKey);
    if (!tools || tools.agentId !== request.agentId || !isDeepStrictEqual(tools.toolIds, ["memory_search"])) {
      throw new RuntimeAcceptanceError("PROBE_EFFECTIVE_TOOLS_MISMATCH");
    }
    await inspectCreated(created, request, rootIdentity);
    await inspectConfig(request.configPath, request.agentId, configIdentity, request.workspaceRoot);
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity); await checkWorkspace(request.workspaceRoot, workspaceIdentity);
    const previous = await materializer.replaceCreatedTranscript(created, { header: { type: "session", version: 3, id: created.sessionId,
      timestamp: "2026-08-14T00:00:00.000Z", cwd: request.workspaceRoot }, entries: [] });
    await inspectConfig(request.configPath, request.agentId, configIdentity, request.workspaceRoot);
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity); await checkWorkspace(request.workspaceRoot, workspaceIdentity);
    const requestedRunId = dependencies.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestedRunId)) {
      throw new RuntimeAcceptanceError("PROBE_RUN_ID_INVALID");
    }
    acceptedRunId = requestedRunId; sendAttempted = true;
    const accepted = await dependencies.client.send(created.sessionKey,
      `Fictional isolated acceptance. Call memory_search exactly once with query ${QUERY_MARKER}. Do not call another tool. Then output only strict JSON with exactly two keys: bootstrapNames (workspace bootstrap document names explicitly injected by the system prompt, names only) and skillNames (skill names explicitly listed by the system prompt, names only). Do not quote any document, memory, result, path, credential, or other system-prompt text.`, requestedRunId);
    acceptedRunId = accepted.runId;
    if (acceptedRunId !== requestedRunId) throw new RuntimeAcceptanceError("PROBE_RUN_ID_MISMATCH");
    await dependencies.client.waitForCompletion(created.sessionId, acceptedRunId); complete = true;
    const added = await materializer.readNewEntries(created, previous);
    const summaryText = directMemorySearch(added);
    if (summaryText === undefined) throw new RuntimeAcceptanceError("PROBE_MEMORY_RESULT_INVALID");
    const summary = runtimeSummary(summaryText.trim());
    await checkWorkspace(request.workspaceRoot, workspaceIdentity); await inspectCanary(request.workspaceRoot);
    if (!isDeepStrictEqual(await probeWorkspaceSnapshot(request.workspaceRoot), beforeWorkspace)) throw new RuntimeAcceptanceError("PROBE_WORKSPACE_CHANGED");
    report = Object.freeze({ schemaVersion: 1, probe: "runtime-acceptance", status: "passed", version: VERSION, scenario: SCENARIO,
      target: Object.freeze({ agentId: request.agentId }),
      preflight: Object.freeze({ explicitTarget: true, doubleGate: true, zeroBindings: true, sessionsRootIsolated: true,
        workspacePinned: true, effectiveToolsExact: true }),
      observation: Object.freeze({ createCalls: 1, sendCalls: 1, memorySearchCalls: 1, canaryResultObserved: true, workspaceUnchanged: true }),
      bootstrap: Object.freeze(summary.bootstrap), skills: Object.freeze({ count: summary.skillCount, injected: true }),
      requiredTools: Object.freeze({ browser: true, canvas: true, memory_search: true }),
      completion: Object.freeze({ authoritativeRunCompleted: true }), cleanup: Object.freeze({ confirmed: true, completed: true, residualCount: 0 }) });
  } catch (error) { primary = error; }
  finally {
    if (created) {
      let safe = !sendAttempted || complete;
      if (sendAttempted && !complete && acceptedRunId) {
        try { await dependencies.client.abort(created.sessionKey, acceptedRunId, created.sessionId); safe = true; }
        catch { cleanupCode = "PROBE_ABORT_UNCONFIRMED"; }
      }
      if (safe) {
        try { await cleanup(dependencies.client, created, request, rootIdentity); }
        catch { cleanupCode = "PROBE_CLEANUP_FAILED"; }
      }
    }
    try {
      await inspectConfig(request.configPath, request.agentId, configIdentity, request.workspaceRoot);
      await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
      if (!isDeepStrictEqual(await rootSnapshot(request.sessionsRoot), beforeRoot)) throw new Error();
    } catch { cleanupCode ??= "PROBE_CLEANUP_FAILED"; }
    try {
      await checkWorkspace(request.workspaceRoot, workspaceIdentity); await inspectCanary(request.workspaceRoot);
      if (!isDeepStrictEqual(await probeWorkspaceSnapshot(request.workspaceRoot), beforeWorkspace)) throw new Error();
    } catch { cleanupCode ??= "PROBE_WORKSPACE_CHANGED"; }
  }
  if (primary) throw new RuntimeAcceptanceError(primaryCode(primary), cleanupCode);
  if (cleanupCode || !report) throw new RuntimeAcceptanceError("PROBE_CLEANUP_FAILED", cleanupCode);
  return report;
}
