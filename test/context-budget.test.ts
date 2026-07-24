import test from "node:test";
import assert from "node:assert/strict";
import { ConservativeContextBudget, ContextBudgetExceededError, effectiveContextMessages } from "../src/domain/context-budget.js";

test("上下文预算估算稳定、包含完整历史与待发送消息", () => {
  const budget = new ConservativeContextBudget(1000, 3, 8), history = { header: { type: "session", version: 3 }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "中文 fixture" } }
  ] };
  const first = budget.estimate(history, "new message"), second = budget.estimate(history, "new message");
  assert.deepEqual(first, second); assert.equal(first.method, "utf8-bytes-upper-bound-v3"); assert.ok(first.estimatedTokens > 0); assert.equal(first.remainingTokens, 1000 - first.estimatedTokens);
  assert.ok(budget.estimate(history, "new message plus more text").estimatedTokens > first.estimatedTokens);
});

test("默认估算不低估高熵 ASCII 的 UTF-8 字节上界", () => {
  const history={header:{type:"session"},entries:[{type:"message",message:{role:"user",content:"!@#$%^&*()_+".repeat(100)}}]},budget=new ConservativeContextBudget(10000);
  const serialized=JSON.stringify(history.header)+effectiveContextMessages(history).map(message=>`\n${JSON.stringify(message)}`).join("")+"\nnext";
  assert.ok(budget.estimate(history,"next").estimatedTokens>=Buffer.byteLength(serialized));
});

test("超预算时返回稳定类型、估算值和可理解提示", () => {
  const budget = new ConservativeContextBudget(20, 3, 8), history = { header: { type: "session" }, entries: [{ type: "message", message: { role: "user", content: "x".repeat(200) } }] };
  assert.throws(() => budget.assertWithinBudget(history, "next"), error => error instanceof ContextBudgetExceededError && error.code === "CONTEXT_BUDGET_EXCEEDED" && error.estimate.estimatedTokens > error.estimate.budgetTokens && /不会静默删减/.test(error.message));
});

test("最新 compaction 使用摘要、inclusive kept tail 与压缩后消息构造有效上下文", () => {
  const history={header:{type:"session"},entries:[
    {type:"message",id:"old",parentId:null,message:{role:"user",content:"x".repeat(2000)}},
    {type:"message",id:"kept",parentId:"old",message:{role:"assistant",content:"kept"}},
    {type:"compaction",id:"c1",parentId:"kept",timestamp:"2026-07-24T00:00:00Z",summary:"first summary",firstKeptEntryId:"kept",tokensBefore:2000},
    {type:"message",id:"post",parentId:"c1",message:{role:"user",content:"post"}},
    {type:"compaction",id:"c2",parentId:"post",timestamp:"2026-07-24T01:00:00Z",summary:"latest summary",firstKeptEntryId:"post",tokensBefore:100},
    {type:"message",id:"after",parentId:"c2",message:{role:"assistant",content:"after"}}
  ]};
  const messages=effectiveContextMessages(history);
  assert.equal(messages.length,3); assert.match(JSON.stringify(messages[0]),/latest summary/);
  assert.doesNotMatch(JSON.stringify(messages),/first summary|x{20}|kept/);
  assert.match(JSON.stringify(messages[1]),/post/); assert.match(JSON.stringify(messages[2]),/after/);
  assert.ok(new ConservativeContextBudget(10000).estimate(history,"").estimatedTokens <
    new ConservativeContextBudget(10000).estimate({header:history.header,entries:history.entries.slice(0,2)},"").estimatedTokens);
});

test("hardened self boundary 只保留摘要，custom_message 与非空 branch_summary 按上游语义进入上下文", () => {
  const history={header:{type:"session"},entries:[
    {type:"message",id:"u",parentId:null,message:{role:"user",content:"old"}},
    {type:"compaction",id:"c",parentId:"u",timestamp:"2026-07-24T00:00:00Z",summary:"summary",firstKeptEntryId:"c",tokensBefore:10},
    {type:"custom_message",id:"custom",parentId:"c",timestamp:"2026-07-24T00:01:00Z",content:"custom content",details:"must not count"},
    {type:"branch_summary",id:"branch",parentId:"custom",timestamp:"2026-07-24T00:02:00Z",summary:"branch content"},
    {type:"branch_summary",id:"empty",parentId:"branch",summary:""}
  ]};
  const serialized=JSON.stringify(effectiveContextMessages(history));
  assert.match(serialized,/summary/); assert.match(serialized,/custom content/); assert.match(serialized,/branch content/);
  assert.doesNotMatch(serialized,/must not count|\"old\"/); assert.equal(effectiveContextMessages(history).length,3);
});

test("预算只计算 current branch，巨大摘要或待发送文本仍会超限", () => {
  const history={header:{type:"session"},entries:[
    {type:"message",id:"root",parentId:null,message:{role:"user",content:"root"}},
    {type:"message",id:"side",parentId:"root",appendMode:"side",message:{role:"assistant",content:"z".repeat(5000)}},
    {type:"message",id:"main",parentId:"root",message:{role:"assistant",content:"main"}},
    {type:"compaction",id:"compact",parentId:"main",summary:"s".repeat(1000),firstKeptEntryId:"compact",tokensBefore:12}
  ]}, budget=new ConservativeContextBudget(400);
  assert.doesNotMatch(JSON.stringify(effectiveContextMessages(history)),/z{20}/);
  assert.throws(()=>budget.assertWithinBudget(history,""),ContextBudgetExceededError);
  const small={...history,entries:history.entries.map(entry=>entry.id==="compact"?{...entry,summary:"short"}:entry)};
  assert.throws(()=>budget.assertWithinBudget(small,"n".repeat(1000)),ContextBudgetExceededError);
});
