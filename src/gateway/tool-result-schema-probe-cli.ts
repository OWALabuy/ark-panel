import { randomUUID } from "node:crypto";
import { loadGatewayStreamAuth, OpenClawStreamObserver } from "./stream-client.js";
import { OpenClawCliClient } from "./cli-client.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import { parseToolResultSchemaProbeArguments, runToolResultSchemaProbe, ToolResultSchemaProbeError } from "./tool-result-schema-probe.js";

try {
  const request = parseToolResultSchemaProbeArguments(process.argv.slice(2), process.env);
  const roots = new Map([[request.agentId, request.sessionsRoot]]);
  const report = await runToolResultSchemaProbe(request, {
    env: process.env,
    loadAuth: async configPath => await loadGatewayStreamAuth({ HOME: process.env.HOME, PATH: process.env.PATH,
      PANEL_OPENCLAW_CONFIG_PATH: configPath, PANEL_OPENCLAW_GATEWAY_TOKEN: process.env.PANEL_OPENCLAW_GATEWAY_TOKEN,
      PANEL_OPENCLAW_GATEWAY_PASSWORD: process.env.PANEL_OPENCLAW_GATEWAY_PASSWORD }, true),
    createConnection: (auth, collector) => {
      const observer = new OpenClawStreamObserver({ ...(auth as ConstructorParameters<typeof OpenClawStreamObserver>[0]),
        ...(collector ? { toolSchemaCollector: collector } : {}), onDiagnostic: () => {} });
      return { observer, client: new OpenClawCliClient({ sessionsRoots: roots, gatewayRunTimeoutMs: 120_000,
        watcherGraceMs: 30_000, rpc: observer }) };
    },
    cleanup: async (client, created) => (await unregisterAndClean(client, { runtimeAgentId: request.agentId,
      sessionId: created.sessionId, sessionKey: created.sessionKey, runtimeSessionsRoot: request.sessionsRoot, allowedRuntimeRoots: roots })).length,
    randomUUID, setTimer: setTimeout, clearTimer: clearTimeout
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const code = error instanceof ToolResultSchemaProbeError ? error.code : "PROBE_EXECUTION_FAILED";
  const cleanupCode = error instanceof ToolResultSchemaProbeError ? error.cleanupCode : null;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, probe: "tool-result-schema", status: "failed", errorCode: code, cleanupCode })}\n`);
  process.exitCode = 2;
}
