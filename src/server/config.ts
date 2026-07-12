import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import type { ReadAgentConfig } from "./read-data.js";

export interface RuntimeConfig { runtimeAgentId: string; sessionsRoot: string }
export interface PanelConfig {
  username: string; passwordHash: string; sessionSecret: string; secureCookie: boolean;
  host: "127.0.0.1"; port: number; publicDir: string; dataRoot?: string; mock: boolean;
  readAgents: ReadAgentConfig[]; runtimes: Map<string, RuntimeConfig>;
  contextHistoryBudgetTokens: number;
}

function jsonObject(value: string | undefined, name: string): Record<string, Record<string, unknown>> {
  if (!value) return {};
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error(`${name} 不是有效 JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} 格式错误`);
  return parsed as Record<string, Record<string, unknown>>;
}

export function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(resolve(left), resolve(right)), fromRight = relative(resolve(right), resolve(left));
  return fromLeft === "" || (!fromLeft.startsWith(`..${sep}`) && fromLeft !== "..") || (!fromRight.startsWith(`..${sep}`) && fromRight !== "..");
}

export function parsePanelConfig(env: NodeJS.ProcessEnv, moduleUrl: string): PanelConfig {
  for (const name of ["PANEL_USERNAME", "PANEL_PASSWORD_HASH", "PANEL_SESSION_SECRET"] as const) if (!env[name]) throw new Error(`缺少环境变量 ${name}`);
  if (env.PANEL_SESSION_SECRET!.length < 32) throw new Error("PANEL_SESSION_SECRET 至少需要 32 个字符");
  const port = Number(env.PANEL_PORT ?? "8790"); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PANEL_PORT 无效");
  const contextHistoryBudgetTokens = Number(env.PANEL_CONTEXT_HISTORY_BUDGET_TOKENS ?? "100000");
  if (!Number.isInteger(contextHistoryBudgetTokens) || contextHistoryBudgetTokens < 1024) throw new Error("PANEL_CONTEXT_HISTORY_BUDGET_TOKENS 必须是至少 1024 的整数");
  const read = jsonObject(env.PANEL_READ_AGENTS, "PANEL_READ_AGENTS"), runtime = jsonObject(env.PANEL_AGENT_RUNTIMES, "PANEL_AGENT_RUNTIMES");
  const readAgents = Object.entries(read).map(([agentId, value]) => {
    if (typeof value.sessionsRoot !== "string" || (value.label !== undefined && typeof value.label !== "string")) throw new Error("PANEL_READ_AGENTS 格式错误");
    return { agentId, sessionsRoot: resolve(value.sessionsRoot), ...(typeof value.label === "string" ? { label: value.label } : {}) };
  });
  const runtimes = new Map<string, RuntimeConfig>(), runtimeIds = new Set<string>();
  for (const [agentId, value] of Object.entries(runtime)) {
    if (typeof value.runtimeAgentId !== "string" || typeof value.sessionsRoot !== "string") throw new Error("PANEL_AGENT_RUNTIMES 格式错误");
    const isolated = value.runtimeAgentId === "paneltest" || value.runtimeAgentId.startsWith("panel-runtime-") || value.runtimeAgentId.endsWith("-runtime");
    if (!isolated) throw new Error("runtime agent 名称不符合隔离约定");
    if (value.runtimeAgentId === agentId && agentId !== "paneltest") throw new Error("真实 agent 不能同时作为推理 runtime");
    if (runtimeIds.has(value.runtimeAgentId)) throw new Error("runtimeAgentId 重复"); runtimeIds.add(value.runtimeAgentId);
    runtimes.set(agentId, { runtimeAgentId: value.runtimeAgentId, sessionsRoot: resolve(value.sessionsRoot) });
  }
  if ((readAgents.length || runtimes.size) && !env.PANEL_DATA_DIR) throw new Error("配置会话数据源时必须设置 PANEL_DATA_DIR");
  return { username: env.PANEL_USERNAME!, passwordHash: env.PANEL_PASSWORD_HASH!, sessionSecret: env.PANEL_SESSION_SECRET!, secureCookie: env.PANEL_SECURE_COOKIE === "1",
    host: "127.0.0.1", port, publicDir: env.PANEL_PUBLIC_DIR ? resolve(env.PANEL_PUBLIC_DIR) : fileURLToPath(new URL("../../../src/frontend/", moduleUrl)),
    ...(env.PANEL_DATA_DIR ? { dataRoot: resolve(env.PANEL_DATA_DIR) } : {}), mock: env.PANEL_MOCK_DATA === "1", readAgents, runtimes, contextHistoryBudgetTokens };
}

async function safeDirectory(path: string, label: string): Promise<string> {
  const configured = await lstat(path); if (!configured.isDirectory() || configured.isSymbolicLink()) throw new Error(`${label}根目录不安全`);
  return await realpath(path);
}

export async function validateAndInitializeConfig(config: PanelConfig): Promise<void> {
  const readRoots: string[] = [];
  for (const agent of config.readAgents) readRoots.push(await safeDirectory(agent.sessionsRoot, "read sessions "));
  const runtimeRoots: string[] = [];
  for (const value of config.runtimes.values()) {
    const root = await safeDirectory(value.sessionsRoot, "runtime sessions ");
    if (!root.endsWith(`${sep}agents${sep}${value.runtimeAgentId}${sep}sessions`)) throw new Error("runtime sessions 根目录与 runtime agent 不匹配");
    if ([...readRoots, ...runtimeRoots].some(other => pathsOverlap(other, root))) throw new Error("runtime sessions 根目录与其它会话根重叠");
    runtimeRoots.push(root);
  }
  if (config.dataRoot) {
    await mkdir(config.dataRoot, { recursive: true, mode: 0o700 }); await chmod(config.dataRoot, 0o700);
    const dataRoot = await safeDirectory(config.dataRoot, "panel data ");
    if ([...readRoots, ...runtimeRoots].some(other => pathsOverlap(other, dataRoot))) throw new Error("PANEL_DATA_DIR 与会话根目录重叠");
  }
  await safeDirectory(config.publicDir, "public ");
}
