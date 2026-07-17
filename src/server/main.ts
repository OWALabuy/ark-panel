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

const config = parsePanelConfig(process.env, import.meta.url); await validateAndInitializeConfig(config);
const readApi = config.dataRoot && config.readAgents.length ? new SessionReadData(config.readAgents, config.dataRoot) : undefined;
const roots = new Map<string, string>();
for (const value of config.runtimes.values()) roots.set(value.runtimeAgentId, value.sessionsRoot);
const gateway = new OpenClawCliClient({ sessionsRoots: roots, gatewayRunTimeoutMs: config.gatewayRunTimeoutMs, watcherGraceMs: config.runWatcherGraceMs });
const operations = new SessionOperationCoordinator();
const experienceAgentIds = new Set([...config.readAgents.map(agent => agent.agentId), ...config.runtimes.keys()]);
const experience = config.dataRoot ? new ExperienceStore(config.dataRoot, [...experienceAgentIds]) : undefined;
let generationApi: PanelGenerationApi | undefined;
const streamAuth = config.dataRoot && config.runtimes.size ? await loadGatewayStreamAuth() : undefined;
const streamObserver = streamAuth ? new OpenClawStreamObserver({ ...streamAuth, requestTimeoutMs: 1_500,
  onDiagnostic: message => process.stderr.write(`[ark-panel] gateway stream: ${message}\n`) }) : undefined;
streamObserver?.start();
const bridge = new BridgeService(gateway, new FileBridgeMaterializer(), roots, streamObserver);
if (config.dataRoot && config.runtimes.size) {
  const runtimeByAgent = new Map<string, string>();
  for (const [agentId, value] of config.runtimes) runtimeByAgent.set(agentId, value.runtimeAgentId);
  generationApi = new PanelGenerationApi(bridge,
    { dataRoot: config.dataRoot, runtimeByAgent, contextBudget: new ConservativeContextBudget(config.contextHistoryBudgetTokens), operations });
  await generationApi.initialize();
}
const commandApi = config.dataRoot && readApi ? new PanelCommandApi(config.dataRoot, config.readAgents.map(agent => agent.agentId), {
  models: async () => (await gateway.listModels()).models,
  commands: async () => await gateway.listCommands(),
  status: async () => await gateway.status(),
  createPanel: async (agentId, title) => await readApi.createPanel(agentId, title),
  validateOverrides: async (agentId, overrides) => {
    const runtimeAgentId = config.runtimes.get(agentId)?.runtimeAgentId; if (!runtimeAgentId) throw new Error("RUNTIME_NOT_CONFIGURED");
    await bridge.validateOverrides(runtimeAgentId, overrides);
  }
}, operations) : undefined;
const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
const server = createPanelServer({ auth: { username: config.username, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, secureCookie: config.secureCookie },
  publicDir: config.publicDir, mock: config.mock, allowedHosts, publicOrigins: allowedHosts.map(value => `http://${value}`),
  ...(generationApi ? { generation: generationApi } : {}), ...(commandApi ? { commands: commandApi } : {}), ...(readApi ? { reads: readApi } : {}), ...(experience ? { experience } : {}) });
server.listen(config.port, config.host, () => process.stdout.write(`会话面板监听 http://${config.host}:${config.port}\n`));

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return; stopping = true; process.stdout.write(`收到 ${signal}，停止接受新连接\n`);
  streamObserver?.stop();
  const deadline = setTimeout(() => process.exit(1), 10_000); deadline.unref();
  server.close((error) => { clearTimeout(deadline); if (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } });
  server.closeIdleConnections();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
