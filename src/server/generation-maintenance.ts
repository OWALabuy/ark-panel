export interface GenerationMaintenanceTarget {
  maintainRuns(): Promise<void>;
  maintainAttachments(): Promise<void>;
}

export interface GenerationMaintenanceHandle {
  runNow(): Promise<boolean>;
  stop(): void;
}

export interface GenerationMaintenanceOptions {
  intervalMs?: number;
  log?: (message: string) => void;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

const RUN_FAILURE = "[ark-panel] run retention maintenance failed (RUN_RETENTION_MAINTENANCE_FAILED)";
const ATTACHMENT_FAILURE = "[ark-panel] attachment maintenance failed (ATTACHMENT_MAINTENANCE_FAILED)";

export function startGenerationMaintenance(target: GenerationMaintenanceTarget,
  options: GenerationMaintenanceOptions = {}): GenerationMaintenanceHandle {
  const schedule = options.setInterval ?? globalThis.setInterval;
  const cancel = options.clearInterval ?? globalThis.clearInterval;
  const log = options.log ?? (message => process.stderr.write(`${message}\n`));
  let running = false, stopped = false;

  const runNow = async (): Promise<boolean> => {
    if (running || stopped) return false;
    running = true;
    try {
      try { await target.maintainRuns(); }
      catch { log(RUN_FAILURE); }
      try { await target.maintainAttachments(); }
      catch { log(ATTACHMENT_FAILURE); }
      return true;
    } finally { running = false; }
  };

  const timer = schedule(() => void runNow(), options.intervalMs ?? 6 * 60 * 60 * 1000);
  timer.unref?.();
  return {
    runNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    }
  };
}
