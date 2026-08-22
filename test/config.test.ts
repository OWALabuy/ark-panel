import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parsePanelConfig, validateAndInitializeConfig } from "../src/server/config.js";
import { tempFixture } from "./test-helpers.js";

const auth = { PANEL_USERNAME: "owl", PANEL_PASSWORD_HASH: "scrypt:x:y", PANEL_SESSION_SECRET: "01234567890123456789012345678901" };
const moduleUrl = new URL("../src/server/main.js", import.meta.url).href;

async function layout(t: TestContext) {
  const root = await tempFixture(t, "panel-config-"), publicDir = join(root, "public"), data = join(root, "data"); await mkdir(publicDir);
  return { root, publicDir, data };
}

test("拒绝 runtime 根与 read 根相同", async t => {
  const x = await layout(t), same = join(x.root, "agents", "panel-runtime-safe", "sessions"); await mkdir(same, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: same } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: same } }) }, moduleUrl);
  await assert.rejects(validateAndInitializeConfig(config), /重叠/);
});

test("拒绝 runtime 根与 read 根父子重叠", async t => {
  const x = await layout(t), parent = join(x.root, "agents"), runtime = join(parent, "panel-runtime-safe", "sessions"); await mkdir(runtime, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: parent } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime } }) }, moduleUrl);
  await assert.rejects(validateAndInitializeConfig(config), /重叠/);
});

test("初始化独立 dataRoot 为 0700", async t => {
  const x = await layout(t), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"); await mkdir(read); await mkdir(runtime, { recursive: true });
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime } }) }, moduleUrl);
  await validateAndInitializeConfig(config);
  const { mode } = await import("node:fs/promises").then(fs => fs.lstat(x.data)); assert.equal(mode & 0o777, 0o700);
});

test("模型产出 workspace 必须来自服务端配置且与面板数据隔离", async t => {
  const x = await layout(t), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"), workspace = join(x.root, "workspace");
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

test("终态 run 保留期默认 30 天并严格限制为 0–36500 天", () => {
  const defaults = parsePanelConfig(auth, moduleUrl);
  assert.equal(defaults.runRetentionDays, 30);
  assert.equal(defaults.runRetentionBackupConfirmed, false);
  assert.equal(parsePanelConfig({ ...auth, PANEL_RUN_RETENTION_DAYS: "0" }, moduleUrl).runRetentionDays, 0);
  assert.equal(parsePanelConfig({ ...auth, PANEL_RUN_RETENTION_DAYS: "36500" }, moduleUrl).runRetentionDays, 36_500);
  for (const value of ["", "-1", "36501", "1.5", "1e2", "+1", " 30", "30 ", "NaN"]) {
    assert.throws(() => parsePanelConfig({ ...auth, PANEL_RUN_RETENTION_DAYS: value }, moduleUrl), /PANEL_RUN_RETENTION_DAYS/);
  }
  const confirmed = parsePanelConfig({ ...auth,
    PANEL_RUN_RETENTION_MIGRATION_CONFIRM: "verified-offline-pre-gc-backup-v1" }, moduleUrl);
  assert.equal(confirmed.runRetentionBackupConfirmed, true);
  for (const value of ["", "verified-offline-pre-gc-backup", "private-confirmation-canary"]) {
    assert.throws(() => parsePanelConfig({ ...auth, PANEL_RUN_RETENTION_MIGRATION_CONFIRM: value }, moduleUrl), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /PANEL_RUN_RETENTION_MIGRATION_CONFIRM/);
      if (value) assert.equal(error.message.includes(value), false);
      return true;
    });
  }
});

test("默认请求边界只信任规范化的本机 HTTP Host 与 Origin", () => {
  const defaults = parsePanelConfig(auth, moduleUrl);
  assert.equal(defaults.host, "127.0.0.1"); assert.equal(defaults.publicOrigin, undefined);
  assert.deepEqual(defaults.trustedHosts, ["127.0.0.1:8790", "localhost:8790"]);
  assert.deepEqual(defaults.allowedOrigins, ["http://127.0.0.1:8790", "http://localhost:8790"]);

  const defaultPort = parsePanelConfig({ ...auth, PANEL_PORT: "80" }, moduleUrl);
  assert.deepEqual(defaultPort.trustedHosts, ["127.0.0.1", "localhost"]);
  assert.deepEqual(defaultPort.allowedOrigins, ["http://127.0.0.1", "http://localhost"]);
});

test("HTTPS public origin 与额外可信 Host 在启动时规范化", () => {
  const config = parsePanelConfig({ ...auth, PANEL_SECURE_COOKIE: "1", PANEL_PUBLIC_ORIGIN: "HTTPS://Panel.Example.TEST:443",
    PANEL_TRUSTED_HOSTS: JSON.stringify(["proxy.internal.test:8443", "[::1]:8790"]) }, moduleUrl);
  assert.equal(config.publicOrigin, "https://panel.example.test");
  assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1:8790", "http://localhost:8790", "https://panel.example.test"]);
  assert.deepEqual(config.trustedHosts, ["127.0.0.1:8790", "localhost:8790", "panel.example.test", "proxy.internal.test:8443", "[::1]:8790"]);
});

test("public origin 与可信 Host 配置严格拒绝混淆值和重复项", () => {
  const invalidOrigins = [
    "ftp://panel.example.test", "https://*.example.test", "https://user@panel.example.test", "https://panel.example.test/",
    "https://panel.example.test/path", "https://panel.example.test?query", "https://panel.example.test#fragment", "null",
    "https://例子.example", "https://xn--fsqu00a.example", "https://127.1", "https://[0:0:0:0:0:0:0:1]",
    "https://panel.example.test:0443", "https://panel.example.test:0", "https://panel.example.test:65536"
  ];
  for (const value of invalidOrigins) assert.throws(() => parsePanelConfig({ ...auth, PANEL_SECURE_COOKIE: "1", PANEL_PUBLIC_ORIGIN: value }, moduleUrl), /PANEL_PUBLIC_ORIGIN/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_PUBLIC_ORIGIN: "https://panel.example.test" }, moduleUrl), /PANEL_SECURE_COOKIE=1/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_PUBLIC_ORIGIN: "http://127.0.0.1:8790" }, moduleUrl), /重复/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_TRUSTED_HOSTS: "not-json" }, moduleUrl), /PANEL_TRUSTED_HOSTS/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_TRUSTED_HOSTS: JSON.stringify(["*.example.test"]) }, moduleUrl), /PANEL_TRUSTED_HOSTS/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_TRUSTED_HOSTS: JSON.stringify(["Panel.Example.test", "panel.example.test"]) }, moduleUrl), /重复/);
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_SECURE_COOKIE: "1", PANEL_PUBLIC_ORIGIN: "https://panel.example.test",
    PANEL_TRUSTED_HOSTS: JSON.stringify(["panel.example.test"]) }, moduleUrl), /重复/);
});

test("记忆整理 runtime 必须独立且对应已配置 workspace", async t => {
  const x = await layout(t), read = join(x.root, "read"), runtime = join(x.root, "agents", "panel-runtime-safe", "sessions"), memory = join(x.root, "agents", "panel-memory-safe", "sessions"), workspace = join(x.root, "workspace");
  await mkdir(read); await mkdir(runtime, { recursive: true }); await mkdir(memory, { recursive: true }); await mkdir(workspace);
  const config = parsePanelConfig({ ...auth, PANEL_PUBLIC_DIR: x.publicDir, PANEL_DATA_DIR: x.data,
    PANEL_READ_AGENTS: JSON.stringify({ source: { sessionsRoot: read } }),
    PANEL_AGENT_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-runtime-safe", sessionsRoot: runtime, workspaceRoot: workspace } }),
    PANEL_MEMORY_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "panel-memory-safe", sessionsRoot: memory } }) }, moduleUrl);
  await validateAndInitializeConfig(config); assert.equal(config.memoryRuntimes.get("source")?.runtimeAgentId, "panel-memory-safe");
  assert.throws(() => parsePanelConfig({ ...auth, PANEL_MEMORY_RUNTIMES: JSON.stringify({ source: { runtimeAgentId: "unsafe", sessionsRoot: memory } }) }, moduleUrl), /PANEL_MEMORY_RUNTIMES/);
});
