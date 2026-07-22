import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePanelConfig, validateAndInitializeConfig } from "../src/server/config.js";

const auth = { PANEL_USERNAME: "owl", PANEL_PASSWORD_HASH: "scrypt:x:y", PANEL_SESSION_SECRET: "01234567890123456789012345678901" };
const moduleUrl = new URL("../src/server/main.js", import.meta.url).href;

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "panel-config-")), publicDir = join(root, "public"), data = join(root, "data"); await mkdir(publicDir);
  return { root, publicDir, data };
}

test("拒绝 runtime 根与 read 根相同", async () => {
  const x = await layout(), same = join(x.root, "agents", "panel-runtime-safe", "sessions"); await mkdir(same, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: same } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: same } }) }, moduleUrl);
  await assert.rejects(validateAndInitializeConfig(config), /重叠/);
});

test("拒绝 runtime 根与 read 根父子重叠", async () => {
  const x = await layout(), parent = join(x.root, "agents"), runtime = join(parent, "panel-runtime-safe", "sessions"); await mkdir(runtime, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: parent } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime } }) }, moduleUrl);
  await assert.rejects(validateAndInitializeConfig(config), /重叠/);
});

test("初始化独立 dataRoot 为 0700", async () => {
  const x = await layout(), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"); await mkdir(read); await mkdir(runtime, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime } }) }, moduleUrl);
  await validateAndInitializeConfig(config);
  const { mode } = await import("node:fs/promises").then(fs => fs.lstat(x.data)); assert.equal(mode & 0o777, 0o700);
});

test("模型产出 workspace 必须来自服务端配置且与面板数据隔离", async () => {
  const x = await layout(), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"), workspace = join(x.root, "workspace");
  await mkdir(read); await mkdir(runtime, { recursive: true }); await mkdir(workspace);
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime, workspaceRoot: workspace } }) }, moduleUrl);
  await validateAndInitializeConfig(config); assert.equal(config.runtimes.get("source")?.workspaceRoot, workspace);
  const overlapping = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: join(workspace, "panel-data"),
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime, workspaceRoot: workspace } }) }, moduleUrl);
  await assert.rejects(validateAndInitializeConfig(overlapping), /workspace 重叠/);
});

test("运行 timeout 使用长程默认值并校验独立 grace", async () => {
  const defaults = parsePanelConfig(auth, moduleUrl);
  assert.equal(defaults.gatewayRunTimeoutMs, 1_800_000); assert.equal(defaults.runWatcherGraceMs, 30_000);
  const configured = parsePanelConfig({ ...auth, PANEL_GATEWAY_RUN_TIMEOUT_MS: "3600000", PANEL_RUN_WATCHER_GRACE_MS: "45000" }, moduleUrl);
  assert.equal(configured.gatewayRunTimeoutMs, 3_600_000); assert.equal(configured.runWatcherGraceMs, 45_000);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_GATEWAY_RUN_TIMEOUT_MS: "999" }, moduleUrl), /PANEL_GATEWAY_RUN_TIMEOUT_MS/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_RUN_WATCHER_GRACE_MS: "600001" }, moduleUrl), /PANEL_RUN_WATCHER_GRACE_MS/);
});

test("记忆整理 runtime 必须独立且对应已配置 workspace", async () => {
  const x = await layout(), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"), memory = join(x.root, "agents", "panel-memory-safe", "sessions"), workspace = join(x.root, "workspace");
  await mkdir(read); await mkdir(runtime, { recursive: true }); await mkdir(memory, { recursive: true }); await mkdir(workspace);
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime, workspaceRoot: workspace } }),
    PANEL_MEMORY_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-memory-safe", sessionsRoot: memory } }) }, moduleUrl);
  await validateAndInitializeConfig(config); assert.equal(config.memoryRuntimes.get("source")?.runtimeAgentId, "panel-memory-safe");
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_MEMORY_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "unsafe", sessionsRoot: memory } }) }, moduleUrl), /PANEL_MEMORY_RUNTIMES/);
});
