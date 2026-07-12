import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertWithin } from "../storage/atomic.js";
import { assertSupportedVersion, type GatewayClient } from "./adapter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isKnownArtifact(name: string, sessionId: string): boolean {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\.jsonl\\.deleted\\.[A-Za-z0-9:._+-]+|\\.trajectory\\.jsonl|\\.trajectory-path\\.json)$`).test(name);
}

export interface CleanupRequest {
  runtimeAgentId: string; sessionId: string; sessionKey: string; runtimeSessionsRoot: string;
  allowedRuntimeRoots: ReadonlyMap<string, string>;
}

export async function unregisterAndClean(client: GatewayClient, request: CleanupRequest): Promise<string[]> {
  assertSupportedVersion(await client.version());
  if (!UUID.test(request.sessionId)) throw new Error("拒绝未验证的 sessionId");
  const allowed = request.allowedRuntimeRoots.get(request.runtimeAgentId);
  if (!allowed || resolve(allowed) !== resolve(request.runtimeSessionsRoot)) throw new Error("runtime sessions 根目录不在 allowlist");
  const rootStat = await lstat(request.runtimeSessionsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("runtime sessions 根目录不安全");

  await client.deleteSession(request.sessionKey);
  const candidates: Array<{ name: string; path: string }> = [];
  for (const name of await readdir(request.runtimeSessionsRoot)) {
    if (!name.startsWith(request.sessionId)) continue;
    if (!isKnownArtifact(name, request.sessionId)) throw new Error(`发现未知 session artifact，拒绝清理: ${name}`);
    const path = assertWithin(request.runtimeSessionsRoot, join(request.runtimeSessionsRoot, name));
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact 不是普通文件: ${name}`);
    candidates.push({ name, path });
  }
  const removed: string[] = [];
  for (const candidate of candidates) { await rm(candidate.path); removed.push(candidate.name); }
  return removed.sort();
}
