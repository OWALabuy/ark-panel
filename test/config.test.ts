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
