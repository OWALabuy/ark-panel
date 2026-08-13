import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LinuxProcessSupervisor, readLinuxProcessIdentity } from "./linux-process-supervisor.js";
import { observeChildClose, withTimeout } from "./test-helpers.js";

const linuxOnly = process.platform === "linux" ? false : "Linux /proc supervision is required";
const launcherPath = join(process.cwd(), "test/fixtures/geckodriver-launcher.mjs");
const markerTargetPath = join(process.cwd(), "test/fixtures/launcher-marker-target.mjs");

function waitMessage(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("message", message => {
      if ((message as { type?: unknown } | null)?.type === type) resolve();
    });
    child.once("error", reject);
    child.once("close", () => reject(new Error(`launcher closed before ${type}`)));
  });
}

async function launch(t: TestContext, executable: string, args: string[]): Promise<{
  child: ChildProcess;
  supervisor: LinuxProcessSupervisor;
}> {
  const child = spawn(process.execPath, [launcherPath, executable, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const closed = observeChildClose(child);
  t.after(async () => {
    if (child.connected) child.send({ type: "ABORT" });
    try { await withTimeout(closed, "launcher fixture close", 1_000); }
    catch {}
  });
  await withTimeout(waitMessage(child, "LAUNCHER_READY"), "launcher ready", 1_000);
  if (!child.pid) throw new Error("launcher fixture pid unavailable");
  return { child, supervisor: await LinuxProcessSupervisor.captureDetachedRoot(child.pid) };
}

test("launcher creates no target before START and ABORT leaves no marker or descendant", { skip: linuxOnly }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ark-launcher-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "target-started");
  const { child, supervisor } = await launch(t, process.execPath, [markerTargetPath, marker]);
  assert.deepEqual((await supervisor.ownedIdentities()).map(identity => identity.pid), [child.pid]);
  await assert.rejects(access(marker));

  const closed = observeChildClose(child);
  child.send({ type: "ABORT" });
  await withTimeout(closed, "aborted launcher close", 1_000);
  await assert.rejects(access(marker));
  assert.equal(await readLinuxProcessIdentity(child.pid ?? -1), undefined);
});

test("captured launcher session rediscovers a child of a fast-exiting shell target", { skip: linuxOnly }, async t => {
  const { child, supervisor } = await launch(t, "/bin/sh", ["-c", "sleep 5 & child=$!; echo $child; exit 0"]);
  const targetStarted = waitMessage(child, "TARGET_STARTED");
  const childPid = new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", data => {
      const pid = Number(String(data).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) reject(new Error("shell child pid invalid"));
      else resolve(pid);
    });
  });
  child.send({ type: "START" });
  await withTimeout(targetStarted, "shell target start", 1_000);
  const pid = await withTimeout(childPid, "shell child pid", 1_000);
  const identity = await readLinuxProcessIdentity(pid);
  t.after(async () => {
    if (!identity) return;
    const current = await readLinuxProcessIdentity(identity.pid);
    if (current?.startTimeTicks === identity.startTimeTicks) process.kill(identity.pid, "SIGKILL");
  });

  const result = await supervisor.stop({ termTimeoutMs: 1_000, killTimeoutMs: 1_000, pollIntervalMs: 2 });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await readLinuxProcessIdentity(pid), undefined);
});
