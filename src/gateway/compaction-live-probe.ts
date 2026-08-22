import { isDeepStrictEqual } from "node:util";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { currentTranscriptBranch } from "../domain/branch.js";
import { ConservativeContextBudget } from "../domain/context-budget.js";
import type { OpenClawContextUsage } from "../domain/context-usage.js";
import type { TranscriptDocument } from "../domain/transcript.js";
import { parseTranscript } from "../domain/transcript.js";
import { PanelCompactionApi } from "../server/compaction-api.js";
import { SessionReadData } from "../server/read-data.js";
import { SessionOperationCoordinator } from "../server/session-operation.js";
import { SessionReadIndex } from "../storage/index.js";
import { createPanelSession, loadPanelSession } from "../storage/panel-sessions.js";
import { SUPPORTED_OPENCLAW_VERSION, type CreatedSession, type GatewayClient } from "./adapter.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { BridgeService } from "./bridge-service.js";
import { inspectLiveProbeConfig, inspectLiveProbeCreatedSession, inspectLiveProbeRoot, liveProbeCreatedIdentityValid,
  liveProbeRuntimeSnapshot, type LiveProbeConfigIdentity, type LiveProbeRootIdentity } from "./live-probe-preflight.js";
import { FileBridgeMaterializer } from "./materializer.js";

const SCENARIO = "panel-compaction-v1";
const CLEANUP_CONFIRMATION = "delete-created-session-v1";
const RECORD_ID = "compaction-probe-record";
const PANEL_AGENT_ID = "compaction-probe-panel";
const PANEL_ROOT_PREFIX = "ark-panel-compaction-probe-";
export const COMPACTION_PROBE_CONTEXT_BUDGET = 300_000;
export const COMPACTION_PROBE_RECENT_CHARACTER_FLOOR = 80_000;
const PANEL_ROOT_CONTENTS = new Set([
  "sessions", `sessions/${PANEL_AGENT_ID}`, `sessions/${PANEL_AGENT_ID}/${RECORD_ID}`,
  `sessions/${PANEL_AGENT_ID}/${RECORD_ID}/metadata.json`, `sessions/${PANEL_AGENT_ID}/${RECORD_ID}/transcript.jsonl`
]);

export interface CompactionLiveProbeRequest {
  agentId: string; sessionsRoot: string; configPath: string; panelRootParent: string; workspaceRoot: string;
  expectedVersion: string; scenario: string;
  maxCompactions: number; cleanupConfirmation: string; confirmation: string;
}

export interface CompactionLiveProbeReport {
  schemaVersion: 1; probe: "compaction"; status: "passed"; version: string; scenario: "panel-compaction-v1";
  preflight: Readonly<{ explicitTarget: true; doubleGate: true; zeroBindings: true; sessionsRootIsolated: true; effectiveToolsExact: true }>;
  observation: Readonly<{ createCalls: 1; compactCalls: 1; sendCalls: 0; sameSessionUsage: true; prefixPreserved: true;
    effectiveReduction: true; tokensBefore: number; postTotalTokens: number; contextTokens: number }>;
  reload: Readonly<{ revisionBefore: string; revisionAfter: string; revisionChanged: true; usageAtCurrentTip: true; matchesPost: true }>;
  cleanup: Readonly<{ confirmed: true; completed: true; residualCount: 0 }>;
}

export class CompactionLiveProbeError extends Error {
  constructor(readonly code: string, readonly cleanupCode: string | null = null) { super(code); this.name = "CompactionLiveProbeError"; }
}

export interface CompactionProbeObservation {
  compacted: boolean;
  reason?: unknown;
  upstreamCompacted?: unknown;
  createCalls: number;
  compactCalls: number;
  sendCalls: number;
  deleteCalls: number;
  usageCalls: number;
  preUsage?: Readonly<{ source: unknown; totalTokens: unknown; contextTokens: unknown; totalTokensFresh: unknown }> | undefined;
  postUsage?: Readonly<{ source: unknown; totalTokens: unknown; contextTokens: unknown; totalTokensFresh: unknown }> | undefined;
}

export function classifyCompactionProbeObservation(observation: CompactionProbeObservation): string | null {
  if (!observation.compacted) return observation.upstreamCompacted === true && observation.reason === "NO_EFFECTIVE_REDUCTION" ?
    "PROBE_PANEL_NO_EFFECTIVE_REDUCTION" : "PROBE_COMPACTION_NOT_ACCEPTED";
  if (observation.upstreamCompacted !== true) return "PROBE_COMPACTION_PROVENANCE_INVALID";
  if (observation.createCalls !== 1 || observation.compactCalls !== 1 || observation.sendCalls !== 0 ||
    observation.deleteCalls !== 1 || observation.usageCalls !== 2) return "PROBE_CALL_COUNTS_INVALID";
  const preUsage = observation.preUsage, postUsage = observation.postUsage;
  if (!preUsage || !postUsage) return "PROBE_USAGE_MISSING";
  if (preUsage.source !== "openclaw-session" || postUsage.source !== "openclaw-session") return "PROBE_USAGE_SOURCE_INVALID";
  if (preUsage.totalTokensFresh !== true || postUsage.totalTokensFresh !== true) return "PROBE_USAGE_STALE";
  if (typeof preUsage.totalTokens !== "number" || typeof postUsage.totalTokens !== "number" || typeof preUsage.contextTokens !== "number" ||
    typeof postUsage.contextTokens !== "number" || !Number.isSafeInteger(preUsage.totalTokens) ||
    !Number.isSafeInteger(postUsage.totalTokens) || !Number.isSafeInteger(preUsage.contextTokens) ||
    !Number.isSafeInteger(postUsage.contextTokens) || preUsage.totalTokens < 0 || postUsage.totalTokens < 0 ||
    preUsage.contextTokens <= 0 || postUsage.contextTokens <= 0) return "PROBE_USAGE_VALUES_INVALID";
  if (postUsage.contextTokens !== preUsage.contextTokens) return "PROBE_CONTEXT_WINDOW_CHANGED";
  if (postUsage.totalTokens >= preUsage.totalTokens) return "PROBE_USAGE_NOT_REDUCED";
  return null;
}

interface OwnedPanelRoot {
  path: string;
  cleanup(): Promise<void>;
}

export interface CompactionLiveProbeDependencies {
  env: NodeJS.ProcessEnv;
  client: GatewayClient;
  createOwnedPanelRoot?(parent: string): Promise<OwnedPanelRoot>;
  inspectConfig?(path: string, agentId: string, expected?: LiveProbeConfigIdentity): Promise<LiveProbeConfigIdentity>;
  inspectRoot?(path: string, agentId: string, expected?: LiveProbeRootIdentity): Promise<LiveProbeRootIdentity>;
  inspectCreated?(created: CreatedSession, request: CompactionLiveProbeRequest, root: LiveProbeRootIdentity): Promise<void>;
  cleanup?(client: GatewayClient, created: CreatedSession, request: CompactionLiveProbeRequest): Promise<readonly string[]>;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name); if (!value) throw new CompactionLiveProbeError("PROBE_ARGUMENTS_INVALID"); return value;
}

export function parseCompactionLiveProbeArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CompactionLiveProbeRequest {
  const allowed = new Set(["--agent", "--expected-version", "--scenario", "--max-compactions", "--cleanup", "--confirm"]), values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) throw new CompactionLiveProbeError("PROBE_ARGUMENTS_INVALID");
    values.set(flag, value);
  }
  const sessionsRoot = env.PANEL_COMPACTION_PROBE_SESSIONS_ROOT, configPath = env.PANEL_COMPACTION_PROBE_CONFIG_PATH;
  const panelRootParent = env.PANEL_COMPACTION_PROBE_PANEL_ROOT_PARENT;
  const workspaceRoot = env.PANEL_COMPACTION_PROBE_WORKSPACE_ROOT;
  if (values.size !== allowed.size || !sessionsRoot || !configPath || !panelRootParent || !workspaceRoot) {
    throw new CompactionLiveProbeError("PROBE_ARGUMENTS_INVALID");
  }
  const rawMax = required(values, "--max-compactions"), request: CompactionLiveProbeRequest = { agentId: required(values, "--agent"), sessionsRoot,
    configPath, panelRootParent, workspaceRoot, expectedVersion: required(values, "--expected-version"), scenario: required(values, "--scenario"),
    maxCompactions: /^\d+$/u.test(rawMax) ? Number(rawMax) : Number.NaN, cleanupConfirmation: required(values, "--cleanup"),
    confirmation: required(values, "--confirm") };
  validateRequest(request); return request;
}

function validateRequest(request: CompactionLiveProbeRequest): void {
  const agent = /^panel-probe-[a-z0-9-]{1,48}$/u.test(request.agentId);
  if (!agent || !isAbsolute(request.sessionsRoot) || !isAbsolute(request.configPath) || !isAbsolute(request.panelRootParent) ||
    !isAbsolute(request.workspaceRoot) ||
    request.expectedVersion !== SUPPORTED_OPENCLAW_VERSION || request.scenario !== SCENARIO || request.maxCompactions !== 1 ||
    request.cleanupConfirmation !== CLEANUP_CONFIRMATION || request.confirmation !== `compaction:${request.agentId}:${SUPPORTED_OPENCLAW_VERSION}`) {
    throw new CompactionLiveProbeError("PROBE_ARGUMENTS_INVALID");
  }
}

export function compactionProbeHistory(): TranscriptDocument {
  return { header: { type: "session", version: 3, id: "10000000-0000-4000-8000-000000000001", timestamp: "2026-08-14T00:00:00.000Z",
    panel: { recordId: RECORD_ID, createdAt: "2026-08-14T00:00:00.000Z", title: "Fictional compaction probe" } }, entries: [
    { type: "message", id: "probe-u1", parentId: null, timestamp: "2026-08-14T00:00:01.000Z",
      message: { role: "user", content: "Fictional old context for summarization. ".repeat(3_500) } },
    { type: "message", id: "probe-a1", parentId: "probe-u1", timestamp: "2026-08-14T00:00:02.000Z",
      message: { role: "assistant", content: "Fictional acknowledgement before the retained tail." } },
    { type: "message", id: "probe-u2", parentId: "probe-a1", timestamp: "2026-08-14T00:00:03.000Z",
      message: { role: "user", content: "Fictional recent context that must remain after compaction. ".repeat(1_600) } },
    { type: "message", id: "probe-a2", parentId: "probe-u2", timestamp: "2026-08-14T00:00:04.000Z",
      message: { role: "assistant", content: "Fictional retained tail." } }
  ] };
}

function compactionConfigDefaults(config: Readonly<Record<string, unknown>>): string | null {
  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return "PROBE_AGENT_CONFIG_INVALID";
  const defaults = (agents as Readonly<Record<string, unknown>>).defaults;
  if (defaults === undefined) return null;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return "PROBE_AGENT_CONFIG_INVALID";
  return Object.prototype.hasOwnProperty.call(defaults, "compaction") ? "PROBE_COMPACTION_CONFIG_OVERRIDE" : null;
}

async function ownedPanelRoot(parent: string): Promise<OwnedPanelRoot> {
  if (!isAbsolute(parent) || await realpath(parent) !== resolve(parent)) throw new CompactionLiveProbeError("PROBE_PANEL_PARENT_UNSAFE");
  const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await parentHandle.stat({ bigint: true });
    if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o077n) !== 0n ||
      (await readdir(parent)).length !== 0) {
      throw new CompactionLiveProbeError("PROBE_PANEL_PARENT_UNSAFE");
    }
  } finally { await parentHandle.close(); }
  const path = await mkdtemp(join(parent, PANEL_ROOT_PREFIX));
  const identity = await lstat(path, { bigint: true });
  if (!identity.isDirectory() || (typeof process.getuid === "function" && identity.uid !== BigInt(process.getuid())) ||
    (identity.mode & 0o077n) !== 0n) throw new CompactionLiveProbeError("PROBE_PANEL_ROOT_CHANGED");
  return { path, async cleanup() {
    const current = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new CompactionLiveProbeError("PROBE_PANEL_ROOT_CHANGED");
    }
    const found = new Map<string, BigIntStats>();
    const walk = async (directory: string, prefix = ""): Promise<void> => {
      for (const name of await readdir(directory)) {
        const relative = prefix ? `${prefix}/${name}` : name, child = join(directory, name), stat = await lstat(child, { bigint: true });
        if (!PANEL_ROOT_CONTENTS.has(relative) || stat.isSymbolicLink() ||
          (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o077n) !== 0n ||
          !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) {
          throw new CompactionLiveProbeError("PROBE_PANEL_ROOT_CONTENTS_UNSAFE");
        }
        found.set(relative, stat); if (stat.isDirectory()) await walk(child, relative);
      }
    };
    await walk(path);
    for (const relative of [...found.keys()].sort((left, right) => right.split("/").length - left.split("/").length)) {
      const child = join(path, relative), expected = found.get(relative); if (!expected) continue;
      const currentChild = await lstat(child, { bigint: true });
      if (currentChild.dev !== expected.dev || currentChild.ino !== expected.ino || currentChild.isSymbolicLink()) {
        throw new CompactionLiveProbeError("PROBE_PANEL_ROOT_CHANGED");
      }
      if (currentChild.isDirectory()) await rmdir(child); else await unlink(child);
    }
    const final = await lstat(path, { bigint: true });
    if (final.dev !== identity.dev || final.ino !== identity.ino) throw new CompactionLiveProbeError("PROBE_PANEL_ROOT_CHANGED");
    await rmdir(path);
  } };
}

interface WorkspaceIdentity { dev: bigint; ino: bigint }
async function inspectEmptyWorkspace(path: string, expected?: WorkspaceIdentity): Promise<WorkspaceIdentity> {
  const canonical = resolve(path);
  if (!isAbsolute(path) || await realpath(path) !== canonical) throw new CompactionLiveProbeError("PROBE_WORKSPACE_UNSAFE");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
      (stat.mode & 0o077n) !== 0n || (await readdir(path)).length !== 0) throw new CompactionLiveProbeError("PROBE_WORKSPACE_UNSAFE");
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
      throw new CompactionLiveProbeError("PROBE_WORKSPACE_CHANGED");
    }
    return identity;
  } finally { await handle.close(); }
}

class RecordingCompactionClient implements GatewayClient {
  created: CreatedSession | undefined; preUsage: OpenClawContextUsage | undefined; postUsage: OpenClawContextUsage | undefined;
  upstreamCompacted: boolean | undefined;
  createCalls = 0; compactCalls = 0; sendCalls = 0; deleteCalls = 0; usageCalls = 0;
  constructor(private readonly client: GatewayClient, private readonly request: CompactionLiveProbeRequest,
    private readonly root: LiveProbeRootIdentity, private readonly inspectCreated: NonNullable<CompactionLiveProbeDependencies["inspectCreated"]>,
    private readonly inspectRoot: NonNullable<CompactionLiveProbeDependencies["inspectRoot"]>,
    private readonly cleanup: NonNullable<CompactionLiveProbeDependencies["cleanup"]>) {}
  version(): Promise<string> { return this.client.version(); }
  async createSession(runtimeAgentId: string): Promise<CreatedSession> {
    if (runtimeAgentId !== this.request.agentId) throw new CompactionLiveProbeError("PROBE_AGENT_MISMATCH");
    this.createCalls++; const created = await this.client.createSession(runtimeAgentId); this.created = created;
    try {
      if (!liveProbeCreatedIdentityValid(created, this.request.sessionsRoot, this.request.agentId)) throw new CompactionLiveProbeError("PROBE_CREATED_SESSION_INVALID");
      await this.inspectCreated(created, this.request, this.root);
      const createdDocument = parseTranscript(await readFile(created.transcriptPath, "utf8"));
      if (createdDocument.header.id !== created.sessionId || createdDocument.entries.length !== 0) {
        throw new CompactionLiveProbeError("PROBE_CREATED_SESSION_INVALID");
      }
      const tools = await this.client.effectiveTools?.(runtimeAgentId, created.sessionKey);
      if (!tools || tools.agentId !== runtimeAgentId || tools.toolIds.length !== 0) throw new CompactionLiveProbeError("PROBE_EFFECTIVE_TOOLS_MISMATCH");
      await this.inspectCreated(created, this.request, this.root);
      return created;
    } catch (error) {
      try {
        await this.inspectRoot(this.request.sessionsRoot, this.request.agentId, this.root);
        await this.cleanup(this.client, created, this.request);
        await this.inspectRoot(this.request.sessionsRoot, this.request.agentId, this.root); this.created = undefined;
      }
      catch { throw new CompactionLiveProbeError(error instanceof CompactionLiveProbeError ? error.code : "PROBE_EXECUTION_FAILED", "PROBE_CLEANUP_FAILED"); }
      throw error;
    }
  }
  async compactSession(sessionKey: string) {
    if (sessionKey !== this.created?.sessionKey) throw new CompactionLiveProbeError("PROBE_SESSION_MISMATCH");
    this.compactCalls++;
    this.usageCalls++; this.preUsage = await this.client.sessionContextUsage?.(this.request.agentId, sessionKey);
    const result = await this.client.compactSession?.(sessionKey); if (!result) throw new CompactionLiveProbeError("PROBE_COMPACTION_UNSUPPORTED");
    this.upstreamCompacted = result.compacted;
    return result;
  }
  async sessionContextUsage(runtimeAgentId: string, sessionKey: string) {
    if (runtimeAgentId !== this.request.agentId || sessionKey !== this.created?.sessionKey) throw new CompactionLiveProbeError("PROBE_SESSION_MISMATCH");
    this.usageCalls++; this.postUsage = await this.client.sessionContextUsage?.(runtimeAgentId, sessionKey); return this.postUsage;
  }
  async send(..._args: Parameters<GatewayClient["send"]>): Promise<{ runId: string }> { this.sendCalls++; throw new CompactionLiveProbeError("PROBE_SEND_FORBIDDEN"); }
  waitForCompletion(...args: Parameters<GatewayClient["waitForCompletion"]>): Promise<void> { return this.client.waitForCompletion(...args); }
  abort(...args: Parameters<GatewayClient["abort"]>): Promise<void> { return this.client.abort(...args); }
  deleteSession(...args: Parameters<GatewayClient["deleteSession"]>): Promise<void> { this.deleteCalls++; return this.client.deleteSession(...args); }
  applySessionOverrides(...args: Parameters<NonNullable<GatewayClient["applySessionOverrides"]>>): Promise<void> {
    if (!this.client.applySessionOverrides) throw new CompactionLiveProbeError("PROBE_OVERRIDES_UNSUPPORTED");
    return this.client.applySessionOverrides(...args);
  }
}

function errorCode(error: unknown): string {
  return error instanceof CompactionLiveProbeError ? error.code : "PROBE_EXECUTION_FAILED";
}

export async function runCompactionLiveProbe(request: CompactionLiveProbeRequest,
  dependencies: CompactionLiveProbeDependencies): Promise<CompactionLiveProbeReport> {
  validateRequest(request);
  if (dependencies.env.PANEL_ALLOW_COMPACTION_LIVE_PROBE !== "1") throw new CompactionLiveProbeError("PROBE_GATE_REQUIRED");
  if (dependencies.env.PANEL_OPENCLAW_GATEWAY_URL !== undefined || dependencies.env.OPENCLAW_GATEWAY_PORT !== undefined) {
    throw new CompactionLiveProbeError("PROBE_ENDPOINT_OVERRIDE_FORBIDDEN");
  }
  const fail = (code: string) => new CompactionLiveProbeError(code);
  const inspectConfig = dependencies.inspectConfig ?? ((path, agent, expected) =>
    inspectLiveProbeConfig(path, agent, expected, fail, request.workspaceRoot, compactionConfigDefaults));
  const inspectRoot = dependencies.inspectRoot ?? ((path, agent, expected) => inspectLiveProbeRoot(path, agent, expected, fail));
  const inspectCreated = dependencies.inspectCreated ?? ((created, value, root) => inspectLiveProbeCreatedSession(created, value.sessionsRoot, value.agentId, root, fail));
  const roots = new Map([[request.agentId, request.sessionsRoot]]);
  const configIdentity = await inspectConfig(request.configPath, request.agentId), rootIdentity = await inspectRoot(request.sessionsRoot, request.agentId);
  const cleanup = dependencies.cleanup ?? ((client, created) => unregisterAndClean(client, { runtimeAgentId: request.agentId,
    sessionId: created.sessionId, sessionKey: created.sessionKey, runtimeSessionsRoot: request.sessionsRoot, allowedRuntimeRoots: roots,
    expectedRuntimeRootIdentity: rootIdentity }));
  const workspaceIdentity = await inspectEmptyWorkspace(request.workspaceRoot);
  await inspectConfig(request.configPath, request.agentId, configIdentity);
  if (await dependencies.client.version() !== request.expectedVersion) throw new CompactionLiveProbeError("PROBE_VERSION_MISMATCH");
  await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
  const canonicalPanelParent = await realpath(request.panelRootParent), canonicalRuntimeRoot = await realpath(request.sessionsRoot);
  const canonicalWorkspace = await realpath(request.workspaceRoot);
  if (canonicalPanelParent === canonicalRuntimeRoot || canonicalPanelParent.startsWith(`${canonicalRuntimeRoot}/`) ||
    canonicalRuntimeRoot.startsWith(`${canonicalPanelParent}/`) || canonicalWorkspace === canonicalRuntimeRoot ||
    canonicalWorkspace.startsWith(`${canonicalRuntimeRoot}/`) || canonicalRuntimeRoot.startsWith(`${canonicalWorkspace}/`) ||
    canonicalPanelParent === canonicalWorkspace || canonicalPanelParent.startsWith(`${canonicalWorkspace}/`) ||
    canonicalWorkspace.startsWith(`${canonicalPanelParent}/`)) throw new CompactionLiveProbeError("PROBE_PANEL_PARENT_UNSAFE");
  const snapshotRuntime = () => liveProbeRuntimeSnapshot(request.sessionsRoot, code => new CompactionLiveProbeError(code));
  const beforeRuntime = await snapshotRuntime(), createRoot = dependencies.createOwnedPanelRoot ?? ownedPanelRoot;
  if (beforeRuntime.length !== 0) throw new CompactionLiveProbeError("PROBE_RUNTIME_NOT_EMPTY");
  let panel: OwnedPanelRoot | undefined, primary: unknown, report: CompactionLiveProbeReport | undefined, cleanupCode: string | null = null;
  try {
    panel = await createRoot(request.panelRootParent);
    const history = compactionProbeHistory(), budget = new ConservativeContextBudget(COMPACTION_PROBE_CONTEXT_BUDGET);
    const beforeTokens = budget.assertWithinBudget(history, "").estimatedTokens;
    await createPanelSession(panel.path, PANEL_AGENT_ID, history, { recordId: RECORD_ID, createdAt: "2026-08-14T00:00:00.000Z" });
    const operations = new SessionOperationCoordinator(), client = new RecordingCompactionClient(dependencies.client, request, rootIdentity,
      inspectCreated, inspectRoot, cleanup);
    const bridge = new BridgeService(client, new FileBridgeMaterializer(() => new Date("2026-08-14T00:01:00.000Z")), roots,
      undefined, undefined, new Map([[request.agentId, rootIdentity]]));
    const api = new PanelCompactionApi(bridge, { dataRoot: panel.path, runtimeByAgent: new Map([[PANEL_AGENT_ID, request.agentId]]),
      contextBudget: budget, operations });
    const transcriptPath = join(panel.path, "sessions", PANEL_AGENT_ID, RECORD_ID, "transcript.jsonl");
    const initial = await loadPanelSession(panel.path, PANEL_AGENT_ID, RECORD_ID), initialStat = await lstat(transcriptPath);
    const initialRevision = `${initialStat.size}:${initialStat.mtimeMs}`, result = await api.compact(RECORD_ID, initialRevision);
    const observationError = classifyCompactionProbeObservation({ compacted: result.compacted, reason: result.reason,
      upstreamCompacted: client.upstreamCompacted,
      createCalls: client.createCalls,
      compactCalls: client.compactCalls, sendCalls: client.sendCalls, deleteCalls: client.deleteCalls, usageCalls: client.usageCalls,
      ...(client.preUsage ? { preUsage: client.preUsage } : {}), ...(client.postUsage ? { postUsage: client.postUsage } : {}) });
    if (observationError) throw new CompactionLiveProbeError(observationError);
    const preUsage = client.preUsage, postUsage = client.postUsage;
    if (!preUsage || !postUsage) throw new CompactionLiveProbeError("PROBE_USAGE_MISSING");
    const preTotalTokens = preUsage.totalTokens, postTotalTokens = postUsage.totalTokens, contextTokens = postUsage.contextTokens;
    if (preTotalTokens === null || postTotalTokens === null || contextTokens === null) {
      throw new CompactionLiveProbeError("PROBE_USAGE_VALUES_INVALID");
    }
    const index = new SessionReadIndex([{ agentId: PANEL_AGENT_ID }], panel.path), reads = new SessionReadData([{ agentId: PANEL_AGENT_ID,
      sessionsRoot: join(panel.path, "unused-source") }], panel.path, index, budget);
    const conversation = await reads.conversation(RECORD_ID) as { revision?: string; status?: { contextUsage?: OpenClawContextUsage | null } } | null;
    const reloaded = await loadPanelSession(panel.path, PANEL_AGENT_ID, RECORD_ID), afterTokens = budget.estimate(reloaded.document, "").estimatedTokens;
    const usage = conversation?.status?.contextUsage, tail = reloaded.document.entries.at(-1), branchTip = currentTranscriptBranch(reloaded.document).entries.at(-1);
    const prefixPreserved = isDeepStrictEqual(reloaded.document.entries.slice(0, -1), initial.document.entries);
    const exactCompaction = reloaded.document.entries.filter(entry => entry.type === "compaction").length === 1 && tail?.type === "compaction" &&
      typeof tail.id === "string" && branchTip?.id === tail.id;
    if (result.revision === initialRevision || conversation?.revision !== result.revision || afterTokens >= beforeTokens ||
      !prefixPreserved || !exactCompaction || !usage ||
      usage.totalTokens !== postUsage.totalTokens || usage.contextTokens !== postUsage.contextTokens || !usage.totalTokensFresh) {
      throw new CompactionLiveProbeError("PROBE_RELOAD_INVALID");
    }
    report = Object.freeze({ schemaVersion: 1, probe: "compaction", status: "passed", version: request.expectedVersion, scenario: SCENARIO,
      preflight: Object.freeze({ explicitTarget: true, doubleGate: true, zeroBindings: true, sessionsRootIsolated: true, effectiveToolsExact: true }),
      observation: Object.freeze({ createCalls: 1, compactCalls: 1, sendCalls: 0, sameSessionUsage: true, prefixPreserved: true,
        effectiveReduction: true, tokensBefore: preTotalTokens, postTotalTokens,
        contextTokens }),
      reload: Object.freeze({ revisionBefore: initialRevision, revisionAfter: result.revision,
        revisionChanged: true, usageAtCurrentTip: true, matchesPost: true }),
      cleanup: Object.freeze({ confirmed: true, completed: true, residualCount: 0 }) });
  } catch (error) { primary = error; }
  finally {
    try {
      await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
      if (!isDeepStrictEqual(await snapshotRuntime(), beforeRuntime)) throw new CompactionLiveProbeError("PROBE_RUNTIME_RESIDUALS");
      await inspectEmptyWorkspace(request.workspaceRoot, workspaceIdentity);
    } catch { cleanupCode = "PROBE_RUNTIME_CLEANUP_FAILED"; }
    if (panel) {
      try { await panel.cleanup(); }
      catch { cleanupCode ??= "PROBE_PANEL_CLEANUP_FAILED"; }
    }
  }
  if (primary) throw new CompactionLiveProbeError(errorCode(primary), cleanupCode);
  if (cleanupCode || !report) throw new CompactionLiveProbeError("PROBE_CLEANUP_FAILED", cleanupCode);
  return report;
}
