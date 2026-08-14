import { randomUUID } from "node:crypto";
import { OpenClawCliClient } from "./cli-client.js";
import { parseRuntimeAcceptanceArguments, runRuntimeAcceptance, RuntimeAcceptanceError } from "./runtime-acceptance.js";
import { loadGatewayStreamAuth, OpenClawStreamObserver } from "./stream-client.js";

let observer: OpenClawStreamObserver | undefined;
try {
  const request = parseRuntimeAcceptanceArguments(process.argv.slice(2), process.env);
  if (process.env.PANEL_ALLOW_RUNTIME_ACCEPTANCE !== "1") throw new RuntimeAcceptanceError("PROBE_GATE_REQUIRED");
  if (process.env.PANEL_OPENCLAW_GATEWAY_URL !== undefined || process.env.OPENCLAW_GATEWAY_PORT !== undefined) {
    throw new RuntimeAcceptanceError("PROBE_ENDPOINT_OVERRIDE_FORBIDDEN");
  }
  const auth = await loadGatewayStreamAuth({ HOME: process.env.HOME, PATH: process.env.PATH,
    PANEL_OPENCLAW_CONFIG_PATH: request.configPath, PANEL_OPENCLAW_GATEWAY_TOKEN: process.env.PANEL_OPENCLAW_GATEWAY_TOKEN,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: process.env.PANEL_OPENCLAW_GATEWAY_PASSWORD }, true);
  if (!auth) throw new RuntimeAcceptanceError("PROBE_AUTH_UNAVAILABLE");
  observer = new OpenClawStreamObserver({ ...auth, requestTimeoutMs: 15_000, onDiagnostic: () => {} });
  const client = new OpenClawCliClient({ sessionsRoots: new Map([[request.agentId, request.sessionsRoot]]),
    gatewayRunTimeoutMs: 120_000, watcherGraceMs: 30_000, rpc: observer });
  const report = await runRuntimeAcceptance(request, { env: process.env, client, randomUUID });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const errorCode = error instanceof RuntimeAcceptanceError ? error.code : "PROBE_EXECUTION_FAILED";
  const cleanupCode = error instanceof RuntimeAcceptanceError ? error.cleanupCode : null;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, probe: "runtime-acceptance", status: "failed", errorCode, cleanupCode })}\n`);
  process.exitCode = 2;
} finally { observer?.stop(); }
