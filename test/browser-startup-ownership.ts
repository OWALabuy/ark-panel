import type { BrowserCleanupController, OwnedProcessStopResult } from "./browser-cleanup.js";
import { withTimeout } from "./test-helpers.js";

export interface ClosableBrowserFixture {
  close(): Promise<unknown>;
}

export interface StoppableOwnedProcesses {
  stop(): Promise<OwnedProcessStopResult>;
}

export interface QuittableBrowserDriver {
  quit(): Promise<unknown>;
}

/** Atomically transfers a newly created fixture to the cleanup controller. */
export async function attachFixtureOrClose(
  cleanup: BrowserCleanupController,
  fixture: ClosableBrowserFixture,
  timeoutMs: number
): Promise<void> {
  try {
    cleanup.attachFixture(() => fixture.close());
  } catch (attachError) {
    try { await withTimeout(fixture.close(), "unattached browser fixture close", timeoutMs); }
    catch { throw new Error("BROWSER_FIXTURE_LOCAL_CLEANUP_FAILED"); }
    throw attachError;
  }
}

/** Atomically transfers a newly spawned process tree to the cleanup controller. */
export async function attachOwnedProcessesOrStop(
  cleanup: BrowserCleanupController,
  processes: StoppableOwnedProcesses,
  timeoutMs: number
): Promise<void> {
  try {
    cleanup.attachOwnedProcesses(() => processes.stop());
  } catch (attachError) {
    let result: OwnedProcessStopResult;
    try { result = await withTimeout(processes.stop(), "unattached browser process stop", timeoutMs); }
    catch { throw new Error("BROWSER_PROCESS_LOCAL_CLEANUP_FAILED"); }
    if (result.diagnostics.length) throw new Error("BROWSER_PROCESS_LOCAL_CLEANUP_FAILED");
    throw attachError;
  }
}

/** Atomically transfers a half-created WebDriver HTTP session to cleanup. */
export async function attachDriverOrQuit(
  cleanup: BrowserCleanupController,
  driver: QuittableBrowserDriver,
  timeoutMs: number
): Promise<void> {
  try {
    cleanup.attachDriver(() => driver.quit());
  } catch (attachError) {
    // The separately attached owned-process supervisor remains authoritative
    // if this bounded HTTP fallback rejects or times out.
    try { await withTimeout(driver.quit(), "unattached Firefox WebDriver quit", timeoutMs); }
    catch {}
    throw attachError;
  }
}
