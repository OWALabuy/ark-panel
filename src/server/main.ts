import { createPanelServer } from "./app.js";
import { OpenClawCliClient } from "../gateway/cli-client.js";
import { FileBridgeMaterializer } from "../gateway/materializer.js";
import { BridgeService } from "../gateway/bridge-service.js";
import { PanelGenerationApi } from "./generation-api.js";
import { SessionReadData } from "./read-data.js";
import { parsePanelConfig, validateAndInitializeConfig } from "./config.js";
import { ConservativeContextBudget } from "../domain/context-budget.js";

const config = parsePanelConfig(process.env, import.meta.url); await validateAndInitializeConfig(config);
const readApi = config.dataRoot && config.readAgents.length ? new SessionReadData(config.readAgents, config.dataRoot) : undefined;
let generationApi: PanelGenerationApi | undefined;
if (config.dataRoot && config.runtimes.size) {
  const runtimeByAgent = new Map<string, string>(), roots = new Map<string, string>();
  for (const [agentId, value] of config.runtimes) { runtimeByAgent.set(agentId, value.runtimeAgentId); roots.set(value.runtimeAgentId, value.sessionsRoot); }
  generationApi = new PanelGenerationApi(new BridgeService(new OpenClawCliClient({ sessionsRoots: roots }), new FileBridgeMaterializer(), roots),
    { dataRoot: config.dataRoot, runtimeByAgent, contextBudget: new ConservativeContextBudget(config.contextHistoryBudgetTokens) });
}
const allowedHosts = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
const server = createPanelServer({ auth: { username: config.username, passwordHash: config.passwordHash, sessionSecret: config.sessionSecret, secureCookie: config.secureCookie },
  publicDir: config.publicDir, mock: config.mock, allowedHosts, publicOrigins: allowedHosts.map(value => `http://${value}`),
  ...(generationApi ? { generation: generationApi } : {}), ...(readApi ? { reads: readApi } : {}) });
server.listen(config.port, config.host, () => process.stdout.write(`会话面板监听 http://${config.host}:${config.port}\n`));

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return; stopping = true; process.stdout.write(`收到 ${signal}，停止接受新连接\n`);
  const deadline = setTimeout(() => process.exit(1), 10_000); deadline.unref();
  server.close((error) => { clearTimeout(deadline); if (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } });
  server.closeIdleConnections();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
