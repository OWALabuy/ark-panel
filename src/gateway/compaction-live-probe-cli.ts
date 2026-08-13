import { OpenClawCliClient } from "./cli-client.js";
import { CompactionLiveProbeError, parseCompactionLiveProbeArguments, runCompactionLiveProbe } from "./compaction-live-probe.js";
import { loadGatewayStreamAuth, OpenClawStreamObserver } from "./stream-client.js";

let observer: OpenClawStreamObserver | undefined;
try {
  const request = parseCompactionLiveProbeArguments(process.argv.slice(2), process.env);
  if (process.env.PANEL_ALLOW_COMPACTION_LIVE_PROBE !== "1") throw new CompactionLiveProbeError("PROBE_GATE_REQUIRED");
  if (process.env.PANEL_OPENCLAW_GATEWAY_URL !== undefined || process.env.OPENCLAW_GATEWAY_PORT !== undefined) {
    throw new CompactionLiveProbeError("PROBE_ENDPOINT_OVERRIDE_FORBIDDEN");
  }
  const auth = await loadGatewayStreamAuth({ HOME: process.env.HOME, PATH: process.env.PATH,
    PANEL_OPENCLAW_CONFIG_PATH: request.configPath, PANEL_OPENCLAW_GATEWAY_TOKEN: process.env.PANEL_OPENCLAW_GATEWAY_TOKEN,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: process.env.PANEL_OPENCLAW_GATEWAY_PASSWORD }, true);
  if (!auth) throw new CompactionLiveProbeError("PROBE_AUTH_UNAVAILABLE");
  observer = new OpenClawStreamObserver({ ...auth, requestTimeoutMs: 15_000, onDiagnostic: () => {} });
  const client = new OpenClawCliClient({ sessionsRoots: new Map([[request.agentId, request.sessionsRoot]]),
    gatewayRunTimeoutMs: 120_000, watcherGraceMs: 30_000, rpc: observer });
  const report = await runCompactionLiveProbe(request, { env: process.env, client });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const errorCode = error instanceof CompactionLiveProbeError ? error.code : "PROBE_EXECUTION_FAILED";
  const cleanupCode = error instanceof CompactionLiveProbeError ? error.cleanupCode : null;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, probe: "compaction", status: "failed", errorCode, cleanupCode })}\n`);
  process.exitCode = 2;
} finally { observer?.stop(); }
