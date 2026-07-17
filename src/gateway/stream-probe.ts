import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OpenClawCliClient } from "./cli-client.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { loadGatewayStreamAuth, OpenClawStreamObserver, type GatewayStreamEvent } from "./stream-client.js";

if (process.env.PANEL_ALLOW_STREAM_PROBE !== "1") throw new Error("协议探针需要显式设置 PANEL_ALLOW_STREAM_PROBE=1");

const runtimeAgentId = process.env.PANEL_STREAM_PROBE_AGENT ?? "paneltest";
const sessionsRoot = process.env.PANEL_STREAM_PROBE_SESSIONS_ROOT ?? join(process.env.HOME ?? homedir(), ".openclaw", "agents", runtimeAgentId, "sessions");
const auth = await loadGatewayStreamAuth(); if (!auth) throw new Error("无法解析 OpenClaw Gateway 流式认证配置");
const observer = new OpenClawStreamObserver({ ...auth, onDiagnostic: message => process.stderr.write(`[stream-probe] ${message}\n`) });
const roots = new Map([[runtimeAgentId, sessionsRoot]]), client = new OpenClawCliClient({ sessionsRoots: roots, gatewayRunTimeoutMs: 120_000, watcherGraceMs: 30_000 });
const created = await client.createSession(runtimeAgentId); const runId = randomUUID(), events: GatewayStreamEvent[] = [];
let unsubscribe: (() => void) | undefined;
try {
  unsubscribe = await observer.observe(created.sessionKey, event => { if (event.type === "connection" || event.runId === runId) events.push(event); });
  const accepted = await client.send(created.sessionKey,
    "这是 ark-panel 流式协议探针。必须调用 exec 工具执行 `printf ark-stream-probe`，然后用一句中文说明你看到了什么。不要省略工具调用。", runId);
  if (accepted.runId !== runId) throw new Error(`gateway runId 不匹配: ${accepted.runId}`);
  await client.waitForCompletion(created.sessionId, runId);
  await new Promise(resolve => setTimeout(resolve, 250));
  const text = events.filter(event => event.type === "assistant_text"), tools = events.filter(event => event.type === "tool");
  const started = tools.some(event => event.type === "tool" && event.phase === "started"), finished = tools.some(event => event.type === "tool" && (event.phase === "completed" || event.phase === "failed"));
  if (!text.length) throw new Error("未观察到 chat delta");
  if (!started || !finished) throw new Error(`工具事件不完整: started=${started} finished=${finished}`);
  process.stdout.write(`${JSON.stringify({ ok: true, version: "2026.6.11", textDeltaEvents: text.length, toolEvents: tools.length,
    toolStarted: started, toolFinished: finished, connections: events.filter(event => event.type === "connection").map(event => event.state) })}\n`);
} finally {
  unsubscribe?.(); observer.stop();
  await unregisterAndClean(client, { runtimeAgentId, sessionId: created.sessionId, sessionKey: created.sessionKey, runtimeSessionsRoot: sessionsRoot, allowedRuntimeRoots: roots });
}
