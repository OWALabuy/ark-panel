import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCleanupController } from "./browser-cleanup.js";
import {
  attachDriverOrQuit,
  attachFixtureOrClose,
  attachOwnedProcessesOrStop
} from "./browser-startup-ownership.js";

test("fixture attach failure closes the resource created before registration", async () => {
  const controller = new BrowserCleanupController();
  controller.attachFixture(async () => {});
  let closes = 0;
  await assert.rejects(
    attachFixtureOrClose(controller, { close: async () => { closes += 1; } }, 20),
    /BROWSER_FIXTURE_ALREADY_ATTACHED/
  );
  assert.equal(closes, 1);
  await controller.cleanup();
});

test("owned-process attach failure stops the tree created before registration", async () => {
  const controller = new BrowserCleanupController();
  controller.attachOwnedProcesses(async () => ({ diagnostics: [], phases: [] }));
  let stops = 0;
  await assert.rejects(
    attachOwnedProcessesOrStop(controller, {
      stop: async () => {
        stops += 1;
        return { diagnostics: [], phases: ["OWNED_PROCESS_TERM_EXITED"] };
      }
    }, 20),
    /BROWSER_PROCESSES_ALREADY_ATTACHED/
  );
  assert.equal(stops, 1);
  await controller.cleanup();
});

test("driver attach failure sends bounded quit for its half-created session", async () => {
  const controller = new BrowserCleanupController();
  controller.attachDriver(async () => {});
  let quits = 0;
  await assert.rejects(
    attachDriverOrQuit(controller, { quit: async () => { quits += 1; } }, 20),
    /BROWSER_DRIVER_ALREADY_ATTACHED/
  );
  assert.equal(quits, 1);
  await controller.cleanup();
});
