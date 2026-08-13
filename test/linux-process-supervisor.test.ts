import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test, { type TestContext } from "node:test";
import {
  LinuxProcessSupervisor,
  readLinuxProcessIdentity,
  type LinuxProcessIdentity
} from "./linux-process-supervisor.js";
import { observeChildClose, withTimeout } from "./test-helpers.js";

const linuxOnly = process.platform === "linux" ? false : "Linux /proc supervision is required";

function readyChild(source: string): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const ready = new Promise<string>((resolve, reject) => {
    child.once("error", () => reject(new Error("fixture child spawn failed")));
    child.stdout?.once("data", chunk => resolve(String(chunk).trim()));
  });
  return { child, ready };
}

async function exactFallbackKill(identity: LinuxProcessIdentity | undefined): Promise<void> {
  if (!identity) return;
  const current = await readLinuxProcessIdentity(identity.pid);
  if (current?.startTimeTicks !== identity.startTimeTicks) return;
  try { process.kill(identity.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function captureFixture(t: TestContext, child: ChildProcess): Promise<LinuxProcessSupervisor> {
  if (!child.pid) throw new Error("fixture child pid unavailable");
  const identity = await readLinuxProcessIdentity(child.pid);
  t.after(() => exactFallbackKill(identity));
  return LinuxProcessSupervisor.captureDetachedRoot(child.pid);
}

test("supervisor waits for SIGKILL to remove an owned TERM-resistant child", { skip: linuxOnly }, async t => {
  const fixture = readyChild(`
    process.on("SIGTERM", () => {});
    process.stdout.write("ready\\n");
    setTimeout(() => process.exit(0), 10_000);
  `);
  const supervisor = await captureFixture(t, fixture.child);
  await withTimeout(fixture.ready, "TERM-resistant fixture readiness", 1_000);

  const result = await supervisor.stop({ termTimeoutMs: 20, killTimeoutMs: 1_000, pollIntervalMs: 2 });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.phases.includes("OWNED_PROCESS_TERM_TIMED_OUT"));
  assert.ok(result.phases.includes("OWNED_PROCESS_KILL_EXITED"));
  assert.equal(await readLinuxProcessIdentity(supervisor.rootIdentity.pid), undefined);
});

test("identity mismatch never signals a reused PID", { skip: linuxOnly }, async t => {
  const fixture = readyChild(`
    process.on("SIGTERM", () => process.exit(23));
    process.stdout.write("ready\\n");
    setTimeout(() => process.exit(0), 10_000);
  `);
  await withTimeout(fixture.ready, "identity fixture readiness", 1_000);
  if (!fixture.child.pid) throw new Error("fixture child pid unavailable");
  const real = await readLinuxProcessIdentity(fixture.child.pid);
  if (!real) throw new Error("fixture child identity unavailable");
  t.after(() => exactFallbackKill(real));
  const closed = observeChildClose(fixture.child);
  const forged = { ...real, startTimeTicks: String(BigInt(real.startTimeTicks) + 1n) };
  const supervisor = new LinuxProcessSupervisor(forged);

  const result = await supervisor.stop({ termTimeoutMs: 1_000, killTimeoutMs: 1_000, pollIntervalMs: 1 });
  const stillRunning = await readLinuxProcessIdentity(real.pid);
  assert.equal(stillRunning?.startTimeTicks, real.startTimeTicks);
  assert.ok(result.phases.includes("OWNED_PROCESS_IDENTITY_CHANGED"));
  assert.deepEqual(result.diagnostics, ["OWNED_PROCESS_PROBE_FAILED"]);
  await exactFallbackKill(real);
  await withTimeout(closed.then(() => undefined), "identity fixture close", 1_000);
});

test("supervisor reports an owned identity that survives TERM and KILL", { skip: linuxOnly }, async () => {
  const root: LinuxProcessIdentity = {
    pid: 41_001,
    startTimeTicks: "101",
    parentPid: process.pid,
    processGroupId: 41_001,
    sessionId: 41_001
  };
  const signals: NodeJS.Signals[] = [];
  const supervisor = new LinuxProcessSupervisor(root, {
    list: async () => [root],
    read: async () => root,
    signal: (_pid, signal) => { signals.push(signal); }
  });

  const result = await supervisor.stop({ termTimeoutMs: 2, killTimeoutMs: 2, pollIntervalMs: 1 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result.diagnostics, ["OWNED_PROCESS_REMAINED"]);
  assert.ok(result.phases.includes("OWNED_PROCESS_KILL_TIMED_OUT"));
});

test("supervisor retains and kills a reparented process-group member", { skip: linuxOnly }, async t => {
  const fixture = readyChild(`
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", String.raw\`
      process.on("SIGTERM", () => {});
      setTimeout(() => process.exit(0), 10_000);
    \`], { stdio: "ignore" });
    child.unref();
    process.stdout.write(String(child.pid) + "\\n");
    setTimeout(() => process.exit(0), 50);
  `);
  const rootClosed = observeChildClose(fixture.child);
  const supervisor = await captureFixture(t, fixture.child);
  const memberPid = Number(await withTimeout(fixture.ready, "process-group member readiness", 1_000));
  if (!Number.isSafeInteger(memberPid) || memberPid <= 0) throw new Error("fixture member pid invalid");
  await supervisor.refresh();
  assert.equal(await supervisor.owns(memberPid), true);
  const memberIdentity = await readLinuxProcessIdentity(memberPid);
  t.after(() => exactFallbackKill(memberIdentity));
  await withTimeout(rootClosed.then(() => undefined), "fixture root close", 1_000);
  assert.equal(await supervisor.owns(memberPid), true);

  const result = await supervisor.stop({ termTimeoutMs: 20, killTimeoutMs: 1_000, pollIntervalMs: 2 });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.phases.includes("OWNED_PROCESS_KILL_EXITED"));
  assert.equal(await readLinuxProcessIdentity(memberPid), undefined);
});

test("stop rediscovers and removes a reparented shell descendant after its root exits", { skip: linuxOnly }, async t => {
  const fixture = readyChild(`
    const { spawn } = require("node:child_process");
    const root = spawn("/bin/sh", ["-c", "sleep 5 & child=$!; echo $child; exit 0"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    root.stdout.once("data", data => process.stdout.write(String(root.pid) + ":" + String(data).trim() + "\\n"));
    root.unref();
    setTimeout(() => process.exit(0), 10_000);
  `);
  const pair = await withTimeout(fixture.ready, "shell descendant readiness", 1_000);
  const [rootText, childText] = pair.split(":");
  const rootPid = Number(rootText);
  const childPid = Number(childText);
  if (!Number.isSafeInteger(rootPid) || !Number.isSafeInteger(childPid)) {
    throw new Error("shell descendant fixture pid invalid");
  }
  const childIdentity = await readLinuxProcessIdentity(childPid);
  t.after(() => exactFallbackKill(childIdentity));
  let rootIdentity = await readLinuxProcessIdentity(rootPid);
  for (let attempt = 0; !rootIdentity && attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
    rootIdentity = await readLinuxProcessIdentity(rootPid);
  }
  // The shell is allowed to have exited before capture; reconstruct the safe
  // detached-root identity only from the still-owned child's session/group.
  const child = await readLinuxProcessIdentity(childPid);
  if (!child) throw new Error("shell descendant exited before supervision");
  const root: LinuxProcessIdentity = rootIdentity ?? {
    pid: rootPid,
    startTimeTicks: "1",
    parentPid: process.pid,
    processGroupId: child.processGroupId,
    sessionId: child.sessionId
  };
  const supervisor = new LinuxProcessSupervisor(root);

  const result = await supervisor.stop({ termTimeoutMs: 1_000, killTimeoutMs: 1_000, pollIntervalMs: 2 });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await readLinuxProcessIdentity(childPid), undefined);
});
