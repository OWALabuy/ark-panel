import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { SUPPORTED_OPENCLAW_VERSION, type CreatedSession, type EffectiveToolsInventory, type GatewayClient } from "./adapter.js";
import type { GatewayStreamEvent } from "./stream-client.js";
import { createToolSchemaCollector, type ToolSchemaCollector, type ToolSchemaReport } from "./stream-schema-observation.js";

const SCENARIO = "exec-printf-v1";
const CLEANUP_CONFIRMATION = "delete-created-session-v1";
const MAX_TOOL_CALLS = 1;
const DEADLINE_MS = 150_000;
const PROMPT = "这是 ark-panel 的隔离协议验收。必须且只能调用一次 exec 工具执行 `printf ark-tool-result-schema-probe`，然后用一句中文确认完成。不要调用其它工具。";
const CANARY = "ark-tool-result-schema-probe";
const COMMAND = `printf ${CANARY}`;

export interface ToolResultSchemaProbeRequest {
  agentId: string;
  sessionsRoot: string;
  configPath: string;
  expectedVersion: string;
  scenario: string;
  maxToolCalls: number;
  cleanupConfirmation: string;
  confirmation: string;
}

export interface ProbeRootIdentity { dev: bigint; ino: bigint }
export interface ProbeConfigIdentity { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; digest: string }

interface ProbeClient extends Pick<GatewayClient, "version" | "createSession" | "abort" | "deleteSession"> {
  effectiveTools(agentId: string, sessionKey: string): Promise<EffectiveToolsInventory>;
  send(sessionKey: string, message: string, runId: string): Promise<{ runId: string }>;
  waitForCompletion(sessionId: string, runId: string): Promise<void>;
  abort(sessionKey: string, runId: string, sessionId: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
}

interface ProbeObserver {
  observe(sessionKey: string, listener: (event: GatewayStreamEvent) => void): Promise<() => void>;
  stop(): void;
}

interface ProbeConnection { client: ProbeClient; observer: ProbeObserver }

export interface ToolResultSchemaProbeDependencies {
  env: NodeJS.ProcessEnv;
  loadAuth(configPath: string): Promise<object | undefined>;
  createConnection(auth: object, collector?: ToolSchemaCollector): ProbeConnection;
  cleanup(client: ProbeClient, created: CreatedSession, request: ToolResultSchemaProbeRequest): Promise<number>;
  randomUUID(): string;
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  inspectConfig?(configPath: string, agentId: string, expected?: ProbeConfigIdentity): Promise<ProbeConfigIdentity>;
  inspectRoot?(root: string, agentId: string, expected?: ProbeRootIdentity): Promise<ProbeRootIdentity>;
  inspectCreated?(created: CreatedSession, request: ToolResultSchemaProbeRequest, root: ProbeRootIdentity): Promise<void>;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export interface ToolResultSchemaProbeReport {
  schemaVersion: 1;
  probe: "tool-result-schema";
  status: "passed";
  version: string;
  scenario: "exec-printf-v1";
  preflight: Readonly<{ explicitTarget: true; doubleGate: true; zeroBindings: true; sessionsRootIsolated: true;
    effectiveToolsExact: true; maxToolCalls: 1 }>;
  observation: ToolSchemaReport;
  completion: Readonly<{ terminalObserved: true; authoritativeRunCompleted: true }>;
  cleanup: Readonly<{ confirmed: true; completed: true; removedArtifactCount: number }>;
}

export class ToolResultSchemaProbeError extends Error {
  constructor(readonly code: string, readonly cleanupCode: string | null = null) {
    super(code); this.name = "ToolResultSchemaProbeError";
  }
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name); if (!value) throw new ToolResultSchemaProbeError("PROBE_ARGUMENTS_INVALID"); return value;
}

export function parseToolResultSchemaProbeArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ToolResultSchemaProbeRequest {
  const allowed = new Set(["--agent", "--expected-version", "--scenario", "--max-tool-calls", "--cleanup", "--confirm"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new ToolResultSchemaProbeError("PROBE_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) throw new ToolResultSchemaProbeError("PROBE_ARGUMENTS_INVALID");
  const rawMax = required(values, "--max-tool-calls");
  const sessionsRoot = env.PANEL_TOOL_RESULT_SCHEMA_SESSIONS_ROOT, configPath = env.PANEL_TOOL_RESULT_SCHEMA_CONFIG_PATH;
  if (!sessionsRoot || !configPath) throw new ToolResultSchemaProbeError("PROBE_ARGUMENTS_INVALID");
  const request: ToolResultSchemaProbeRequest = { agentId: required(values, "--agent"), sessionsRoot,
    configPath, expectedVersion: required(values, "--expected-version"), scenario: required(values, "--scenario"),
    maxToolCalls: /^\d+$/u.test(rawMax) ? Number(rawMax) : Number.NaN, cleanupConfirmation: required(values, "--cleanup"),
    confirmation: required(values, "--confirm") };
  validateRequest(request); return request;
}

function validateRequest(request: ToolResultSchemaProbeRequest): void {
  const dedicatedAgent = request.agentId === "paneltest" || /^panel-probe-[a-z0-9-]{1,48}$/u.test(request.agentId);
  if (!dedicatedAgent || !isAbsolute(request.sessionsRoot) || !isAbsolute(request.configPath) || request.expectedVersion !== SUPPORTED_OPENCLAW_VERSION ||
    request.scenario !== SCENARIO || request.maxToolCalls !== MAX_TOOL_CALLS || request.cleanupConfirmation !== CLEANUP_CONFIRMATION ||
    request.confirmation !== `tool-result-schema:${request.agentId}:${SUPPORTED_OPENCLAW_VERSION}`) {
    throw new ToolResultSchemaProbeError("PROBE_ARGUMENTS_INVALID");
  }
}

async function safeJsonFile(path: string): Promise<{ value: unknown; identity: ProbeConfigIdentity }> {
  if (await realpath(path) !== resolve(path)) throw new ToolResultSchemaProbeError("PROBE_CONFIG_UNSAFE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true }); if (!stat.isFile()) throw new ToolResultSchemaProbeError("PROBE_CONFIG_UNSAFE");
    try { const contents = await handle.readFile("utf8"); return { value: JSON.parse(contents) as unknown,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs,
        digest: createHash("sha256").update(contents).digest("hex") } }; }
    catch { throw new ToolResultSchemaProbeError("PROBE_CONFIG_INVALID"); }
  } finally { await handle.close(); }
}

export async function inspectToolResultProbeConfig(configPath: string, _agentId: string,
  expected?: ProbeConfigIdentity): Promise<ProbeConfigIdentity> {
  const { value: config, identity } = await safeJsonFile(configPath);
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.size !== expected.size ||
    identity.mtimeNs !== expected.mtimeNs || identity.digest !== expected.digest)) throw new ToolResultSchemaProbeError("PROBE_CONFIG_CHANGED");
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new ToolResultSchemaProbeError("PROBE_CONFIG_INVALID");
  const gateway = (config as { gateway?: unknown }).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway) ||
    ((gateway as { mode?: unknown }).mode !== undefined && (gateway as { mode?: unknown }).mode !== "local") ||
    Object.prototype.hasOwnProperty.call(gateway, "remote")) throw new ToolResultSchemaProbeError("PROBE_GATEWAY_NOT_LOCAL");
  const bindings = (config as { bindings?: unknown }).bindings;
  if (bindings === undefined) return identity;
  if (!Array.isArray(bindings) || bindings.some(binding => !binding || typeof binding !== "object" || Array.isArray(binding) ||
    typeof (binding as { agentId?: unknown }).agentId !== "string")) throw new ToolResultSchemaProbeError("PROBE_BINDINGS_INVALID");
  if (bindings.length > 0) throw new ToolResultSchemaProbeError("PROBE_BINDINGS_PRESENT");
  return identity;
}

export async function inspectToolResultProbeRoot(root: string, agentId: string, expected?: ProbeRootIdentity): Promise<ProbeRootIdentity> {
  const normalized = resolve(root), suffix = `${sep}agents${sep}${agentId}${sep}sessions`;
  if (!isAbsolute(root) || !normalized.endsWith(suffix) || await realpath(root) !== normalized) throw new ToolResultSchemaProbeError("PROBE_ROOT_UNSAFE");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new ToolResultSchemaProbeError("PROBE_ROOT_UNSAFE");
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) throw new ToolResultSchemaProbeError("PROBE_ROOT_CHANGED");
    return identity;
  } finally { await handle.close(); }
}

export async function inspectToolResultProbeCreatedSession(created: CreatedSession, request: ToolResultSchemaProbeRequest,
  root: ProbeRootIdentity): Promise<void> {
  await inspectToolResultProbeRoot(request.sessionsRoot, request.agentId, root);
  const handle = await open(created.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw new ToolResultSchemaProbeError("PROBE_CREATED_SESSION_INVALID"); }
  finally { await handle.close(); }
}

function createdIdentityValid(created: CreatedSession, request: ToolResultSchemaProbeRequest): boolean {
  const parts = created.sessionKey.split(":");
  return uuid(created.sessionId) && parts.length === 3 && parts[0] === "agent" && parts[1] === request.agentId && Boolean(parts[2]) &&
    resolve(created.transcriptPath) === resolve(request.sessionsRoot, `${created.sessionId}.jsonl`);
}

function failureCode(error: unknown): string {
  return error instanceof ToolResultSchemaProbeError ? error.code : "PROBE_EXECUTION_FAILED";
}

function isResultField(field: ToolSchemaReport["events"][number]["field"]): boolean {
  return field === "result" || field === "terminalData";
}

export async function runToolResultSchemaProbe(request: ToolResultSchemaProbeRequest,
  dependencies: ToolResultSchemaProbeDependencies): Promise<ToolResultSchemaProbeReport> {
  validateRequest(request);
  if (dependencies.env.PANEL_ALLOW_TOOL_RESULT_SCHEMA_PROBE !== "1") throw new ToolResultSchemaProbeError("PROBE_GATE_REQUIRED");
  const inspectConfig = dependencies.inspectConfig ?? inspectToolResultProbeConfig;
  const inspectRoot = dependencies.inspectRoot ?? inspectToolResultProbeRoot;
  const inspectCreated = dependencies.inspectCreated ?? inspectToolResultProbeCreatedSession;
  if (dependencies.env.PANEL_OPENCLAW_GATEWAY_URL !== undefined || dependencies.env.OPENCLAW_GATEWAY_PORT !== undefined) {
    throw new ToolResultSchemaProbeError("PROBE_ENDPOINT_OVERRIDE_FORBIDDEN");
  }
  const configIdentity = await inspectConfig(request.configPath, request.agentId);
  const rootIdentity = await inspectRoot(request.sessionsRoot, request.agentId);
  const auth = await dependencies.loadAuth(request.configPath); if (!auth) throw new ToolResultSchemaProbeError("PROBE_AUTH_UNAVAILABLE");
  await inspectConfig(request.configPath, request.agentId, configIdentity);
  const control = dependencies.createConnection(auth); let schema: ProbeConnection | undefined, created: CreatedSession | undefined;
  let unsubscribe: (() => void) | undefined, collector: ToolSchemaCollector | undefined, runId: string | undefined, acceptedRunId: string | undefined;
  let sendAttempted = false, authoritativeComplete = false, cleanupAttempted = false, cleanupCompleted = false;
  let primaryError: unknown, cleanupCode: string | null = null, removedArtifactCount = 0;
  try {
    const version = await control.client.version(); if (version !== request.expectedVersion) throw new ToolResultSchemaProbeError("PROBE_VERSION_MISMATCH");
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
    const candidate = await control.client.createSession(request.agentId);
    if (!createdIdentityValid(candidate, request)) throw new ToolResultSchemaProbeError("PROBE_CREATED_SESSION_INVALID");
    created = candidate;
    await inspectCreated(created, request, rootIdentity);
    runId = dependencies.randomUUID(); collector = createToolSchemaCollector(created.sessionKey, runId, CANARY);
    schema = dependencies.createConnection(auth, collector);
    const inventory = await schema.client.effectiveTools(request.agentId, created.sessionKey);
    if (inventory.agentId !== request.agentId || inventory.toolIds.length !== 1 || inventory.toolIds[0] !== "exec") {
      throw new ToolResultSchemaProbeError("PROBE_EFFECTIVE_TOOLS_MISMATCH");
    }
    let failTerminal!: (error: Error) => void;
    const terminalFailure = new Promise<never>((_resolve, rejectTerminal) => { failTerminal = rejectTerminal; });
    let terminalSettled = false, streamConnected = false, expectedStart = false;
    const timer = dependencies.setTimer(() => { if (!terminalSettled) { terminalSettled = true; failTerminal(new ToolResultSchemaProbeError("PROBE_TERMINAL_TIMEOUT")); } }, DEADLINE_MS);
    try {
      unsubscribe = await schema.observer.observe(created.sessionKey, event => {
        if (event.type === "connection") {
          if (event.state === "connected") streamConnected = true;
          else if (streamConnected && !terminalSettled) { terminalSettled = true; failTerminal(new ToolResultSchemaProbeError("PROBE_STREAM_DISCONNECTED")); }
          return;
        }
        if (event.type !== "tool" || event.runId !== runId) return;
        if (event.phase === "started") {
          const args = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args as Record<string, unknown> : undefined;
          if (event.name !== "exec" || args?.command !== COMMAND) {
            if (!terminalSettled) { terminalSettled = true; failTerminal(new ToolResultSchemaProbeError("PROBE_TOOL_INVOCATION_MISMATCH")); }
            return;
          }
          expectedStart = true;
        }
        const report = collector?.report();
        if (!report || report.lifecycle.startedCalls > MAX_TOOL_CALLS) {
          if (!terminalSettled) { terminalSettled = true; failTerminal(new ToolResultSchemaProbeError("PROBE_TOOL_LIMIT_EXCEEDED")); }
          return;
        }
      });
      await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
      sendAttempted = true; const accepted = await schema.client.send(created.sessionKey, PROMPT, runId);
      if (!uuid(accepted.runId)) throw new ToolResultSchemaProbeError("PROBE_RUN_ID_INVALID"); acceptedRunId = accepted.runId;
      if (acceptedRunId !== runId) throw new ToolResultSchemaProbeError("PROBE_RUN_ID_MISMATCH");
      await Promise.race([Promise.all([control.client.waitForCompletion(created.sessionId, runId), collector.terminal]), terminalFailure]);
      terminalSettled = true; authoritativeComplete = true;
    } finally { dependencies.clearTimer(timer); }
    unsubscribe?.(); unsubscribe = undefined; schema.observer.stop(); schema = undefined;
    const observation = collector.finish(); collector = undefined;
    if (observation.phaseCounts.start !== 1 || observation.lifecycle.startedCalls !== 1 || observation.droppedEventCount !== 0 ||
      !expectedStart || observation.phaseCounts.terminal !== 1 || !observation.sequence.strictlyIncreasing ||
      observation.sequence.equalCount !== 0 || observation.sequence.regressionCount !== 0 || observation.lifecycle.attributedTerminals !== 1 ||
      observation.lifecycle.unattributedEvents !== 0 ||
      !observation.events.some(event => event.phase === "terminal" && isResultField(event.field) && event.sameCallAsStart) ||
      !observation.events.some(event => event.phase === "terminal" && event.isError === false && event.canaryPresent === true) ||
      observation.events.some(event => event.shape?.truncated)) throw new ToolResultSchemaProbeError("PROBE_OBSERVATION_INCOMPLETE");
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
    cleanupAttempted = true;
    try { removedArtifactCount = await dependencies.cleanup(control.client, created, request); }
    catch { cleanupCode = "PROBE_CLEANUP_FAILED"; throw new ToolResultSchemaProbeError("PROBE_CLEANUP_FAILED", cleanupCode); }
    cleanupCompleted = true; created = undefined;
    await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity);
    return Object.freeze({ schemaVersion: 1, probe: "tool-result-schema", status: "passed", version: request.expectedVersion,
      scenario: SCENARIO, preflight: Object.freeze({ explicitTarget: true, doubleGate: true, zeroBindings: true, sessionsRootIsolated: true,
        effectiveToolsExact: true, maxToolCalls: 1 }), observation,
      completion: Object.freeze({ terminalObserved: true, authoritativeRunCompleted: true }),
      cleanup: Object.freeze({ confirmed: true, completed: true, removedArtifactCount }) });
  } catch (error) { primaryError = error; }
  finally {
    unsubscribe?.(); schema?.observer.stop();
    try { collector?.finish(); } catch { /* the primary result remains authoritative */ }
    if (created && !cleanupAttempted) {
      let safeToClean = !sendAttempted || authoritativeComplete;
      if (sendAttempted && !authoritativeComplete && acceptedRunId) {
        try { await control.client.abort(created.sessionKey, acceptedRunId, created.sessionId); safeToClean = true; }
        catch { safeToClean = false; }
      }
      if (safeToClean) {
        try { await inspectRoot(request.sessionsRoot, request.agentId, rootIdentity); cleanupAttempted = true;
          await dependencies.cleanup(control.client, created, request); }
        catch { cleanupCode = "PROBE_CLEANUP_FAILED"; }
      } else cleanupCode = "PROBE_ABORT_UNCONFIRMED";
    }
    control.observer.stop();
  }
  if (cleanupCompleted) throw new ToolResultSchemaProbeError(failureCode(primaryError), "PROBE_POST_CLEANUP_VERIFICATION_FAILED");
  throw new ToolResultSchemaProbeError(failureCode(primaryError), cleanupCode);
}
