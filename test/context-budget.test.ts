import test from "node:test";
import assert from "node:assert/strict";
import { ConservativeContextBudget, ContextBudgetExceededError } from "../src/domain/context-budget.js";

test("上下文预算估算稳定、包含完整历史与待发送消息", () => {
  const budget = new ConservativeContextBudget(1000, 3, 8), history = { header: { type: "session", version: 3 }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "中文 fixture" } }
  ] };
  const first = budget.estimate(history, "new message"), second = budget.estimate(history, "new message");
  assert.deepEqual(first, second); assert.equal(first.method, "utf8-bytes-upper-bound-v2"); assert.ok(first.estimatedTokens > 0); assert.equal(first.remainingTokens, 1000 - first.estimatedTokens);
  assert.ok(budget.estimate(history, "new message plus more text").estimatedTokens > first.estimatedTokens);
});

test("默认估算不低估高熵 ASCII 的 UTF-8 字节上界", () => {
  const history={header:{type:"session"},entries:[{type:"message",message:{role:"user",content:"!@#$%^&*()_+".repeat(100)}}]},budget=new ConservativeContextBudget(10000);
  const serialized=JSON.stringify(history.header)+history.entries.map(entry=>`\n${JSON.stringify(entry)}`).join("")+"\nnext";
  assert.ok(budget.estimate(history,"next").estimatedTokens>=Buffer.byteLength(serialized));
});

test("超预算时返回稳定类型、估算值和可理解提示", () => {
  const budget = new ConservativeContextBudget(20, 3, 8), history = { header: { type: "session" }, entries: [{ type: "message", message: { role: "user", content: "x".repeat(200) } }] };
  assert.throws(() => budget.assertWithinBudget(history, "next"), error => error instanceof ContextBudgetExceededError && error.code === "CONTEXT_BUDGET_EXCEEDED" && error.estimate.estimatedTokens > error.estimate.budgetTokens && /不会自动删减/.test(error.message));
});
