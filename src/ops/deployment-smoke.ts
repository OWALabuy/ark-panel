import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { passwordHash } from "../server/auth.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";

if (process.env.PANEL_ALLOW_DEPLOYMENT_DRY_RUN !== "1") throw new Error("只有显式允许时才能运行部署 dry-run");

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const address = probe.address();
  if (!address || typeof address === "string") throw new Error("无法分配临时端口"); const port = address.port; probe.close(); await once(probe, "close"); return port;
}

const baseRoot = await mkdtemp(join(tmpdir(), "panel-deploy-smoke-"));
const fakeReadRoot = join(baseRoot, "fixture-agent-sessions"), dataRoot = join(baseRoot, "data"), backupsRoot = join(baseRoot, "backups"), restoredRoot = join(baseRoot, "restored");
await mkdir(fakeReadRoot); await mkdir(dataRoot); await mkdir(backupsRoot);
const port = await freePort(), username = "deploy-smoke", password = randomUUID(), sessionSecret = randomUUID();
const commonEnv = {
  ...process.env, PANEL_USERNAME: username, PANEL_PASSWORD_HASH: passwordHash(password, "0011223344556677"), PANEL_SESSION_SECRET: sessionSecret,
  PANEL_PORT: String(port), PANEL_READ_AGENTS: JSON.stringify({ fixture: { label: "Fixture", sessionsRoot: fakeReadRoot } }), PANEL_AGENT_RUNTIMES: "{}"
};
let child: ChildProcess | undefined;

async function start(root: string): Promise<{ base: string; cookie: string; csrf: string }> {
  child = spawn(process.execPath, [join(process.cwd(), "dist", "src", "server", "main.js")], { cwd: homedir(), env: { ...commonEnv, PANEL_DATA_DIR: root }, stdio: ["ignore", "pipe", "pipe"] });
  const errors: Buffer[] = []; child.stderr?.on("data", (value: Buffer) => errors.push(value)); const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`服务启动失败: ${Buffer.concat(errors).toString("utf8")}`);
    try { const health = await fetch(`${base}/api/v1/health`); if (health.ok) break; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 49) throw new Error("health check 超时");
  }
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!login.ok) throw new Error("登录失败"); const payload = await login.json() as { data: { csrfToken: string } };
  return { base, cookie: login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; "), csrf: payload.data.csrfToken };
}

async function stop(): Promise<void> {
  if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null]; child = undefined;
  if (code !== 0 || signal !== null) throw new Error(`服务没有优雅退出: code=${code} signal=${signal}`);
}

async function conversation(client: { base: string; cookie: string }, recordId: string): Promise<Response> {
  return await fetch(`${client.base}/api/v1/sessions/${recordId}`, { headers: { cookie: client.cookie } });
}

try {
  let client = await start(dataRoot);
  const createdResponse = await fetch(`${client.base}/api/v1/sessions`, { method: "POST", headers: { cookie: client.cookie, origin: client.base, "x-csrf-token": client.csrf, "content-type": "application/json" }, body: JSON.stringify({ agentId: "fixture", title: "deployment persistence marker" }) });
  if (createdResponse.status !== 201) throw new Error("创建持久会话失败"); const created = await createdResponse.json() as { data: { recordId: string } }; const recordId = created.data.recordId;
  if (!(await conversation(client, recordId)).ok) throw new Error("首次读取失败"); await stop();

  client = await start(dataRoot); if (!(await conversation(client, recordId)).ok) throw new Error("重启后数据不可读"); await stop();
  const backup = await createBackup(dataRoot, backupsRoot, "dry-run"); await verifyBackup(backup); await restoreBackup(backup, restoredRoot);
  client = await start(restoredRoot); if (!(await conversation(client, recordId)).ok) throw new Error("恢复目录启动后数据不可读"); await stop();
  process.stdout.write(JSON.stringify({ ok: true, health: true, login: true, gracefulStop: true, restartReadable: true, restoredReadable: true }) + "\n");
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit").catch(() => undefined); }
  await rm(baseRoot, { recursive: true, force: true });
}
