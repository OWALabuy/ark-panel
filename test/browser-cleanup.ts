import type { LinuxProcessDiagnostic, LinuxProcessPhase } from "./linux-process-supervisor.js";

export type BrowserCleanupDiagnostic = LinuxProcessDiagnostic
  | "SCENARIO_WATCHDOG_TRIGGERED"
  | "FIXTURE_CLOSE_FAILED";

export type BrowserCleanupPhase = LinuxProcessPhase
  | "DRIVER_QUIT_COMPLETED"
  | "DRIVER_QUIT_REJECTED"
  | "DRIVER_QUIT_TIMED_OUT"
  | "OWNED_PROCESS_STOP_REJECTED"
  | "OWNED_PROCESS_STOP_TIMED_OUT"
  | "OWNED_PROCESS_SUPERVISOR_MISSING"
  | "SCENARIO_WATCHDOG_TRIGGERED"
  | "FIXTURE_CLOSE_COMPLETED"
  | "FIXTURE_CLOSE_FAILED";

export interface OwnedProcessStopResult {
  diagnostics: LinuxProcessDiagnostic[];
  phases: LinuxProcessPhase[];
}

export interface BrowserCleanupTarget {
  quit(): Promise<unknown>;
  stopOwnedProcesses(): Promise<OwnedProcessStopResult>;
}

export interface BrowserCleanupOptions {
  quitTimeoutMs?: number;
  processStopTimeoutMs?: number;
}

export interface BrowserCleanupResult {
  diagnostics: BrowserCleanupDiagnostic[];
  phases: BrowserCleanupPhase[];
}

type Outcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "rejected" }
  | { kind: "timed-out" };

async function outcomeWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  // This observer remains attached after a timeout so a late rejection never
  // becomes unhandled. With an external Executor, late WebDriver quit also has
  // no service callback and cannot signal the owned process tree.
  const settled = operation.then<Outcome<T>, Outcome<T>>(
    value => ({ kind: "completed", value }),
    () => ({ kind: "rejected" })
  );
  try {
    return await Promise.race([
      settled,
      new Promise<Outcome<T>>(resolve => {
        timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Closes one WebDriver HTTP session and its separately supervised Linux process
 * tree. A slow/rejected HTTP quit is not itself fatal once every captured owned
 * identity has exited. A bounded supervisor timeout fails closed.
 */
export async function cleanupOwnedBrowser(
  target: BrowserCleanupTarget,
  options: BrowserCleanupOptions = {}
): Promise<BrowserCleanupResult> {
  const quitTimeoutMs = options.quitTimeoutMs ?? 5_000;
  const processStopTimeoutMs = options.processStopTimeoutMs ?? 5_000;
  const diagnostics: BrowserCleanupDiagnostic[] = [];
  const phases: BrowserCleanupPhase[] = [];

  const quitOutcome = await outcomeWithin(Promise.resolve().then(() => target.quit()), quitTimeoutMs);
  phases.push(quitOutcome.kind === "completed"
    ? "DRIVER_QUIT_COMPLETED"
    : quitOutcome.kind === "rejected"
      ? "DRIVER_QUIT_REJECTED"
      : "DRIVER_QUIT_TIMED_OUT");

  const stopOutcome = await outcomeWithin(
    Promise.resolve().then(() => target.stopOwnedProcesses()),
    processStopTimeoutMs
  );
  if (stopOutcome.kind === "completed") {
    diagnostics.push(...stopOutcome.value.diagnostics);
    phases.push(...stopOutcome.value.phases);
  } else {
    phases.push(stopOutcome.kind === "rejected"
      ? "OWNED_PROCESS_STOP_REJECTED"
      : "OWNED_PROCESS_STOP_TIMED_OUT");
    diagnostics.push("OWNED_PROCESS_REMAINED");
  }

  return { diagnostics, phases };
}

export interface BrowserCleanupControllerOptions extends BrowserCleanupOptions {
  fixtureCloseTimeoutMs?: number;
}

export interface BrowserStartupToken {
  close(): void;
}

/** Resource registry installed before a browser scenario performs any await. */
export class BrowserCleanupController {
  readonly #options: BrowserCleanupControllerOptions;
  #quit: (() => Promise<unknown>) | undefined;
  #stopOwnedProcesses: (() => Promise<OwnedProcessStopResult>) | undefined;
  #closeFixture: (() => Promise<unknown>) | undefined;
  #cleanupPromise: Promise<BrowserCleanupResult> | undefined;
  #watchdogTimer: NodeJS.Timeout | undefined;
  #watchdogTriggered = false;
  #startupIssued = false;
  #startupOpen = false;
  #startupBarrier: Promise<void> | undefined;
  #closeStartupBarrier: (() => void) | undefined;

  constructor(options: BrowserCleanupControllerOptions = {}) {
    this.#options = options;
  }

  /**
   * Opens the one startup window during which resources may still be attached
   * after cleanup has begun. The caller must close the token after every
   * startup path has either attached its resource or proved none was created.
   */
  beginStartup(): BrowserStartupToken {
    if (this.#startupIssued || this.#cleanupPromise) {
      throw new Error("BROWSER_STARTUP_ALREADY_BEGUN");
    }
    this.#startupIssued = true;
    this.#startupOpen = true;
    this.#startupBarrier = new Promise<void>(resolve => {
      this.#closeStartupBarrier = resolve;
    });
    let closed = false;
    return Object.freeze({
      close: (): void => {
        if (closed) throw new Error("BROWSER_STARTUP_ALREADY_CLOSED");
        closed = true;
        this.#startupOpen = false;
        this.#closeStartupBarrier?.();
        this.#closeStartupBarrier = undefined;
      }
    });
  }

  #attachmentClosed(): boolean {
    return Boolean(this.#cleanupPromise && !this.#startupOpen);
  }

  attachDriver(quit: () => Promise<unknown>): void {
    if (this.#quit || this.#attachmentClosed()) throw new Error("BROWSER_DRIVER_ALREADY_ATTACHED");
    this.#quit = quit;
  }

  attachOwnedProcesses(stop: () => Promise<OwnedProcessStopResult>): void {
    if (this.#stopOwnedProcesses || this.#attachmentClosed()) throw new Error("BROWSER_PROCESSES_ALREADY_ATTACHED");
    this.#stopOwnedProcesses = stop;
  }

  attachFixture(close: () => Promise<unknown>): void {
    if (this.#closeFixture || this.#attachmentClosed()) throw new Error("BROWSER_FIXTURE_ALREADY_ATTACHED");
    this.#closeFixture = close;
  }

  armWatchdog(timeoutMs: number): void {
    if (this.#watchdogTimer || this.#cleanupPromise) throw new Error("BROWSER_WATCHDOG_ALREADY_ARMED");
    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTriggered = true;
      void this.cleanup();
    }, timeoutMs);
  }

  cleanup(): Promise<BrowserCleanupResult> {
    this.#cleanupPromise ??= this.#cleanupOnce();
    return this.#cleanupPromise;
  }

  async #cleanupOnce(): Promise<BrowserCleanupResult> {
    if (this.#watchdogTimer) clearTimeout(this.#watchdogTimer);
    const diagnostics: BrowserCleanupDiagnostic[] = [];
    const phases: BrowserCleanupPhase[] = [];
    if (this.#watchdogTriggered) {
      diagnostics.push("SCENARIO_WATCHDOG_TRIGGERED");
      phases.push("SCENARIO_WATCHDOG_TRIGGERED");
    }

    // Cleanup owns everything attached before the startup token closes,
    // including resources that arrive after a watchdog initiated cleanup.
    await this.#startupBarrier;

    if (this.#stopOwnedProcesses) {
      const browser = await cleanupOwnedBrowser({
        quit: () => this.#quit?.() ?? Promise.resolve(),
        stopOwnedProcesses: () => this.#stopOwnedProcesses?.() ?? Promise.resolve({ diagnostics: [], phases: [] })
      }, this.#options);
      diagnostics.push(...browser.diagnostics);
      phases.push(...browser.phases);
    } else if (this.#quit) {
      diagnostics.push("OWNED_PROCESS_PROBE_FAILED");
      phases.push("OWNED_PROCESS_SUPERVISOR_MISSING");
    }

    if (this.#closeFixture) {
      const fixtureOutcome = await outcomeWithin(
        Promise.resolve().then(() => this.#closeFixture?.()),
        this.#options.fixtureCloseTimeoutMs ?? 5_000
      );
      if (fixtureOutcome.kind === "completed") phases.push("FIXTURE_CLOSE_COMPLETED");
      else {
        diagnostics.push("FIXTURE_CLOSE_FAILED");
        phases.push("FIXTURE_CLOSE_FAILED");
      }
    }
    return { diagnostics, phases };
  }
}
