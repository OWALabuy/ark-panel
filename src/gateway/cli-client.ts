import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreatedSession, GatewayClient } from "./adapter.js";

interface CliOptions { executable?: string; sessionsRoots: ReadonlyMap<string, string>; requestTimeoutMs?: number; runTimeoutMs?: number }

function runCommand(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env: process.env });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("OPENCLAW_CLI_TIMEOUT")); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`OPENCLAW_CLI_FAILED (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

function payload(value: unknown): string { return JSON.stringify(value); }

interface TrajectoryEnd {
  runId?: unknown;
  type?: unknown;
  data?: { status?: unknown };
}

export function completedRunStatus(jsonl: string, runId: string): string | undefined {
  for (const line of jsonl.trimEnd().split("\n").reverse()) {
    if (!line.trim()) continue;
    let entry: TrajectoryEnd;
    try { entry = JSON.parse(line) as TrajectoryEnd; } catch { continue; }
    if (entry.type === "session.ended" && entry.runId === runId && typeof entry.data?.status === "string") return entry.data.status;
  }
  return undefined;
}

export class OpenClawCliClient implements GatewayClient {
  readonly executable: string; readonly sessionsRoots: ReadonlyMap<string, string>; readonly requestTimeoutMs: number; readonly runTimeoutMs: number;
  private readonly keysBySessionId = new Map<string, string>();
  constructor(options: CliOptions) {
    this.executable = options.executable ?? "openclaw"; this.sessionsRoots = options.sessionsRoots;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000; this.runTimeoutMs = options.runTimeoutMs ?? 120_000;
  }
  private async call<T>(method: string, params: unknown, timeout = this.requestTimeoutMs): Promise<T> {
    const output = await runCommand(this.executable, ["gateway", "call", method, "--json", "--timeout", String(timeout), "--params", payload(params)], timeout + 2_000);
    return JSON.parse(output) as T;
  }
  async version(): Promise<string> {
    const output = await runCommand(this.executable, ["--version"], this.requestTimeoutMs);
    const match = /OpenClaw\s+(\d+\.\d+\.\d+)/.exec(output);
    if (!match) throw new Error("无法识别 OpenClaw 版本"); return match[1]!;
  }
  async createSession(runtimeAgentId: string): Promise<CreatedSession> {
    const root = this.sessionsRoots.get(runtimeAgentId); if (!root) throw new Error("runtime agent 不在 allowlist");
    const localKey = `panel-${randomUUID()}`; const sessionKey = `agent:${runtimeAgentId}:${localKey}`;
    await this.call("sessions.create", { key: localKey, agentId: runtimeAgentId, label: "panel bridge" });
    const listed = JSON.parse(await runCommand(this.executable, ["sessions", "--agent", runtimeAgentId, "--json"], this.requestTimeoutMs)) as { sessions?: Array<{ key?: string; sessionId?: string }> };
    const found = listed.sessions?.find((session) => session.key === localKey || session.key === sessionKey);
    if (!found?.sessionId) throw new Error("sessions.create 后找不到 sessionId");
    this.keysBySessionId.set(found.sessionId, sessionKey);
    return { sessionId: found.sessionId, sessionKey, transcriptPath: join(root, `${found.sessionId}.jsonl`) };
  }
  async send(sessionKey: string, message: string, idempotencyKey: string): Promise<{ runId: string }> {
    return await this.call("sessions.send", { key: sessionKey, agentId: sessionKey.split(":")[1], message, timeoutMs: this.runTimeoutMs, idempotencyKey });
  }
  async waitForCompletion(sessionId: string, runId: string): Promise<void> {
    const key = this.keysBySessionId.get(sessionId); if (!key) throw new Error("未知 sessionId");
    const agentId = key.split(":")[1];
    const root = agentId ? this.sessionsRoots.get(agentId) : undefined;
    if (!root) throw new Error("runtime agent 不在 allowlist");
    const trajectoryPath = join(root, `${sessionId}.trajectory.jsonl`);
    const started = Date.now();
    while (Date.now() - started < this.runTimeoutMs) {
      let status: string | undefined;
      try { status = completedRunStatus(await readFile(trajectoryPath, "utf8"), runId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (status === "success") return;
      if (status) throw new Error(`BRIDGE_RUN_${status.toUpperCase()}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("BRIDGE_RUN_TIMEOUT");
  }
  async abort(sessionKey: string, runId?: string): Promise<void> {
    await this.call("sessions.abort", { key: sessionKey, ...(runId ? { runId } : {}) });
  }
  async deleteSession(sessionKey: string): Promise<void> {
    const pieces = sessionKey.split(":"); const agentId = pieces[1];
    await this.call("sessions.delete", { key: sessionKey, agentId, deleteTranscript: true, emitLifecycleHooks: false });
  }
}
