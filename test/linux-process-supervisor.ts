import { readFile, readdir } from "node:fs/promises";

export interface LinuxProcessIdentity {
  pid: number;
  startTimeTicks: string;
  parentPid: number;
  processGroupId: number;
  sessionId: number;
}

export type LinuxProcessDiagnostic =
  | "OWNED_PROCESS_PROBE_FAILED"
  | "OWNED_PROCESS_SIGNAL_FAILED"
  | "OWNED_PROCESS_REMAINED";

export type LinuxProcessPhase =
  | "OWNED_PROCESS_TERM_SENT"
  | "OWNED_PROCESS_TERM_EXITED"
  | "OWNED_PROCESS_TERM_TIMED_OUT"
  | "OWNED_PROCESS_KILL_SENT"
  | "OWNED_PROCESS_KILL_EXITED"
  | "OWNED_PROCESS_KILL_TIMED_OUT"
  | "OWNED_PROCESS_IDENTITY_CHANGED";

export interface LinuxProcessStopResult {
  diagnostics: LinuxProcessDiagnostic[];
  phases: LinuxProcessPhase[];
}

export interface LinuxProcessStopOptions {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface LinuxProcessSupervisorDependencies {
  list: () => Promise<LinuxProcessIdentity[]>;
  read: (pid: number) => Promise<LinuxProcessIdentity | undefined>;
  signal: (pid: number, signal: NodeJS.Signals) => void;
}

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function expectedProcessAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function parseLinuxProcessStat(stat: string): LinuxProcessIdentity {
  const close = stat.lastIndexOf(")");
  const firstSpace = stat.indexOf(" ");
  if (firstSpace <= 0 || close <= firstSpace || close + 2 >= stat.length) {
    throw new Error("OWNED_PROCESS_STAT_INVALID");
  }
  const pid = Number(stat.slice(0, firstSpace));
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTimeTicks = fields[19];
  if (!validPid(pid) || !Number.isSafeInteger(parentPid) || parentPid < 0
      || !Number.isSafeInteger(processGroupId) || processGroupId < 0
      || !Number.isSafeInteger(sessionId) || sessionId < 0
      || !startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
    throw new Error("OWNED_PROCESS_STAT_INVALID");
  }
  return { pid, startTimeTicks, parentPid, processGroupId, sessionId };
}

export async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  if (process.platform !== "linux") throw new Error("LINUX_PROCESS_SUPERVISION_UNAVAILABLE");
  if (!validPid(pid)) throw new Error("OWNED_PROCESS_PID_INVALID");
  try {
    return parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (expectedProcessAbsence(error)) return undefined;
    if (error instanceof Error && error.message === "OWNED_PROCESS_STAT_INVALID") throw error;
    throw new Error("OWNED_PROCESS_PROBE_FAILED");
  }
}

async function listLinuxProcessIdentities(): Promise<LinuxProcessIdentity[]> {
  if (process.platform !== "linux") throw new Error("LINUX_PROCESS_SUPERVISION_UNAVAILABLE");
  let names: string[];
  try { names = await readdir("/proc"); }
  catch { throw new Error("OWNED_PROCESS_PROBE_FAILED"); }
  const identities = await Promise.all(names
    .filter(name => /^\d+$/.test(name))
    .map(name => readLinuxProcessIdentity(Number(name))));
  return identities.filter((identity): identity is LinuxProcessIdentity => Boolean(identity));
}

const defaultDependencies: LinuxProcessSupervisorDependencies = {
  list: listLinuxProcessIdentities,
  read: readLinuxProcessIdentity,
  signal: (pid, signal) => process.kill(pid, signal)
};

function identityKey(identity: LinuxProcessIdentity): string {
  return `${identity.pid}:${identity.startTimeTicks}`;
}

function sameIdentity(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean {
  return left.pid === right.pid && left.startTimeTicks === right.startTimeTicks;
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export class LinuxProcessSupervisor {
  readonly #root: LinuxProcessIdentity;
  readonly #dependencies: LinuxProcessSupervisorDependencies;
  readonly #tracked = new Map<string, LinuxProcessIdentity>();
  readonly #startTimesByPid = new Map<number, string>();
  #refreshing: Promise<void> = Promise.resolve();
  #trackingTimer: NodeJS.Timeout | undefined;
  #tracking = false;
  #probeFailed = false;
  #signalFailed = false;
  #identityChanged = false;
  #stopPromise: Promise<LinuxProcessStopResult> | undefined;

  constructor(root: LinuxProcessIdentity, dependencies: LinuxProcessSupervisorDependencies = defaultDependencies) {
    if (!validPid(root.pid) || !/^\d+$/.test(root.startTimeTicks)
        || !validPid(root.processGroupId) || !validPid(root.sessionId)) {
      throw new Error("OWNED_PROCESS_IDENTITY_INVALID");
    }
    this.#root = root;
    this.#dependencies = dependencies;
    this.#remember(root);
  }

  static async captureDetachedRoot(
    pid: number,
    expectedParentPid: number = process.pid
  ): Promise<LinuxProcessSupervisor> {
    const root = await readLinuxProcessIdentity(pid);
    if (!root) throw new Error("OWNED_PROCESS_ROOT_EXITED");
    if (root.parentPid !== expectedParentPid
        || root.processGroupId !== root.pid || root.sessionId !== root.pid) {
      throw new Error("OWNED_PROCESS_GROUP_UNSAFE");
    }
    const supervisor = new LinuxProcessSupervisor(root);
    await supervisor.initialize();
    return supervisor;
  }

  /**
   * Starts best-effort discovery without surrendering the already captured
   * root identity. A failed first full listing is fatal in the eventual stop
   * result, but cleanup can still verify and signal the exact root identity.
   */
  async initialize(): Promise<void> {
    await this.refresh().catch(() => { this.#probeFailed = true; });
    this.startTracking();
  }

  get rootIdentity(): LinuxProcessIdentity {
    return { ...this.#root };
  }

  async owns(pid: number): Promise<boolean> {
    await this.refresh();
    const current = await this.#dependencies.read(pid);
    return Boolean(current && this.#tracked.has(identityKey(current)));
  }

  async ownedIdentities(): Promise<LinuxProcessIdentity[]> {
    await this.refresh();
    return (await this.#alive()).map(identity => ({ ...identity }));
  }

  startTracking(pollIntervalMs = 10): void {
    if (this.#tracking || this.#stopPromise) return;
    this.#tracking = true;
    const schedule = (): void => {
      if (!this.#tracking) return;
      this.#trackingTimer = setTimeout(() => {
        void this.refresh().catch(() => { this.#probeFailed = true; }).finally(schedule);
      }, pollIntervalMs);
      this.#trackingTimer.unref();
    };
    schedule();
  }

  async refresh(): Promise<void> {
    const previous = this.#refreshing;
    let release!: () => void;
    this.#refreshing = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await this.#refreshOnce(); }
    finally { release(); }
  }

  stop(options: LinuxProcessStopOptions = {}): Promise<LinuxProcessStopResult> {
    this.#stopPromise ??= this.#stopOnce(options);
    return this.#stopPromise;
  }

  async #refreshOnce(): Promise<void> {
    let processes: LinuxProcessIdentity[];
    try { processes = await this.#dependencies.list(); }
    catch {
      this.#probeFailed = true;
      throw new Error("OWNED_PROCESS_PROBE_FAILED");
    }
    const byPid = new Map(processes.map(identity => [identity.pid, identity]));
    const ownedPids = new Set<number>();

    for (const current of processes) {
      const expectedStartTime = this.#startTimesByPid.get(current.pid);
      if (expectedStartTime && expectedStartTime !== current.startTimeTicks) {
        this.#markIdentityChanged();
        continue;
      }
      if (this.#tracked.has(identityKey(current))
          || (current.processGroupId === this.#root.processGroupId && current.sessionId === this.#root.sessionId)
          || current.sessionId === this.#root.sessionId) {
        ownedPids.add(current.pid);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const current of processes) {
        if (ownedPids.has(current.pid) || !ownedPids.has(current.parentPid)) continue;
        const expectedStartTime = this.#startTimesByPid.get(current.pid);
        if (expectedStartTime && expectedStartTime !== current.startTimeTicks) {
          this.#markIdentityChanged();
          continue;
        }
        ownedPids.add(current.pid);
        changed = true;
      }
    }

    for (const pid of ownedPids) {
      const identity = byPid.get(pid);
      if (identity) this.#remember(identity);
    }
  }

  #remember(identity: LinuxProcessIdentity): void {
    const previous = this.#startTimesByPid.get(identity.pid);
    if (previous && previous !== identity.startTimeTicks) {
      this.#markIdentityChanged();
      return;
    }
    this.#startTimesByPid.set(identity.pid, identity.startTimeTicks);
    this.#tracked.set(identityKey(identity), identity);
  }

  async #alive(): Promise<LinuxProcessIdentity[]> {
    const alive: LinuxProcessIdentity[] = [];
    for (const identity of this.#tracked.values()) {
      let current: LinuxProcessIdentity | undefined;
      try { current = await this.#dependencies.read(identity.pid); }
      catch {
        this.#probeFailed = true;
        alive.push(identity);
        continue;
      }
      if (!current) continue;
      if (!sameIdentity(current, identity)) {
        this.#markIdentityChanged();
        continue;
      }
      alive.push(identity);
    }
    return alive;
  }

  async #signal(signal: NodeJS.Signals, signalled = new Set<string>()): Promise<void> {
    await this.refresh().catch(() => { this.#probeFailed = true; });
    const alive = await this.#alive();
    alive.sort((left, right) => Number(left.pid === this.#root.pid) - Number(right.pid === this.#root.pid));
    for (const identity of alive) {
      const key = identityKey(identity);
      if (signalled.has(key)) continue;
      let current: LinuxProcessIdentity | undefined;
      try { current = await this.#dependencies.read(identity.pid); }
      catch { this.#probeFailed = true; continue; }
      if (!current) continue;
      if (!sameIdentity(current, identity)) {
        this.#markIdentityChanged();
        continue;
      }
      try {
        this.#dependencies.signal(identity.pid, signal);
        signalled.add(key);
      }
      catch (error) {
        if (!expectedProcessAbsence(error)) this.#signalFailed = true;
      }
    }
  }

  #markIdentityChanged(): void {
    this.#identityChanged = true;
    // The old identity is gone, but the supervisor cannot prove whether the
    // replacement is unrelated or a newly forked owned member. Never signal
    // it and never report a clean teardown from that ambiguous state.
    this.#probeFailed = true;
  }

  async #waitForExit(
    timeoutMs: number,
    pollIntervalMs: number,
    signal: NodeJS.Signals,
    signalled: Set<string>
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let stableEmptyListings = 0;
    while (true) {
      await this.refresh().catch(() => { this.#probeFailed = true; });
      const alive = await this.#alive();
      if (alive.length === 0) {
        stableEmptyListings += 1;
        if (stableEmptyListings >= 2) return true;
      } else {
        stableEmptyListings = 0;
        await this.#signal(signal, signalled);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await wait(Math.min(pollIntervalMs, remaining));
    }
  }

  async #stopOnce(options: LinuxProcessStopOptions): Promise<LinuxProcessStopResult> {
    const termTimeoutMs = options.termTimeoutMs ?? 2_000;
    const killTimeoutMs = options.killTimeoutMs ?? 2_000;
    const pollIntervalMs = options.pollIntervalMs ?? 10;
    const phases: LinuxProcessPhase[] = [];

    const termSignalled = new Set<string>();
    await this.#signal("SIGTERM", termSignalled);
    phases.push("OWNED_PROCESS_TERM_SENT");
    const termExited = await this.#waitForExit(termTimeoutMs, pollIntervalMs, "SIGTERM", termSignalled);
    phases.push(termExited ? "OWNED_PROCESS_TERM_EXITED" : "OWNED_PROCESS_TERM_TIMED_OUT");

    let exited = termExited;
    if (!termExited) {
      const killSignalled = new Set<string>();
      await this.#signal("SIGKILL", killSignalled);
      phases.push("OWNED_PROCESS_KILL_SENT");
      exited = await this.#waitForExit(killTimeoutMs, pollIntervalMs, "SIGKILL", killSignalled);
      phases.push(exited ? "OWNED_PROCESS_KILL_EXITED" : "OWNED_PROCESS_KILL_TIMED_OUT");
    }

    this.#tracking = false;
    if (this.#trackingTimer) clearTimeout(this.#trackingTimer);
    if (this.#identityChanged) phases.push("OWNED_PROCESS_IDENTITY_CHANGED");
    const diagnostics: LinuxProcessDiagnostic[] = [];
    if (this.#probeFailed) diagnostics.push("OWNED_PROCESS_PROBE_FAILED");
    if (this.#signalFailed) diagnostics.push("OWNED_PROCESS_SIGNAL_FAILED");
    if (!exited) diagnostics.push("OWNED_PROCESS_REMAINED");
    return { diagnostics, phases };
  }
}
