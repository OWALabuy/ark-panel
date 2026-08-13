import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { CreatedSession } from "./adapter.js";

export interface LiveProbeRootIdentity { dev: bigint; ino: bigint }
export interface LiveProbeConfigIdentity { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; digest: string }

export class LiveProbePreflightError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LiveProbePreflightError"; }
}

type Failure = (code: string) => Error;
const defaultFailure: Failure = code => new LiveProbePreflightError(code);

async function safeJsonFile(path: string, fail: Failure): Promise<{ value: unknown; identity: LiveProbeConfigIdentity }> {
  if (await realpath(path) !== resolve(path)) throw fail("PROBE_CONFIG_UNSAFE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true }); if (!stat.isFile()) throw fail("PROBE_CONFIG_UNSAFE");
    try {
      const contents = await handle.readFile("utf8");
      return { value: JSON.parse(contents) as unknown, identity: { dev: stat.dev, ino: stat.ino, size: stat.size,
        mtimeNs: stat.mtimeNs, digest: createHash("sha256").update(contents).digest("hex") } };
    } catch (error) {
      if (error instanceof LiveProbePreflightError) throw error;
      throw fail("PROBE_CONFIG_INVALID");
    }
  } finally { await handle.close(); }
}

export async function inspectLiveProbeConfig(configPath: string, agentId: string,
  expected?: LiveProbeConfigIdentity, fail: Failure = defaultFailure, workspaceRoot?: string): Promise<LiveProbeConfigIdentity> {
  if (agentId !== "paneltest" && !/^panel-probe-[a-z0-9-]{1,48}$/u.test(agentId)) throw fail("PROBE_AGENT_INVALID");
  const { value: config, identity } = await safeJsonFile(configPath, fail);
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.size !== expected.size ||
    identity.mtimeNs !== expected.mtimeNs || identity.digest !== expected.digest)) throw fail("PROBE_CONFIG_CHANGED");
  if (!config || typeof config !== "object" || Array.isArray(config)) throw fail("PROBE_CONFIG_INVALID");
  const gateway = (config as { gateway?: unknown }).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway) ||
    ((gateway as { mode?: unknown }).mode !== undefined && (gateway as { mode?: unknown }).mode !== "local") ||
    Object.prototype.hasOwnProperty.call(gateway, "remote")) throw fail("PROBE_GATEWAY_NOT_LOCAL");
  const bindings = (config as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings) || bindings.some(binding => !binding || typeof binding !== "object" || Array.isArray(binding) ||
    typeof (binding as { agentId?: unknown }).agentId !== "string")) throw fail("PROBE_BINDINGS_INVALID");
  if (bindings.length > 0) throw fail("PROBE_BINDINGS_PRESENT");
  if (workspaceRoot !== undefined) {
    const agents = (config as { agents?: unknown }).agents;
    const list = agents && typeof agents === "object" && !Array.isArray(agents) ? (agents as { list?: unknown }).list : undefined;
    if (!Array.isArray(list)) throw fail("PROBE_AGENT_CONFIG_INVALID");
    const matches = list.filter(value => value && typeof value === "object" && !Array.isArray(value) &&
      (value as { id?: unknown }).id === agentId);
    if (matches.length !== 1 || typeof (matches[0] as { workspace?: unknown } | undefined)?.workspace !== "string" ||
      resolve((matches[0] as { workspace: string }).workspace) !== resolve(workspaceRoot)) throw fail("PROBE_AGENT_WORKSPACE_MISMATCH");
  }
  return identity;
}

export async function inspectLiveProbeRoot(root: string, agentId: string, expected?: LiveProbeRootIdentity,
  fail: Failure = defaultFailure): Promise<LiveProbeRootIdentity> {
  const normalized = resolve(root), suffix = `${sep}agents${sep}${agentId}${sep}sessions`;
  if (!isAbsolute(root) || !normalized.endsWith(suffix) || await realpath(root) !== normalized) throw fail("PROBE_ROOT_UNSAFE");
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
      (stat.mode & 0o077n) !== 0n) throw fail("PROBE_ROOT_UNSAFE");
    const identity = { dev: stat.dev, ino: stat.ino };
    if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) throw fail("PROBE_ROOT_CHANGED");
    return identity;
  } finally { await handle.close(); }
}

export async function inspectLiveProbeCreatedSession(created: CreatedSession, sessionsRoot: string, agentId: string,
  root: LiveProbeRootIdentity, fail: Failure = defaultFailure): Promise<void> {
  await inspectLiveProbeRoot(sessionsRoot, agentId, root, fail);
  const handle = await open(created.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isFile()) throw fail("PROBE_CREATED_SESSION_INVALID"); }
  finally { await handle.close(); }
}

export function liveProbeCreatedIdentityValid(created: CreatedSession, sessionsRoot: string, agentId: string): boolean {
  const parts = created.sessionKey.split(":"), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return uuid.test(created.sessionId) && parts.length === 3 && parts[0] === "agent" && parts[1] === agentId && Boolean(parts[2]) &&
    resolve(created.transcriptPath) === resolve(sessionsRoot, `${created.sessionId}.jsonl`);
}
