import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "./app.js";
import { passwordHash } from "./auth.js";
import { SessionReadData } from "./read-data.js";
import { OpenClawCliClient } from "../gateway/cli-client.js";
import { FileBridgeMaterializer } from "../gateway/materializer.js";
import { BridgeService } from "../gateway/bridge-service.js";
import { PanelGenerationApi } from "./generation-api.js";

if (process.env.PANEL_ALLOW_CLAUDE_RUNTIME_ACCEPTANCE !== "1") throw new Error("只有显式允许时才能运行 claude runtime 验收");

const home = homedir();
const dataRoot = await mkdtemp(join(tmpdir(), "panel-claude-runtime-"));
const readRoot = join(home, ".openclaw", "agents", "claude", "sessions");
const runtimeAgentId = "panel-claude-runtime";
const runtimeRoot = join(home, ".openclaw", "agents", runtimeAgentId, "sessions");
const roots = new Map([[runtimeAgentId, runtimeRoot]]);
const reads = new SessionReadData([{ agentId: "claude", sessionsRoot: readRoot }], dataRoot);
const generation = new PanelGenerationApi(
  new BridgeService(new OpenClawCliClient({ sessionsRoots: roots, runTimeoutMs: 90_000 }), new FileBridgeMaterializer(), roots),
  { dataRoot, runtimeByAgent: new Map([["claude", runtimeAgentId]]) }
);
const username = "acceptance", password = randomUUID(), secret = randomUUID();
const server = createPanelServer({
  auth: { username, passwordHash: passwordHash(password, "0011223344556677"), sessionSecret: secret },
  publicDir: join(process.cwd(), "src", "frontend"), reads, generation
});
let removeGeneratedSkillsCache = false;

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

try {
  const beforeArtifacts = (await readdir(runtimeRoot)).sort();
  if (beforeArtifacts.some(name => name !== "sessions.json")) throw new Error("runtime sessions 在验收前存在 artifact");
  removeGeneratedSkillsCache = !beforeArtifacts.includes("skills-prompts");
  if (beforeArtifacts.includes("sessions.json") && (await readFile(join(runtimeRoot, "sessions.json"), "utf8")).trim() !== "{}") throw new Error("runtime 在验收前存在登记 session");

  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("监听失败");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!login.ok) throw new Error("登录失败");
  const loginValue = await login.json() as { data: { csrfToken: string } };
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const readHeaders = { cookie };
  const writeHeaders = { cookie, origin: base, "x-csrf-token": loginValue.data.csrfToken, "content-type": "application/json" };

  const createdResponse = await fetch(`${base}/api/v1/sessions`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ agentId: "claude", title: "runtime 隔离验收" }) });
  if (createdResponse.status !== 201) throw new Error("创建 panel 会话失败");
  const created = await createdResponse.json() as { data: { recordId: string; revision: string } };
  const marker = `RUNTIME_ACCEPTED_${randomUUID().slice(0, 8)}`;
  const message = `这是隔离验收。不要使用任何工具，不要访问文件、记忆、网络或外部服务，只回答固定短语：${marker}`;
  const runId = randomUUID();
  const generated = await fetch(`${base}/api/v1/sessions/${created.data.recordId}/runs`, {
    method: "POST", headers: { ...writeHeaders, "idempotency-key": runId }, body: JSON.stringify({ message, revision: created.data.revision })
  });
  if (!generated.ok) throw new Error("runtime run 创建失败");
  const observed = await fetch(`${base}/api/v1/runs/${runId}/events`, { headers: readHeaders });
  const events = await observed.text();
  if (!observed.ok || !events.includes("event: run.completed")) throw new Error("runtime 生成未完成");
  const conversationResponse = await fetch(`${base}/api/v1/sessions/${created.data.recordId}`, { headers: readHeaders });
  if (!conversationResponse.ok) throw new Error("无法读取落盘会话");
  const conversationText = await conversationResponse.text();
  if (!conversationText.includes(marker)) throw new Error("固定短语未落盘");
  if (/\"toolCall\"|\"toolResult\"|\"tool_use\"|\"tool_result\"/.test(conversationText)) throw new Error("验收 run 意外使用了工具");

  const afterArtifacts = (await readdir(runtimeRoot)).sort();
  if (afterArtifacts.some(name => name !== "sessions.json" && name !== "skills-prompts")) throw new Error(`runtime 清理后仍有 session artifact: ${afterArtifacts.join(",")}`);
  if (afterArtifacts.includes("sessions.json") && (await readFile(join(runtimeRoot, "sessions.json"), "utf8")).trim() !== "{}") throw new Error("runtime 清理后仍有登记 session");
  const transcript = join(dataRoot, "sessions", "claude", created.data.recordId, "transcript.jsonl");
  const transcriptStat = await stat(transcript);
  process.stdout.write(JSON.stringify({ ok: true, runtimeAgentId, markerDigest: digest(marker).slice(0, 12), transcriptBytes: transcriptStat.size, runtimeArtifacts: afterArtifacts }) + "\n");
} finally {
  server.close(); await once(server, "close").catch(() => undefined);
  if (removeGeneratedSkillsCache) await rm(join(runtimeRoot, "skills-prompts"), { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
}
