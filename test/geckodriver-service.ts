import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  LinuxProcessSupervisor,
  readLinuxProcessIdentity,
  type LinuxProcessIdentity,
  type LinuxProcessStopResult
} from "./linux-process-supervisor.js";
import { withTimeout, type ChildClose } from "./test-helpers.js";

const MAX_DRIVER_LOG_BYTES = 8 * 1024;
const LISTEN_PATTERN = /(?:^|\n)[^\n]*\bListening on 127\.0\.0\.1:([0-9]{1,5})(?:\r?\n|$)/;
const LAUNCHER_PATH = join(process.cwd(), "test/fixtures/geckodriver-launcher.mjs");

export interface OwnedGeckodriverService {
  readonly child: ChildProcess;
  readonly closed: Promise<unknown>;
  readonly ready: Promise<{ origin: string; port: number }>;
  owns(pid: number): Promise<boolean>;
  ownsEndpoint(port: number): Promise<boolean>;
  stop(): Promise<LinuxProcessStopResult>;
}

export interface GeckodriverServiceOptions {
  argumentsPrefix?: string[];
  readyTimeoutMs?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  captureSupervisor?: (pid: number, expectedParentPid: number) => Promise<LinuxProcessSupervisor>;
}

function sameIdentity(left: LinuxProcessIdentity | undefined, right: LinuxProcessIdentity): boolean {
  return Boolean(left && left.pid === right.pid && left.startTimeTicks === right.startTimeTicks);
}

async function ownsLoopbackListener(identity: LinuxProcessIdentity, port: number): Promise<boolean> {
  if (!sameIdentity(await readLinuxProcessIdentity(identity.pid), identity)) return false;
  let descriptorNames: string[];
  try { descriptorNames = await readdir(`/proc/${identity.pid}/fd`); }
  catch { return false; }
  const socketInodes = new Set<string>();
  await Promise.all(descriptorNames.map(async name => {
    try {
      const target = await readlink(`/proc/${identity.pid}/fd/${name}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1]) socketInodes.add(match[1]);
    } catch {}
  }));
  let tcp: string;
  try { tcp = await readFile("/proc/net/tcp", "utf8"); }
  catch { return false; }
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const owns = tcp.split("\n").some(line => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === `0100007F:${expectedPort}`
      && fields[3] === "0A"
      && Boolean(fields[9] && socketInodes.has(fields[9]));
  });
  return owns && sameIdentity(await readLinuxProcessIdentity(identity.pid), identity);
}

function sendLauncherCommand(child: ChildProcess, type: "START" | "ABORT"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("DRIVER_SERVICE_LAUNCHER_DISCONNECTED"));
      return;
    }
    child.send({ type }, error => {
      if (error) reject(new Error("DRIVER_SERVICE_LAUNCHER_DISCONNECTED"));
      else resolve();
    });
  });
}

function targetSpawnFailure(child: ChildProcess): Promise<never> {
  return new Promise((_resolve, reject) => {
    child.on("message", message => {
      if ((message as { type?: unknown } | null)?.type === "TARGET_SPAWN_FAILED") {
        reject(new Error("DRIVER_SERVICE_SPAWN_FAILED"));
      }
    });
  });
}

function launcherMessage(child: ChildProcess, expected: "LAUNCHER_READY" | "TARGET_STARTED"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === expected) {
        cleanup();
        resolve();
      } else if (type === "TARGET_SPAWN_FAILED") {
        cleanup();
        reject(new Error("DRIVER_SERVICE_SPAWN_FAILED"));
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("DRIVER_SERVICE_LAUNCHER_DISCONNECTED"));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("close", onClose);
  });
}

function stableSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      const pid = child.pid;
      if (!pid) reject(new Error("DRIVER_SERVICE_SPAWN_FAILED"));
      else resolve(pid);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("DRIVER_SERVICE_SPAWN_FAILED"));
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function observeServiceClose(child: ChildProcess): Promise<ChildClose> {
  return new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function parseOwnedEndpoint(child: ChildProcess, timeoutMs: number): Promise<{ origin: string; port: number }> {
  return new Promise((resolve, reject) => {
    let log = "";
    let settled = false;
    const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => stream !== null);
    const finish = (error?: Error, port?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      for (const stream of streams) {
        stream.off("data", onData);
        stream.resume();
      }
      if (error || !port) reject(error ?? new Error("DRIVER_SERVICE_ENDPOINT_INVALID"));
      else resolve({ origin: `http://127.0.0.1:${port}`, port });
    };
    const onClose = (): void => finish(new Error("DRIVER_SERVICE_START_FAILED"));
    const onData = (chunk: string | Buffer): void => {
      if (settled) return;
      log += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(log, "utf8") > MAX_DRIVER_LOG_BYTES) {
        finish(new Error("DRIVER_SERVICE_LOG_LIMIT_EXCEEDED"));
        return;
      }
      const match = LISTEN_PATTERN.exec(log);
      if (!match?.[1]) return;
      const port = Number(match[1]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        finish(new Error("DRIVER_SERVICE_ENDPOINT_INVALID"));
        return;
      }
      finish(undefined, port);
    };
    const timer = setTimeout(() => finish(new Error("DRIVER_SERVICE_START_TIMED_OUT")), timeoutMs);
    for (const stream of streams) stream.on("data", onData);
    child.once("close", onClose);
  });
}

export function spawnOwnedGeckodriver(
  executable: string,
  options: GeckodriverServiceOptions = {}
): OwnedGeckodriverService {
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  const termTimeoutMs = options.termTimeoutMs ?? 2_000;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  const child = spawn(process.execPath, [
    LAUNCHER_PATH,
    executable,
    ...(options.argumentsPrefix ?? []),
    "--host", "127.0.0.1", "--port", "0", "--websocket-port", "0"
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  // Keep an error listener for errors after the initial spawn event; callers
  // receive only stable lifecycle errors from ready/stop.
  child.on("error", () => {});
  const closed = observeServiceClose(child);
  const captureSupervisor = options.captureSupervisor ?? LinuxProcessSupervisor.captureDetachedRoot;
  const launcherReady = launcherMessage(child, "LAUNCHER_READY");
  const targetStarted = launcherMessage(child, "TARGET_STARTED");
  void launcherReady.catch(() => {});
  void targetStarted.catch(() => {});
  let capturedSupervisor: LinuxProcessSupervisor | undefined;
  let targetStartAttempted = false;
  const supervisor = stableSpawn(child).then(async pid => {
    try {
      await launcherReady;
      const owner = await captureSupervisor(pid, process.pid);
      capturedSupervisor = owner;
      targetStartAttempted = true;
      await sendLauncherCommand(child, "START");
      await targetStarted;
      return owner;
    } catch (error) {
      if (!capturedSupervisor && !targetStartAttempted) {
        await sendLauncherCommand(child, "ABORT").catch(() => {});
        try { await withTimeout(closed, "unowned geckodriver launcher close", readyTimeoutMs); }
        catch { throw new Error("DRIVER_SERVICE_UNOWNED_LAUNCHER_REMAINED"); }
      }
      throw error;
    }
  });
  const endpoint = Promise.race([
    parseOwnedEndpoint(child, readyTimeoutMs),
    targetSpawnFailure(child)
  ]);
  const ready = supervisor.then(async owner => {
    const value = await endpoint;
    if (!child.pid || !await owner.owns(child.pid)) throw new Error("DRIVER_SERVICE_IDENTITY_CHANGED");
    return value;
  });
  // Both promises may settle before a caller reaches its first await (notably
  // an exec error); attach observers synchronously and still return originals.
  void endpoint.catch(() => {});
  void ready.catch(() => {});
  let stopPromise: Promise<LinuxProcessStopResult> | undefined;

  return {
    child,
    closed,
    ready,
    async owns(pid) {
      try { return await (await supervisor).owns(pid); }
      catch { return false; }
    },
    async ownsEndpoint(port) {
      try {
        const owner = await supervisor;
        const identities = await owner.ownedIdentities();
        for (const identity of identities) {
          if (await ownsLoopbackListener(identity, port)) return true;
        }
        return false;
      }
      catch { return false; }
    },
    stop() {
      stopPromise ??= (async () => {
        try {
          return await (await supervisor).stop({ termTimeoutMs, killTimeoutMs });
        } catch {
          if (capturedSupervisor) {
            return capturedSupervisor.stop({ termTimeoutMs, killTimeoutMs });
          }
          // Without a captured /proc identity, signalling child.pid would risk
          // targeting a reused PID. The launcher protocol proves START was not
          // attempted in this branch, so an observed launcher close also proves
          // that no target or descendant could have been created.
          if (targetStartAttempted) {
            return { diagnostics: ["OWNED_PROCESS_PROBE_FAILED", "OWNED_PROCESS_REMAINED"], phases: [] };
          }
          try {
            await withTimeout(closed, "owned geckodriver close without identity", termTimeoutMs + killTimeoutMs);
            return { diagnostics: [], phases: [] };
          } catch {}
          return { diagnostics: ["OWNED_PROCESS_PROBE_FAILED", "OWNED_PROCESS_REMAINED"], phases: [] };
        } finally {
          // Observe both late endpoint and child-close settlements.
          void endpoint.catch(() => {});
          void closed.catch(() => {});
        }
      })();
      return stopPromise;
    }
  };
}

export async function waitForOwnedGeckodriverStatus(
  service: OwnedGeckodriverService,
  waitForServer: (origin: string, timeoutMs: number, closed: Promise<unknown>) => Promise<unknown>,
  timeoutMs: number
): Promise<{ origin: string; port: number }> {
  const endpoint = await service.ready;
  if (!await service.ownsEndpoint(endpoint.port)) throw new Error("DRIVER_SERVICE_ENDPOINT_UNOWNED");
  try { await withTimeout(waitForServer(endpoint.origin, timeoutMs, service.closed), "owned geckodriver status", timeoutMs); }
  catch { throw new Error("DRIVER_SERVICE_START_FAILED"); }
  if (!service.child.pid || !await service.owns(service.child.pid)) {
    throw new Error("DRIVER_SERVICE_IDENTITY_CHANGED");
  }
  if (!await service.ownsEndpoint(endpoint.port)) throw new Error("DRIVER_SERVICE_ENDPOINT_UNOWNED");
  return endpoint;
}
