import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { OpenClawCliClient } from "./cli-client.js";
import { FileBridgeMaterializer } from "./materializer.js";
import { BridgeService } from "./bridge-service.js";

if (process.env.PANEL_ALLOW_PANELTEST_INTEGRATION !== "1") throw new Error("只有显式设置 PANEL_ALLOW_PANELTEST_INTEGRATION=1 才能运行");
const root = join(homedir(), ".openclaw", "agents", "paneltest", "sessions");
const client = new OpenClawCliClient({ sessionsRoots: new Map([["paneltest", root]]), runTimeoutMs: 90_000 });
const service = new BridgeService(client, new FileBridgeMaterializer(), new Map([["paneltest", root]]));
const result = await service.generate({ runtimeAgentId: "paneltest", idempotencyKey: randomUUID(), latestUserMessage: "只回答：面板桥接集成测试通过。不使用工具。",
  latestUserEntryId: randomUUID(),
  historyThroughPreviousRun: { header: { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: join(homedir(), "paneltest-workspace") }, entries: [] } });
process.stdout.write(JSON.stringify({ runId: result.runId, sessionId: result.sessionId, entryCount: result.entries.length }) + "\n");
