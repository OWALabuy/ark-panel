import assert from "node:assert/strict";
import test from "node:test";
import {
  LinuxProcessSupervisor,
  type LinuxProcessIdentity
} from "./linux-process-supervisor.js";

const linuxOnly = process.platform === "linux" ? false : "Linux /proc supervision is required";

test("stop rediscovers a same-session descendant that escapes the last refresh snapshot", { skip: linuxOnly }, async () => {
  const root: LinuxProcessIdentity = {
    pid: 42_001,
    startTimeTicks: "101",
    parentPid: process.pid,
    processGroupId: 42_001,
    sessionId: 42_001
  };
  const escaped: LinuxProcessIdentity = {
    pid: 42_002,
    startTimeTicks: "102",
    parentPid: 1,
    processGroupId: 42_001,
    sessionId: 42_001
  };
  let rootAlive = true;
  let escapedAlive = false;
  let listCalls = 0;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const supervisor = new LinuxProcessSupervisor(root, {
    list: async () => {
      listCalls += 1;
      if (listCalls === 2) {
        const snapshot = rootAlive ? [root] : [];
        queueMicrotask(() => {
          rootAlive = false;
          escapedAlive = true;
        });
        return snapshot;
      }
      return [
        ...(rootAlive ? [root] : []),
        ...(escapedAlive ? [escaped] : [])
      ];
    },
    read: async pid => {
      if (pid === root.pid) return rootAlive ? root : undefined;
      if (pid === escaped.pid) return escapedAlive ? escaped : undefined;
      return undefined;
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === escaped.pid) escapedAlive = false;
    }
  });

  const result = await supervisor.stop({
    termTimeoutMs: 20,
    killTimeoutMs: 20,
    pollIntervalMs: 1
  });

  assert.deepEqual(result.diagnostics, []);
  assert.ok(signals.some(([pid]) => pid === escaped.pid), "escaped descendant was never signalled");
  assert.equal(escapedAlive, false);
  assert.ok(listCalls >= 3, "clean stop was not confirmed by a fresh full process listing");
});

test("a full-list probe failure remains fatal even after stable empty listings", { skip: linuxOnly }, async () => {
  const root: LinuxProcessIdentity = {
    pid: 42_101,
    startTimeTicks: "201",
    parentPid: process.pid,
    processGroupId: 42_101,
    sessionId: 42_101
  };
  let rootAlive = true;
  let listCalls = 0;
  const supervisor = new LinuxProcessSupervisor(root, {
    list: async () => {
      listCalls += 1;
      if (listCalls === 2) throw new Error("fixture /proc failure");
      return rootAlive ? [root] : [];
    },
    read: async pid => pid === root.pid && rootAlive ? root : undefined,
    signal: pid => { if (pid === root.pid) rootAlive = false; }
  });

  const result = await supervisor.stop({ termTimeoutMs: 30, killTimeoutMs: 30, pollIntervalMs: 1 });
  assert.ok(result.diagnostics.includes("OWNED_PROCESS_PROBE_FAILED"));
});

test("initial full-list failure retains the captured root for exact cleanup", { skip: linuxOnly }, async () => {
  const root: LinuxProcessIdentity = {
    pid: 42_151,
    startTimeTicks: "251",
    parentPid: process.pid,
    processGroupId: 42_151,
    sessionId: 42_151
  };
  let alive = true;
  let firstList = true;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const supervisor = new LinuxProcessSupervisor(root, {
    list: async () => {
      if (firstList) {
        firstList = false;
        throw new Error("initial /proc listing failed");
      }
      return alive ? [root] : [];
    },
    read: async pid => pid === root.pid && alive ? root : undefined,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    }
  });
  await supervisor.initialize();
  const result = await supervisor.stop({ termTimeoutMs: 30, killTimeoutMs: 30, pollIntervalMs: 1 });
  assert.deepEqual(signals, [[root.pid, "SIGTERM"]]);
  assert.equal(alive, false);
  assert.ok(result.diagnostics.includes("OWNED_PROCESS_PROBE_FAILED"));
});

test("a reused PID discovered during stable-empty confirmation is never signalled", { skip: linuxOnly }, async () => {
  const root: LinuxProcessIdentity = {
    pid: 42_201,
    startTimeTicks: "301",
    parentPid: process.pid,
    processGroupId: 42_201,
    sessionId: 42_201
  };
  const reused = { ...root, startTimeTicks: "302" };
  let current: LinuxProcessIdentity | undefined = root;
  let listCalls = 0;
  const signals: number[] = [];
  const supervisor = new LinuxProcessSupervisor(root, {
    list: async () => {
      listCalls += 1;
      return current ? [current] : [];
    },
    read: async pid => pid === root.pid ? current : undefined,
    signal: pid => {
      signals.push(pid);
      current = undefined;
      queueMicrotask(() => { current = reused; });
    }
  });

  const result = await supervisor.stop({ termTimeoutMs: 30, killTimeoutMs: 30, pollIntervalMs: 1 });
  assert.deepEqual(signals, [root.pid]);
  assert.ok(result.diagnostics.includes("OWNED_PROCESS_PROBE_FAILED"));
  assert.ok(result.phases.includes("OWNED_PROCESS_IDENTITY_CHANGED"));
  assert.ok(listCalls >= 3);
});
