const MAX_EVENTS = 64;
const MAX_NODES = 10_000;
const MAX_DEPTH = 16;

type JsonKind = "array" | "boolean" | "null" | "number" | "object" | "string" | "unsupported";
type ToolPhase = "start" | "update" | "terminal";
type SequenceRelation = "after" | "before" | "equal" | "first";

export interface ToolValueShape {
  rootKind: JsonKind;
  serializedBytes: number | null;
  nodeCount: number;
  objectKeyCount: number;
  arrayItemCount: number;
  stringCount: number;
  stringBytes: number;
  largestStringBytes: number;
  maxDepth: number;
  truncated: boolean;
  candidateKinds: Readonly<Record<string, JsonKind>>;
}

export interface ToolSchemaEventShape {
  source: "agent" | "session.tool";
  phase: ToolPhase;
  sequenceRelation: SequenceRelation;
  sameCallAsStart: boolean;
  namePresent: boolean;
  isError: boolean | null;
  field: "args" | "partialResult" | "result" | "none";
  shape?: ToolValueShape;
}

export interface ToolSchemaReport {
  eventCount: number;
  droppedEventCount: number;
  sourceCounts: Readonly<{ agent: number; sessionTool: number }>;
  phaseCounts: Readonly<{ start: number; update: number; terminal: number }>;
  sequence: Readonly<{ strictlyIncreasing: boolean; equalCount: number; regressionCount: number }>;
  lifecycle: Readonly<{ startedCalls: number; attributedUpdates: number; attributedTerminals: number; unattributedEvents: number }>;
  events: readonly ToolSchemaEventShape[];
}

export interface ToolSchemaCollector {
  report(): ToolSchemaReport;
  finish(): ToolSchemaReport;
}

interface CollectorState {
  sessionKey: string;
  runId: string;
  events: ToolSchemaEventShape[];
  droppedEventCount: number;
  sourceCounts: { agent: number; sessionTool: number };
  phaseCounts: { start: number; update: number; terminal: number };
  previousSequence: number | undefined;
  equalCount: number;
  regressionCount: number;
  calls: Set<string>;
  startedCalls: number;
  attributedUpdates: number;
  attributedTerminals: number;
  unattributedEvents: number;
}

const states = new WeakMap<ToolSchemaCollector, CollectorState>();
const CANDIDATE_PATHS = ["content", "details", "text", "stdout", "stderr", "output", "aggregated", "exitCode",
  "details.content", "details.text", "details.stdout", "details.stderr", "details.output", "details.aggregated", "details.exitCode"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function kind(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "unsupported";
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    const currentRecord = record(current);
    if (!currentRecord || !Object.prototype.hasOwnProperty.call(currentRecord, part)) return undefined;
    current = currentRecord[part];
  }
  return current;
}

function shapeOf(value: unknown): ToolValueShape {
  let serializedBytes: number | null = null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) serializedBytes = Buffer.byteLength(encoded, "utf8");
  } catch { /* direct unit inputs may be cyclic; authenticated WebSocket JSON cannot be */ }
  const totals = { nodeCount: 0, objectKeyCount: 0, arrayItemCount: 0, stringCount: 0, stringBytes: 0,
    largestStringBytes: 0, maxDepth: 0, truncated: false };
  const visit = (current: unknown, depth: number): void => {
    if (totals.nodeCount >= MAX_NODES || depth > MAX_DEPTH) { totals.truncated = true; return; }
    totals.nodeCount++; totals.maxDepth = Math.max(totals.maxDepth, depth);
    if (typeof current === "string") {
      const bytes = Buffer.byteLength(current, "utf8"); totals.stringCount++; totals.stringBytes += bytes;
      totals.largestStringBytes = Math.max(totals.largestStringBytes, bytes); return;
    }
    if (Array.isArray(current)) {
      totals.arrayItemCount += current.length;
      for (const item of current) { if (totals.nodeCount >= MAX_NODES) { totals.truncated = true; break; } visit(item, depth + 1); }
      return;
    }
    const currentRecord = record(current); if (!currentRecord) return;
    const values = Object.values(currentRecord); totals.objectKeyCount += values.length;
    for (const item of values) { if (totals.nodeCount >= MAX_NODES) { totals.truncated = true; break; } visit(item, depth + 1); }
  };
  visit(value, 0);
  const candidateKinds: Record<string, JsonKind> = {};
  for (const path of CANDIDATE_PATHS) {
    const candidate = valueAtPath(value, path); if (candidate !== undefined) candidateKinds[path] = kind(candidate);
  }
  return Object.freeze({ rootKind: kind(value), serializedBytes, ...totals, candidateKinds: Object.freeze(candidateKinds) });
}

function immutableReport(state: CollectorState): ToolSchemaReport {
  return Object.freeze({ eventCount: state.events.length, droppedEventCount: state.droppedEventCount,
    sourceCounts: Object.freeze({ ...state.sourceCounts }), phaseCounts: Object.freeze({ ...state.phaseCounts }),
    sequence: Object.freeze({ strictlyIncreasing: state.equalCount === 0 && state.regressionCount === 0,
      equalCount: state.equalCount, regressionCount: state.regressionCount }),
    lifecycle: Object.freeze({ startedCalls: state.startedCalls, attributedUpdates: state.attributedUpdates,
      attributedTerminals: state.attributedTerminals, unattributedEvents: state.unattributedEvents }),
    events: Object.freeze(state.events.map(event => Object.freeze({ ...event }))) });
}

export function createToolSchemaCollector(sessionKey: string, runId: string): ToolSchemaCollector {
  if (!nonEmpty(sessionKey) || !nonEmpty(runId)) throw new Error("tool schema collector requires an exact session and run");
  const current = (): CollectorState => { const state = states.get(collector); if (!state) throw new Error("tool schema collector is closed"); return state; };
  const collector: ToolSchemaCollector = Object.freeze({ report: () => immutableReport(current()), finish: () => {
    const report = immutableReport(current()); states.delete(collector); return report;
  } });
  states.set(collector, { sessionKey, runId, events: [], droppedEventCount: 0, sourceCounts: { agent: 0, sessionTool: 0 },
    phaseCounts: { start: 0, update: 0, terminal: 0 }, previousSequence: undefined, equalCount: 0, regressionCount: 0,
    calls: new Set(), startedCalls: 0, attributedUpdates: 0, attributedTerminals: 0, unattributedEvents: 0 });
  return collector;
}

/** Internal observer bridge. Raw payloads are reduced here and are never passed to a caller callback. */
export function observeToolSchemaFrame(collector: ToolSchemaCollector, eventName: string, rawPayload: unknown): void {
  const state = states.get(collector);
  if (!state) throw new Error("tool schema collector is closed");
  const payload = record(rawPayload), data = record(payload?.data);
  if (!payload || !data || payload.sessionKey !== state.sessionKey || payload.runId !== state.runId || payload.stream !== "tool" ||
    (eventName !== "agent" && eventName !== "session.tool")) return;
  const sequence = payload.seq, rawPhase = data.phase, callId = nonEmpty(data.toolCallId) ?? nonEmpty(data.callId);
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || !callId || typeof rawPhase !== "string") return;
  const phase: ToolPhase | undefined = rawPhase === "start" ? "start" : rawPhase === "update" ? "update" :
    ["result", "end", "error"].includes(rawPhase) ? "terminal" : undefined;
  if (!phase) return;
  if (state.events.length >= MAX_EVENTS) { state.droppedEventCount++; return; }
  const previous = state.previousSequence, sequenceRelation: SequenceRelation = previous === undefined ? "first" :
    Number(sequence) > previous ? "after" : Number(sequence) === previous ? "equal" : "before";
  if (sequenceRelation === "equal") state.equalCount++;
  if (sequenceRelation === "before") state.regressionCount++;
  state.previousSequence = Number(sequence);
  const sameCallAsStart = state.calls.has(callId);
  if (phase === "start") { if (!sameCallAsStart) { state.calls.add(callId); state.startedCalls++; } }
  else if (sameCallAsStart) { if (phase === "update") state.attributedUpdates++; else state.attributedTerminals++; }
  else state.unattributedEvents++;
  const field = phase === "start" && data.args !== undefined ? "args" : phase === "update" && data.partialResult !== undefined ? "partialResult" :
    phase === "terminal" && data.result !== undefined ? "result" : "none";
  const value = field === "none" ? undefined : data[field];
  const event: ToolSchemaEventShape = Object.freeze({ source: eventName, phase, sequenceRelation,
    sameCallAsStart: phase === "start" ? true : sameCallAsStart, namePresent: Boolean(nonEmpty(data.name) ?? nonEmpty(data.toolName)),
    isError: typeof data.isError === "boolean" ? data.isError : null, field, ...(field === "none" ? {} : { shape: shapeOf(value) }) });
  state.events.push(event); state.sourceCounts[eventName === "agent" ? "agent" : "sessionTool"]++; state.phaseCounts[phase]++;
  if (phase === "terminal") state.calls.delete(callId);
}
