import { createPanelServer } from "./app.js";
import { OpenClawCliClient } from "../gateway/cli-client.js";
import { FileBridgeMaterializer } from "../gateway/materializer.js";
import { BridgeService } from "../gateway/bridge-service.js";
import { PanelGenerationApi } from "./generation-api.js";
import { SessionReadData } from "./read-data.js";
import { parsePanelConfig, validateAndInitializeConfig } from "./config.js";
import { ConservativeContextBudget } from "../domain/context-budget.js";
import { PanelCommandApi } from "./command-api.js";
import { SessionOperationCoordinator } from "./session-operation.js";
import { ExperienceStore } from "./experience-store.js";
import { loadGatewayStreamAuth, OpenClawStreamObserver } from "../gateway/stream-client.js";
import { PanelAttachmentApi } from "./attachment-api.js";
import { PanelMemoryApi } from "./memory-api.js";
import { PanelMemoryConsolidationApi } from "./memory-consolidation-api.js";
import { MemoryConsolidationStore } from "../storage/memory-consolidation.js";

const config = parsePanelConfig(process.env, import.meta.url); await validateAndInitializeConfig(config);
const contextBudget = new ConservativeContextBudget(config.contextHistoryBudgetTokens);
const readApi = config.dataRoot && config.readAgents.length ? new SessionReadData(config.readAgents, config.dataRoot, contextBudget) : undefined;
const roots = new Map<string, string>();
for (const value of config.runtimes.values()) roots.set(value.runtimeAgentId, value.sessionsRoot);
for (const value of config.memoryRuntimes.values()) roots.set(value.runtimeAgentId, value.sessionsRoot);
const operations = new SessionOperationCoordinator();
const experienceAgentIds = new Set([...config.readAgents.map(agent => agent.agentId), ...config.runtimes.keys()]);
const experience = config.dataRoot ? new ExperienceStore(config.dataRoot, [...experienceAgentIds]) : undefined;
let generationApi: PanelGenerationApi | undefined;
let attachmentMaintenance: NodeJS.Timeout | undefined;
const gatewayAuth = config.dataRoot && config.runtimes.size ? await loadGatewayStreamAuth(process.env, true) : undefined;
const gatewayConnection = gatewayAuth ? new OpenClawStreamObserver({ ...gatewayAuth, requestTimeoutMs: 15_000,
  onDiagnostic: message => process.stderr.write(`[ark-panel] gateway stream: ${message}\n`) }) : undefined;
gatewayConnection?.start();
const gateway = new OpenClawCliClient({ sessionsRoots: roots, gatewayRunTimeoutMs: config.gatewayRunTimeoutMs,
  watcherGraceMs: config.runWatcherGraceMs, ...(gatewayConnection ? { rpc: gatewayConnection } : {}) });
const streamObserver = process.env.PANEL_OPENCLAW_STREAMING === "0" ? undefined : gatewayConnection;
const bridge = new BridgeService(gateway, new FileBridgeMaterializer(), roots, streamObserver, gatewayConnection);
if (config.dataRoot && config.runtimes.size) {
  const runtimeByAgent = new Map<string, string>();
  const workspaceByAgent = new Map<string, string>();
  for (const [agentId, value] of config.runtimes) runtimeByAgent.set(agentId, value.runtimeAgentId);
  for (const [agentId, value] of config.runtimes) if (value.workspaceRoot) workspaceByAgent.set(agentId, value.workspaceRoot);
  generationApi = new PanelGenerationApi(bridge,
    { dataRoot: config.dataRoot, runtimeByAgent, workspaceByAgent, contextBudget, operations });
  await generationApi.initialize();
  attachmentMaintenance = setInterval(() => generationApi?.maintainAttachments().catch(error =>
    process.stderr.write(`[ark-panel] attachment maintenance failed: ${String(error)}\n`)), 6 * 60 * 60 * 1000);
  attachmentMaintenance.unref();
}
const commandApi = config.dataRoot && readApi ? new PanelCommandApi(config.dataRoot, config.readAgents.map(agent => agent.agentId), {
  models: async () => (await gateway.listModels()).models,
  commands: async () => await gateway.listCommands(),
  status: async () => await gateway.status(),
  tools: async (agentId) => { const runtimeAgentId = config.runtimes.get(agentId)?.runtimeAgentId; if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED"); return await gateway.configuredTools(runtimeAgentId); },
  createPanel: async (agentId, title) => await readApi.createPanel(agentId, title),
  validateOverrides: async (agentId, overrides) => {
    const runtimeAgentId = config.runtimes.get(agentId)?.runtimeAgentId; if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
    await bridge.validateOverrides(runtimeAgentId, overrides);
  }
}, operations) : undefined;
const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
const attachments = config.dataRoot && config.runtimes.size ? new PanelAttachmentApi(config.dataRoot, [...config.runtimes.keys()]) : undefined;
const memoryWorkspaces = new Map<string, string>();
for (const [agentId, runtime] of config.runtimes) if (runtime.workspaceRoot) memoryWorkspaces.set(agentId, runtime.workspaceRoot);
const memoryStore = config.dataRoot ? new MemoryConsolidationStore(config.dataRoot) : undefined;
const memory = memoryWorkspaces.size ? new PanelMemoryApi(memoryWorkspaces, memoryStore) : undefined;
const memoryRuntimeByAgent = new Map<string, { runtimeAgentId: string; workspaceRoot: string }>();
for (const [agentId, runtime] of config.memoryRuntimes) { const workspaceRoot = config.runtimes.get(agentId)?.workspaceRoot; if (workspaceRoot) memoryRuntimeByAgent.set(agentId, { runtimeAgentId: runtime.runtimeAgentId, workspaceRoot }); }
const memoryConsolidation = memoryStore && readApi && memoryRuntimeByAgent.size ? new PanelMemoryConsolidationApi(
  memoryStore, readApi, memoryRuntimeByAgent, bridge, gateway) : undefined;
const server = createPanelServer({ auth: { username: config.username, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, secureCookie: config.secureCookie },
  publicDir: config.publicDir, mock: config.mock, allowedHosts, publicOrigins: allowedHosts.map(value => `http://${value}`),
  ...(generationApi ? { generation: generationApi } : {}), ...(commandApi ? { commands: commandApi } : {}), ...(readApi ? { reads: readApi } : {}), ...(experience ? { experience } : {}), ...(attachments ? { attachments } : {}), ...(memory ? { memory } : {}), ...(memoryConsolidation ? { memoryConsolidation } : {}) });
server.listen(config.port, config.host, () => process.stdout.write(`会话面板监听 http://${config.host}:${config.port}\n`));

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return; stopping = true; process.stdout.write(`收到 ${signal}，停止接受新连接\n`);
  if (attachmentMaintenance) clearInterval(attachmentMaintenance);
  gatewayConnection?.stop();
  const deadline = setTimeout(() => process.exit(1), 10_000); deadline.unref();
  server.close((error) => { clearTimeout(deadline); if (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } });
  server.closeIdleConnections();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
