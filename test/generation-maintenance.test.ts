import test from "node:test";
import assert from "node:assert/strict";
import { startGenerationMaintenance, type GenerationMaintenanceOptions } from "../src/server/generation-maintenance.js";

function fakeTimer() {
  let tick: () => void = () => {}, clears = 0;
  const timerState = { unrefCalls: 0 };
  const timer = { unref() { timerState.unrefCalls += 1; } } as unknown as NodeJS.Timeout;
  const options: Pick<GenerationMaintenanceOptions, "setInterval" | "clearInterval"> = {
    setInterval: ((callback: () => void, interval: number) => {
      assert.equal(interval, 6 * 60 * 60 * 1000); tick = callback; return timer;
    }) as typeof globalThis.setInterval,
    clearInterval: (value => { assert.equal(value, timer); clears += 1; }) as typeof globalThis.clearInterval
  };
  return { options, tick: () => tick(), clears: () => clears, timer: timerState };
}

test("generation maintenance 固定按 run 后 attachment 的顺序执行", async () => {
  const clock = fakeTimer(), calls: string[] = [];
  const maintenance = startGenerationMaintenance({
    maintainRuns: async () => { calls.push("runs"); },
    maintainAttachments: async () => { calls.push("attachments"); }
  }, clock.options);
  assert.equal(clock.timer.unrefCalls, 1);
  assert.equal(await maintenance.runNow(), true);
  assert.deepEqual(calls, ["runs", "attachments"]);
  maintenance.stop();
});

test("generation maintenance 跳过重入批次", async () => {
  const clock = fakeTimer(), calls: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const maintenance = startGenerationMaintenance({
    maintainRuns: async () => { calls.push("runs"); await blocked; },
    maintainAttachments: async () => { calls.push("attachments"); }
  }, clock.options);
  const first = maintenance.runNow();
  assert.equal(await maintenance.runNow(), false);
  clock.tick();
  assert.deepEqual(calls, ["runs"]);
  release(); assert.equal(await first, true);
  assert.deepEqual(calls, ["runs", "attachments"]);
  maintenance.stop();
});

test("run 维护失败仍执行附件维护且日志固定脱敏", async () => {
  const clock = fakeTimer(), calls: string[] = [], logs: string[] = [];
  const maintenance = startGenerationMaintenance({
    maintainRuns: async () => { calls.push("runs"); throw new Error("private-path-and-message-canary"); },
    maintainAttachments: async () => { calls.push("attachments"); throw new Error("credential-canary"); }
  }, { ...clock.options, log: message => logs.push(message) });
  assert.equal(await maintenance.runNow(), true);
  assert.deepEqual(calls, ["runs", "attachments"]);
  assert.deepEqual(logs, [
    "[ark-panel] run retention maintenance failed (RUN_RETENTION_MAINTENANCE_FAILED)",
    "[ark-panel] attachment maintenance failed (ATTACHMENT_MAINTENANCE_FAILED)"
  ]);
  assert.equal(logs.join(" ").includes("canary"), false);
  maintenance.stop();
});

test("stop 幂等取消 timer 并禁止后续批次", async () => {
  const clock = fakeTimer(), calls: string[] = [];
  const maintenance = startGenerationMaintenance({
    maintainRuns: async () => { calls.push("runs"); },
    maintainAttachments: async () => { calls.push("attachments"); }
  }, clock.options);
  maintenance.stop(); maintenance.stop(); clock.tick();
  assert.equal(await maintenance.runNow(), false);
  assert.equal(clock.clears(), 1); assert.deepEqual(calls, []);
});
