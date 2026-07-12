import assert from "node:assert/strict";
import test from "node:test";
import { SessionOperationCoordinator } from "../src/server/session-operation.js";

test("命令等待同会话生成完成，其他生成仍立即 SESSION_BUSY", async () => {
  const operations = new SessionOperationCoordinator(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); const order: string[] = [];
  const generation = operations.runGeneration("record", async () => { order.push("generation:start"); await gate; order.push("generation:end"); });
  await Promise.resolve();
  const command = operations.runCommand("record", async () => { order.push("command"); });
  await assert.rejects(operations.runGeneration("record", async () => {}), /SESSION_BUSY/);
  assert.deepEqual(order, ["generation:start"]); finish(); await Promise.all([generation, command]);
  assert.deepEqual(order, ["generation:start", "generation:end", "command"]);
});

test("同会话命令 FIFO 串行，不同会话可以并行", async () => {
  const operations = new SessionOperationCoordinator(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; }); const order: string[] = [];
  const first = operations.runCommand("record", async () => { order.push("first:start"); await gate; order.push("first:end"); });
  const second = operations.runCommand("record", async () => { order.push("second"); });
  await operations.runCommand("other", async () => { order.push("other"); });
  assert.deepEqual(order, ["first:start", "other"]); finish(); await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
});
