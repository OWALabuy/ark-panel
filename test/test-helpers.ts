import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

let postRenameFailureSequence = 0;

/** Test seam for atomic-write ambiguity: the file is synced and renamed, then the operation
 * rejects at the point where production would open/fsync the parent directory. */
export async function writeThenFailBeforeDirectorySync(path: string, data: string): Promise<void> {
  const temporary = `${path}.post-rename-fixture.${process.pid}.${++postRenameFailureSequence}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(data, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  throw new Error("fixture parent directory sync failed");
}

export async function tempFixture(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  });
  return root;
}

export function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

export interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function observedChildClose(child: ChildProcess): ChildClose | undefined {
  if (child.exitCode === null && child.signalCode === null) return undefined;
  return { code: child.exitCode, signal: child.signalCode };
}

export function observeChildClose(child: ChildProcess): Promise<ChildClose> {
  const observed = observedChildClose(child);
  if (observed) return Promise.resolve(observed);
  // Call this immediately after spawn so cleanup can await the same event even if it fires before cleanup begins.
  return once(child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null
  }));
}

export async function stopChildProcess(
  child: ChildProcess,
  closed: Promise<ChildClose>,
  description: string,
  timeoutMs = 5_000
): Promise<ChildClose> {
  const observed = observedChildClose(child);
  if (observed) return await withTimeout(closed, `${description} to close after exit`, timeoutMs);
  // The caller's exit promise was subscribed before this signal, so the event cannot be missed.
  child.kill("SIGTERM");
  try {
    return await withTimeout(closed, `${description} to close after SIGTERM`, timeoutMs);
  } catch (termError) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try {
      return await withTimeout(closed, `${description} to close after SIGKILL`, 1_000);
    } catch (killError) {
      throw new AggregateError([termError, killError], `${description} did not close after SIGTERM or SIGKILL`);
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description} after ${timeoutMs} ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description} after ${timeoutMs} ms`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
