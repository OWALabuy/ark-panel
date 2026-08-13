import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCleanupController } from "./browser-cleanup.js";

interface StartupToken {
  close(): void;
}

test("cleanup waits for startup to close and includes resources attached after cleanup begins", async () => {
  const controller = new BrowserCleanupController({
    quitTimeoutMs: 20,
    processStopTimeoutMs: 20,
    fixtureCloseTimeoutMs: 20
  });
  const startup = (controller as BrowserCleanupController & {
    beginStartup(): StartupToken;
  }).beginStartup();
  const calls: string[] = [];
  let cleanupResolved = false;
  const cleanup = controller.cleanup().then(result => {
    cleanupResolved = true;
    return result;
  });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cleanupResolved, false);

  controller.attachFixture(async () => { calls.push("fixture"); });
  controller.attachDriver(async () => { calls.push("driver"); });
  controller.attachOwnedProcesses(async () => {
    calls.push("processes");
    return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
  });
  startup.close();

  const result = await cleanup;
  assert.deepEqual(calls, ["driver", "processes", "fixture"]);
  assert.deepEqual(result.diagnostics, []);
});

test("startup failure closes its token in finally so cleanup cannot remain pending", async () => {
  const controller = new BrowserCleanupController();
  const startup = controller.beginStartup();
  try {
    throw new Error("fixture startup failed");
  } catch {}
  finally { startup.close(); }
  await controller.cleanup();
});

test("startup and resource registration are fail-closed after their one allowed use", async () => {
  const controller = new BrowserCleanupController();
  const startup = controller.beginStartup();
  assert.throws(() => controller.beginStartup(), /BROWSER_STARTUP_ALREADY_BEGUN/);
  startup.close();
  assert.throws(() => startup.close(), /BROWSER_STARTUP_ALREADY_CLOSED/);
  await controller.cleanup();
  assert.throws(() => controller.attachFixture(async () => {}), /BROWSER_FIXTURE_ALREADY_ATTACHED/);
  assert.throws(() => controller.attachDriver(async () => {}), /BROWSER_DRIVER_ALREADY_ATTACHED/);
  assert.throws(() => controller.attachOwnedProcesses(async () => ({ diagnostics: [], phases: [] })),
    /BROWSER_PROCESSES_ALREADY_ATTACHED/);
});

test("watchdog cleanup includes a late fixture and reports its cleanup failure", async () => {
  const controller = new BrowserCleanupController({ fixtureCloseTimeoutMs: 5 });
  const startup = controller.beginStartup();
  controller.armWatchdog(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.attachFixture(async () => { throw new Error("fixture close failed"); });
  startup.close();
  const result = await controller.cleanup();
  assert.deepEqual(result.diagnostics, ["SCENARIO_WATCHDOG_TRIGGERED", "FIXTURE_CLOSE_FAILED"]);
  assert.equal(result.phases[0], "SCENARIO_WATCHDOG_TRIGGERED");
});

test("watchdog cleanup includes a late driver and process supervisor", async () => {
  const controller = new BrowserCleanupController({ quitTimeoutMs: 5, processStopTimeoutMs: 20 });
  const startup = controller.beginStartup();
  const calls: string[] = [];
  controller.armWatchdog(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.attachDriver(async () => { calls.push("driver"); });
  controller.attachOwnedProcesses(async () => {
    calls.push("processes");
    return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
  });
  startup.close();
  assert.deepEqual((await controller.cleanup()).diagnostics, ["SCENARIO_WATCHDOG_TRIGGERED"]);
  assert.deepEqual(calls, ["driver", "processes"]);
});

test("watchdog cleanup stops a half-session with only an owned process supervisor", async () => {
  const controller = new BrowserCleanupController({ processStopTimeoutMs: 20 });
  const startup = controller.beginStartup();
  let stopped = false;
  controller.armWatchdog(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.attachOwnedProcesses(async () => {
    stopped = true;
    return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
  });
  startup.close();
  const result = await controller.cleanup();
  assert.equal(stopped, true);
  assert.deepEqual(result.diagnostics, ["SCENARIO_WATCHDOG_TRIGGERED"]);
  assert.ok(result.phases.includes("DRIVER_QUIT_COMPLETED"));
});

test("watchdog remains fatal even when every attached resource closes cleanly", async () => {
  const controller = new BrowserCleanupController({
    quitTimeoutMs: 20,
    processStopTimeoutMs: 20,
    fixtureCloseTimeoutMs: 20
  });
  controller.attachDriver(async () => {});
  controller.attachOwnedProcesses(async () => ({
    diagnostics: [],
    phases: ["OWNED_PROCESS_TERM_EXITED"]
  }));
  controller.attachFixture(async () => {});
  controller.armWatchdog(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const result = await controller.cleanup();
  assert.deepEqual(result.diagnostics, ["SCENARIO_WATCHDOG_TRIGGERED"]);
  assert.ok(result.phases.includes("OWNED_PROCESS_TERM_EXITED"));
  assert.ok(result.phases.includes("FIXTURE_CLOSE_COMPLETED"));
});
