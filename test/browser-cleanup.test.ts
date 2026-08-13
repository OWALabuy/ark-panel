import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCleanupController, cleanupOwnedBrowser } from "./browser-cleanup.js";
import { deferred } from "./test-helpers.js";

const fastTimeouts = { quitTimeoutMs: 5, processStopTimeoutMs: 20 };

test("browser cleanup accepts a timed-out quit after the owned tree exits", async () => {
  const result = await cleanupOwnedBrowser({
    quit: () => new Promise(() => {}),
    stopOwnedProcesses: async () => ({
      diagnostics: [],
      phases: ["OWNED_PROCESS_TERM_SENT", "OWNED_PROCESS_TERM_EXITED"]
    })
  }, fastTimeouts);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.phases, [
    "DRIVER_QUIT_TIMED_OUT",
    "OWNED_PROCESS_TERM_SENT",
    "OWNED_PROCESS_TERM_EXITED"
  ]);
});

test("browser cleanup accepts rejected HTTP quit when the owned tree is gone", async () => {
  const result = await cleanupOwnedBrowser({
    quit: async () => { throw new Error("fixture quit rejection"); },
    stopOwnedProcesses: async () => ({ diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] })
  }, fastTimeouts);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.phases, ["DRIVER_QUIT_REJECTED", "OWNED_PROCESS_TERM_EXITED"]);
});

test("browser cleanup reports a final owned process residual", async () => {
  const result = await cleanupOwnedBrowser({
    quit: async () => {},
    stopOwnedProcesses: async () => ({
      diagnostics: ["OWNED_PROCESS_REMAINED"],
      phases: ["OWNED_PROCESS_KILL_TIMED_OUT"]
    })
  }, fastTimeouts);

  assert.deepEqual(result.diagnostics, ["OWNED_PROCESS_REMAINED"]);
  assert.deepEqual(result.phases, ["DRIVER_QUIT_COMPLETED", "OWNED_PROCESS_KILL_TIMED_OUT"]);
});

test("late quit is observed while idempotent cleanup stops owned processes once", async () => {
  const quit = deferred();
  let stopCalls = 0;
  const controller = new BrowserCleanupController(fastTimeouts);
  controller.attachDriver(() => quit.promise);
  controller.attachOwnedProcesses(async () => {
    stopCalls += 1;
    return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
  });

  const first = await controller.cleanup();
  assert.deepEqual(first.diagnostics, []);
  assert.equal(stopCalls, 1);
  quit.reject(new Error("late fixture quit rejection"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.strictEqual(await controller.cleanup(), first);
  assert.equal(stopCalls, 1);
});

test("scenario watchdog starts cleanup before a stalled callback can finish", async () => {
  const controller = new BrowserCleanupController(fastTimeouts);
  let stopped = false;
  controller.attachDriver(() => new Promise(() => {}));
  controller.attachOwnedProcesses(async () => {
    stopped = true;
    return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
  });
  controller.armWatchdog(2);

  await new Promise(resolve => setTimeout(resolve, 10));
  const result = await controller.cleanup();
  assert.equal(stopped, true);
  assert.equal(result.phases[0], "SCENARIO_WATCHDOG_TRIGGERED");
});

test("fixture cleanup has its own bounded diagnostic", async () => {
  const controller = new BrowserCleanupController({ ...fastTimeouts, fixtureCloseTimeoutMs: 2 });
  controller.attachFixture(() => new Promise(() => {}));
  const result = await controller.cleanup();
  assert.deepEqual(result.diagnostics, ["FIXTURE_CLOSE_FAILED"]);
  assert.deepEqual(result.phases, ["FIXTURE_CLOSE_FAILED"]);
});
