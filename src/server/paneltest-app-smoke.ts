import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createPanelServer } from "./app.js";
import { passwordHash } from "./auth.js";
import { SessionReadData } from "./read-data.js";
import { OpenClawCliClient } from "../gateway/cli-client.js";
import { FileBridgeMaterializer } from "../gateway/materializer.js";
import { BridgeService } from "../gateway/bridge-service.js";
import { PanelGenerationApi } from "./generation-api.js";

if (process.env.PANEL_ALLOW_PANELTEST_INTEGRATION !== "1") throw new Error("只有显式允许时才能运行 paneltest 应用烟测");
const dataRoot = await mkdtemp(join(tmpdir(), "panel-app-smoke-"));
const home = homedir(), runtimeRoot = join(home, ".openclaw", "agents", "paneltest", "sessions");
const reads = new SessionReadData([
  { agentId: "claude", sessionsRoot: join(home, ".openclaw", "agents", "claude", "sessions") },
  { agentId: "main", sessionsRoot: join(home, ".openclaw", "agents", "main", "sessions") }
], dataRoot);
const roots = new Map([["paneltest", runtimeRoot]]);
const generation = new PanelGenerationApi(new BridgeService(new OpenClawCliClient({ sessionsRoots: roots, runTimeoutMs: 90_000 }), new FileBridgeMaterializer(), roots),
  { dataRoot, runtimeByAgent: new Map([["claude", "paneltest"]]) });
const publicDir = join(process.cwd(), "src", "frontend"), username = "smoke", password = randomUUID(), secret = randomUUID();
const server = createPanelServer({ auth: { username, passwordHash: passwordHash(password, "0011223344556677"), sessionSecret: secret }, publicDir, reads, generation });

try {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("监听失败");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!login.ok) throw new Error("登录失败"); const loginValue = await login.json() as { data: { csrfToken: string } };
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const readHeaders = { cookie }, writeHeaders = { cookie, origin: base, "x-csrf-token": loginValue.data.csrfToken, "content-type": "application/json" };
  const agents = await (await fetch(`${base}/api/v1/agents`, { headers: readHeaders })).json() as { data: Array<{ id: string; sessionCount: number }> };
  if (!agents.data.some(agent => agent.id === "claude") || !agents.data.some(agent => agent.id === "main")) throw new Error("真实只读 agent 未列出");
  const createdResponse = await fetch(`${base}/api/v1/sessions`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ agentId: "claude" }) });
  if (createdResponse.status !== 201) throw new Error("创建 panel 会话失败"); const created = await createdResponse.json() as { data: { recordId: string; revision: string } };
  const runId = randomUUID(), testMessage = `只回答：面板应用端到端通过-${runId.slice(0, 8)}。不使用工具。`;
  const generated = await fetch(`${base}/api/v1/sessions/${created.data.recordId}/messages`, { method: "POST", headers: { ...writeHeaders, "idempotency-key": runId },
    body: JSON.stringify({ message: testMessage, revision: created.data.revision }) });
  const events = await generated.text(); if (!generated.ok || !events.includes("event: run.completed")) throw new Error("paneltest 生成未完成");
  const conversation = await (await fetch(`${base}/api/v1/sessions/${created.data.recordId}`, { headers: readHeaders })).json() as { data: { document: { entries: Array<{ id?: string; message?: { role?: string } }> } } };
  const assistant = [...conversation.data.document.entries].reverse().find(entry => entry.message?.role === "assistant" && entry.id); if (!assistant?.id) throw new Error("持久化结果缺少 assistant entry");
  const searched = await (await fetch(`${base}/api/v1/search?q=${encodeURIComponent(runId.slice(0, 8))}&agentId=claude`, { headers: readHeaders })).json() as { data: unknown[] };
  if (!searched.data.length) throw new Error("搜索未找到测试会话");
  const forked = await fetch(`${base}/api/v1/sessions/${created.data.recordId}/fork`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ messageId: assistant.id }) });
  if (forked.status !== 201) throw new Error("fork 失败");
  process.stdout.write(JSON.stringify({ agents: agents.data.map(agent => ({ id: agent.id, sessionCount: agent.sessionCount })), panelEntries: conversation.data.document.entries.length, searchMatches: searched.data.length, forked: true }) + "\n");
} finally {
  server.close(); await once(server, "close").catch(() => undefined); await rm(dataRoot, { recursive: true, force: true });
}
