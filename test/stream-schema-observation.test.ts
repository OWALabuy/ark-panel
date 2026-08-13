import assert from "node:assert/strict";
import test from "node:test";
import { createToolSchemaCollector, observeToolSchemaFrame } from "../src/gateway/stream-schema-observation.js";

test("tool schema observation reports bounded structure without retaining values or dynamic keys", () => {
  const collector = createToolSchemaCollector("agent:fixture:temporary", "fixture-run");
  const privatePath = "/private/fixture/secret.txt", dynamicKey = "secret-dynamic-key", stdout = "private stdout 文本";
  observeToolSchemaFrame(collector, "session.tool", { runId: "fixture-run", sessionKey: "agent:fixture:temporary", seq: 10, stream: "tool",
    data: { phase: "start", toolCallId: "private-call-id", name: "private-tool-name", args: { command: "private command" } } });
  observeToolSchemaFrame(collector, "agent", { runId: "fixture-run", sessionKey: "agent:fixture:temporary", seq: 11, stream: "tool",
    data: { phase: "update", toolCallId: "private-call-id", partialResult: { text: "private partial" } } });
  const result = { content: [{ type: "text", text: "private result" }], details: { stdout, stderr: "private stderr", path: privatePath },
    [dynamicKey]: "private dynamic value", exitCode: 0 };
  observeToolSchemaFrame(collector, "agent", { runId: "fixture-run", sessionKey: "agent:fixture:temporary", seq: 12, stream: "tool",
    data: { phase: "result", toolCallId: "private-call-id", name: "private-tool-name", result, isError: false } });
  result.details.stdout = "mutated after observation";

  const report = collector.finish();
  assert.deepEqual(report.sourceCounts, { agent: 2, sessionTool: 1 });
  assert.deepEqual(report.phaseCounts, { start: 1, update: 1, terminal: 1 });
  assert.deepEqual(report.sequence, { strictlyIncreasing: true, equalCount: 0, regressionCount: 0 });
  assert.deepEqual(report.lifecycle, { startedCalls: 1, attributedUpdates: 1, attributedTerminals: 1, unattributedEvents: 0 });
  assert.deepEqual(report.events.map(event => [event.phase, event.field, event.sequenceRelation, event.sameCallAsStart]), [
    ["start", "args", "first", true], ["update", "partialResult", "after", true], ["terminal", "result", "after", true]
  ]);
  assert.deepEqual(report.events[2]?.shape?.candidateKinds, {
    content: "array", details: "object", exitCode: "number", "details.stdout": "string", "details.stderr": "string"
  });
  const encoded = JSON.stringify(report);
  for (const secret of [privatePath, dynamicKey, stdout, "private-call-id", "private-tool-name", "private command", "private partial", "private result",
    "private stderr", "mutated after observation"]) assert.equal(encoded.includes(secret), false, `report leaked ${secret}`);
  assert.throws(() => { (report.events as unknown[]).push("mutate"); }, TypeError);
  assert.throws(() => collector.report(), /collector is closed/u);
  assert.throws(() => observeToolSchemaFrame(collector, "agent", { runId: "fixture-run", sessionKey: "agent:fixture:temporary", seq: 13,
    stream: "tool", data: { phase: "result", toolCallId: "late", result: "late private value" } }), /collector is closed/u);
});

test("tool schema observation is scoped, sequence-aware, bounded, and fail-closed", () => {
  const collector = createToolSchemaCollector("agent:fixture:target", "target-run");
  const frame = (seq: number, phase: string, callId = "call") => ({ runId: "target-run", sessionKey: "agent:fixture:target", seq, stream: "tool",
    data: { phase, toolCallId: callId, result: null } });
  observeToolSchemaFrame(collector, "agent", { ...frame(1, "start"), runId: "wrong" });
  observeToolSchemaFrame(collector, "agent", { ...frame(1, "start"), sessionKey: "wrong" });
  observeToolSchemaFrame(collector, "chat", frame(1, "start"));
  observeToolSchemaFrame(collector, "agent", frame(1, "unknown"));
  observeToolSchemaFrame(collector, "agent", frame(5, "start"));
  observeToolSchemaFrame(collector, "agent", frame(5, "update"));
  observeToolSchemaFrame(collector, "agent", frame(4, "result"));
  observeToolSchemaFrame(collector, "agent", frame(6, "result", "unattributed"));
  for (let index = 0; index < 70; index++) observeToolSchemaFrame(collector, "agent", frame(7 + index, "update"));
  const report = collector.report();
  assert.equal(report.eventCount, 64); assert.equal(report.droppedEventCount, 10);
  assert.deepEqual(report.sequence, { strictlyIncreasing: false, equalCount: 1, regressionCount: 1 });
  assert.equal(report.lifecycle.unattributedEvents, 61, "terminal closes attribution for every later update");
  assert.equal(report.events[2]?.shape?.rootKind, "null");
});

test("terminal data-level result candidates exclude identities, names, and dynamic keys", () => {
  const collector = createToolSchemaCollector("agent:fixture:target", "target-run");
  observeToolSchemaFrame(collector, "session.tool", { runId: "target-run", sessionKey: "agent:fixture:target", seq: 1, stream: "tool",
    data: { phase: "start", toolCallId: "private-call", name: "private-name", args: {} } });
  observeToolSchemaFrame(collector, "session.tool", { runId: "target-run", sessionKey: "agent:fixture:target", seq: 2, stream: "tool",
    data: { phase: "result", toolCallId: "private-call", name: "private-name", stdout: "private-stdout", output: ["private-output"],
      "private-dynamic-key": "private-dynamic-value" } });
  const terminal = collector.finish().events[1];
  assert.equal(terminal?.field, "terminalData");
  assert.deepEqual(terminal?.shape?.candidateKinds, { stdout: "string", output: "array" });
  const encoded = JSON.stringify(terminal);
  for (const value of ["private-call", "private-name", "private-stdout", "private-output", "private-dynamic-key", "private-dynamic-value"])
    assert.equal(encoded.includes(value), false);
});
