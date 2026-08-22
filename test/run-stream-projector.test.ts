import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeStreamEvent } from "../src/gateway/adapter.js";
import { RunStreamProjector } from "../src/server/run-stream-projector.js";

const events: BridgeStreamEvent[] = [
  { type: "assistant_text", upstreamSeq: 1, text: "第一段", deltaText: "第一段", replace: false },
  { type: "tool", upstreamSeq: 2, callId: "one", name: "lookup", phase: "started", args: { query: "fictional" } },
  { type: "tool", upstreamSeq: 3, callId: "one", name: "lookup", phase: "completed", result: { value: "fictional" }, isError: false },
  { type: "assistant_text", upstreamSeq: 4, text: "第一段第二段", deltaText: "第二段", replace: false },
  { type: "tool", upstreamSeq: 5, callId: "two", name: "read", phase: "started" }
];

test("projects text and tool events into one deterministic timeline", () => {
  const projector = new RunStreamProjector();
  for (const event of events) projector.apply(event);
  assert.deepEqual(projector.snapshot(), {
    revision: 5,
    state: "streaming",
    text: "第一段第二段",
    tools: [
      { callId: "one", name: "lookup", phase: "completed", args: { query: "fictional" }, result: { value: "fictional" }, isError: false },
      { callId: "two", name: "read", phase: "started" }
    ],
    items: [
      { type: "text", sequence: 1, text: "第一段" },
      { type: "tool", sequence: 2, updatedSequence: 3, callId: "one", name: "lookup", phase: "completed", args: { query: "fictional" }, result: { value: "fictional" }, isError: false },
      { type: "text", sequence: 4, text: "第二段" },
      { type: "tool", sequence: 5, updatedSequence: 5, callId: "two", name: "read", phase: "started" }
    ]
  });
});

test("out-of-order delivery and exact replay converge without duplicate revisions", () => {
  const ordered = new RunStreamProjector(), shuffled = new RunStreamProjector();
  for (const event of events) ordered.apply(event);
  for (const index of [3, 1, 4, 0, 2]) shuffled.apply(events[index]!);
  const revision = shuffled.snapshot().revision;
  assert.deepEqual(shuffled.apply(events[2]!), { changed: false, conflict: false });
  assert.equal(shuffled.snapshot().revision, revision);
  assert.deepEqual({ ...shuffled.snapshot(), revision: 0 }, { ...ordered.snapshot(), revision: 0 });
});

test("a late subscription preserves the missing prefix without retaining cumulative snapshots", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "你好", deltaText: "好", replace: false });
  assert.deepEqual(projector.snapshot().items, [{ type: "text", sequence: 2, text: "你好" }]);
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "你", deltaText: "你", replace: false });
  assert.deepEqual(projector.snapshot().items, [{ type: "text", sequence: 1, text: "你好" }]);
});

test("an earlier replacement snapshot supersedes a provisional late-subscription prefix", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 4, text: "old tail", deltaText: " tail", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "replacement", deltaText: "replacement", replace: true });
  assert.equal(projector.snapshot().text, "replacement tail");
  assert.deepEqual(projector.snapshot().items, [{ type: "text", sequence: 1, text: "replacement tail" }]);
});

test("a delta after an earlier replacement does not repeat the replacement as a late prefix", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "replacement", deltaText: "replacement", replace: true });
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "replacement next", deltaText: " next", replace: false });
  assert.equal(projector.snapshot().text, "replacement next");
  assert.deepEqual(projector.snapshot().items, [{ type: "text", sequence: 1, text: "replacement next" }]);
});

test("a conflict at the earliest assistant sequence drops dependent deltas instead of inventing text", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "late tail", deltaText: " tail", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 3, text: "late tail plus", deltaText: " plus", replace: false });
  projector.apply({ type: "tool", upstreamSeq: 2, callId: "conflict", name: "bad", phase: "started" });
  assert.equal(projector.snapshot().text, "");
  assert.deepEqual(projector.snapshot().items, []);
});

test("a conflict in the middle preserves prior text but drops dependent later deltas", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "safe", deltaText: "safe", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "safe ambiguous", deltaText: " ambiguous", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 3, text: "safe ambiguous tail", deltaText: " tail", replace: false });
  projector.apply({ type: "tool", upstreamSeq: 2, callId: "conflict", name: "bad", phase: "started" });
  assert.equal(projector.snapshot().text, "safe");
  assert.deepEqual(projector.snapshot().items, [{ type: "text", sequence: 1, text: "safe" }]);
});

test("a conflicting tool sequence drops later lifecycle updates for the affected call", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "tool", upstreamSeq: 1, callId: "one", name: "lookup", phase: "started" });
  projector.apply({ type: "tool", upstreamSeq: 3, callId: "one", name: "lookup", phase: "completed" });
  projector.apply({ type: "tool", upstreamSeq: 1, callId: "other", name: "bad", phase: "started" });
  assert.deepEqual(projector.snapshot().items, []);
  assert.deepEqual(projector.snapshot().tools, []);
});

test("a cross-type sequence conflict drops both assistant dependants and tool lifecycle dependants", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "tool", upstreamSeq: 1, callId: "one", name: "lookup", phase: "started" });
  projector.apply({ type: "tool", upstreamSeq: 3, callId: "one", name: "lookup", phase: "completed" });
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "ambiguous", deltaText: "ambiguous", replace: false });
  assert.deepEqual(projector.snapshot().items, []);
  assert.deepEqual(projector.snapshot().tools, []);
  assert.equal(projector.snapshot().text, "");
});

test("a normal initial delta replays with its captured empty prefix", () => {
  const projector = new RunStreamProjector();
  const event = { type: "assistant_text", upstreamSeq: 1, text: "first", deltaText: "first", replace: false } as const;
  assert.deepEqual(projector.apply(event), { changed: true, conflict: false });
  assert.deepEqual(projector.apply(event), { changed: false, conflict: false });
});

test("the first normal delta keeps an explicit empty prefix in replay identity", () => {
  const emptyPrefix = new RunStreamProjector();
  emptyPrefix.apply({ type: "assistant_text", upstreamSeq: 1, text: "x", deltaText: "x", replace: false });
  assert.deepEqual(emptyPrefix.apply({ type: "assistant_text", upstreamSeq: 1, text: "different-x", deltaText: "x", replace: false }), { changed: true, conflict: true });
  assert.equal(emptyPrefix.snapshot().text, "");

  const nonemptyPrefix = new RunStreamProjector();
  nonemptyPrefix.apply({ type: "assistant_text", upstreamSeq: 1, text: "prefix-x", deltaText: "x", replace: false });
  assert.deepEqual(nonemptyPrefix.apply({ type: "assistant_text", upstreamSeq: 1, text: "x", deltaText: "x", replace: false }), { changed: true, conflict: true });
  assert.equal(nonemptyPrefix.snapshot().text, "");
});

test("many ordered tool events use constant indexed lookups rather than scanning the timeline", () => {
  let lookups = 0;
  const projector = new RunStreamProjector({ onToolIndexLookup: () => { lookups++; } });
  const count = 2_000;
  for (let index = 0; index < count; index++) projector.apply({
    type: "tool", upstreamSeq: index * 2, callId: `call-${index}`, name: "lookup", phase: "started", args: { index }
  });
  for (let index = 0; index < count; index++) projector.apply({
    type: "tool", upstreamSeq: count * 2 + index, callId: `call-${index}`, name: "lookup", phase: "completed"
  });
  assert.equal(lookups, count * 4);
  assert.equal(projector.snapshot().items.length, count);
  assert.equal(projector.snapshot().tools.every(tool => tool.phase === "completed"), true);
});

test("normal deltas normalize redundant cumulative snapshots out of replay identity", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "first", deltaText: "first", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "first tail", deltaText: " tail", replace: false });
  const revision = projector.snapshot().revision;
  assert.deepEqual(projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "other tail", deltaText: " tail", replace: false }), { changed: false, conflict: false });
  assert.equal(projector.snapshot().revision, revision);
  assert.equal(projector.snapshot().text, "first tail");
});

test("many ordered assistant deltas and exact replays stay on the append and normalized replay paths", () => {
  let rebuilds = 0;
  const projector = new RunStreamProjector({ onProjectionRebuild: () => { rebuilds++; } });
  const count = 2_000;
  let text = "";
  const timeline: BridgeStreamEvent[] = [];
  for (let index = 0; index < count; index++) {
    text += "x";
    timeline.push({ type: "assistant_text", upstreamSeq: index, text, deltaText: "x", replace: false });
  }
  for (const event of timeline) projector.apply(event);
  const revision = projector.snapshot().revision;
  for (const event of timeline) assert.deepEqual(projector.apply(event), { changed: false, conflict: false });
  assert.equal(rebuilds, 0);
  assert.equal(projector.snapshot().revision, revision);
  assert.equal(projector.snapshot().text.length, count);
});

test("snapshot degradation compacts prior assistant events and rejects a colliding later tool", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "first", deltaText: "first", replace: false });
  projector.apply({ type: "tool", upstreamSeq: 2, callId: "one", name: "lookup", phase: "started" });
  projector.apply({ type: "assistant_text", upstreamSeq: 3, text: "replacement", deltaText: "", replace: false });
  assert.equal(projector.snapshot().text, "replacement");
  assert.deepEqual(projector.apply({ type: "tool", upstreamSeq: 1, callId: "collision", name: "bad", phase: "started" }), { changed: false, conflict: true });
  assert.equal(projector.snapshot().items.some(item => item.type === "tool" && item.callId === "collision"), false);
});

test("consecutive text coalesces and a tool lifecycle update keeps its original position", () => {
  const projector = new RunStreamProjector();
  projector.apply({ type: "assistant_text", upstreamSeq: 1, text: "a", deltaText: "a", replace: false });
  projector.apply({ type: "assistant_text", upstreamSeq: 2, text: "ab", deltaText: "b", replace: false });
  projector.apply({ type: "tool", upstreamSeq: 3, callId: "one", name: "lookup", phase: "started" });
  projector.apply({ type: "assistant_text", upstreamSeq: 4, text: "abc", deltaText: "c", replace: false });
  projector.apply({ type: "tool", upstreamSeq: 5, callId: "one", name: "lookup", phase: "failed" });
  assert.deepEqual(projector.snapshot().items, [
    { type: "text", sequence: 1, text: "ab" },
    { type: "tool", sequence: 3, updatedSequence: 5, callId: "one", name: "lookup", phase: "failed" },
    { type: "text", sequence: 4, text: "c" }
  ]);
});

test("conflicting payloads for one sequence fail closed and disconnect only degrades the preview", () => {
  const projector = new RunStreamProjector();
  projector.apply(events[0]!);
  assert.deepEqual(projector.apply({ type: "tool", upstreamSeq: 1, callId: "conflict", name: "bad", phase: "started" }), { changed: true, conflict: true });
  assert.deepEqual(projector.snapshot().items, []);
  assert.deepEqual(projector.apply(events[0]!), { changed: false, conflict: false });
  projector.apply(events[1]!);
  projector.apply({ type: "connection", state: "disconnected" });
  assert.equal(projector.snapshot().state, "degraded");
  assert.equal(projector.snapshot().items[0]?.type, "tool");
});

test("replacement snapshots use an explicit single-text degradation without inventing interleaving", () => {
  const projector = new RunStreamProjector();
  projector.apply(events[0]!);
  projector.apply(events[1]!);
  projector.apply({ type: "assistant_text", upstreamSeq: 4, text: "replacement", deltaText: "replacement", replace: true });
  assert.equal(projector.snapshot().text, "replacement");
  assert.deepEqual(projector.snapshot().items, [
    { type: "tool", sequence: 2, updatedSequence: 2, callId: "one", name: "lookup", phase: "started", args: { query: "fictional" } },
    { type: "text", sequence: 4, text: "replacement" }
  ]);
});
