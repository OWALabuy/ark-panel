import { isDeepStrictEqual } from "node:util";
import type { BridgeStreamEvent } from "../gateway/adapter.js";
import type { PublicRunStream, PublicRunStreamItem, PublicRunTool } from "./run-store.js";

type DataEvent = Exclude<BridgeStreamEvent, { type: "connection" }>;
type StoredEvent =
  | { type: "assistant_text"; upstreamSeq: number; deltaText: string; replace: boolean; snapshot?: string }
  | Extract<DataEvent, { type: "tool" }>;
interface AssistantBaseline { sequence: number; prefix: string }

export interface StreamProjectionChange { changed: boolean; conflict: boolean }
export interface RunStreamProjectorTestHooks { onToolIndexLookup?(): void; onProjectionRebuild?(): void }

function storedEvent(event: DataEvent, capturePrefix: boolean): { value: StoredEvent; prefix?: string } {
  if (event.type === "tool") return { value: structuredClone(event) };
  const compact = !event.replace && event.deltaText.length > 0 && event.text.endsWith(event.deltaText);
  const snapshot = compact ? undefined : event.text;
  const value: StoredEvent = {
    type: "assistant_text",
    upstreamSeq: event.upstreamSeq,
    deltaText: event.deltaText,
    replace: event.replace,
    ...(snapshot !== undefined ? { snapshot } : {})
  };
  const prefix = compact && capturePrefix ? event.text.slice(0, -event.deltaText.length) : undefined;
  return { value, ...(prefix !== undefined ? { prefix } : {}) };
}

function appendText(items: PublicRunStreamItem[], sequence: number, text: string): void {
  if (!text) return;
  const previous = items.at(-1);
  if (previous?.type === "text") previous.text += text;
  else items.push({ type: "text", sequence, text });
}

function project(events: ReadonlyMap<number, StoredEvent>, baseline?: AssistantBaseline): Pick<PublicRunStream, "text" | "tools" | "items"> {
  const items: PublicRunStreamItem[] = [];
  const toolItems = new Map<string, Extract<PublicRunStreamItem, { type: "tool" }>>();
  let text = "";
  for (const event of [...events.values()].sort((left, right) => left.upstreamSeq - right.upstreamSeq)) {
    if (event.type === "assistant_text") {
      if (event.snapshot !== undefined) {
        if (!event.replace && event.snapshot.startsWith(text)) {
          appendText(items, event.upstreamSeq, event.snapshot.slice(text.length));
        } else {
          for (let index = items.length - 1; index >= 0; index--) if (items[index]?.type === "text") items.splice(index, 1);
          appendText(items, event.upstreamSeq, event.snapshot);
        }
        text = event.snapshot;
      } else {
        const addition = baseline?.sequence === event.upstreamSeq ? baseline.prefix + event.deltaText : event.deltaText;
        text += addition;
        appendText(items, event.upstreamSeq, addition);
      }
      continue;
    }
    const previous = toolItems.get(event.callId);
    const args = event.args ?? previous?.args;
    if (previous) {
      previous.updatedSequence = event.upstreamSeq;
      previous.name = event.name;
      previous.phase = event.phase;
      if (args !== undefined) previous.args = args;
      continue;
    }
    const item: Extract<PublicRunStreamItem, { type: "tool" }> = {
      type: "tool",
      sequence: event.upstreamSeq,
      updatedSequence: event.upstreamSeq,
      callId: event.callId,
      name: event.name,
      phase: event.phase,
      ...(args !== undefined ? { args } : {})
    };
    toolItems.set(event.callId, item);
    items.push(item);
  }
  const tools: PublicRunTool[] = [...toolItems.values()].map(({ type: _type, sequence: _sequence, updatedSequence: _updatedSequence, ...tool }) => ({ ...tool }));
  return { text, tools, items };
}

export class RunStreamProjector {
  readonly #events = new Map<number, StoredEvent>();
  readonly #conflictedSequences = new Set<number>();
  readonly #compactedAssistantSequences = new Set<number>();
  #baseline: AssistantBaseline | undefined;
  #firstAssistantSequence = Number.POSITIVE_INFINITY;
  #connection: "connected" | "disconnected" | undefined;
  #lastSequence = -1;
  #public: PublicRunStream = { revision: 0, state: "connecting", text: "", tools: [], items: [] };
  #toolItems = new Map<string, Extract<PublicRunStreamItem, { type: "tool" }>>();
  #tools = new Map<string, PublicRunTool>();

  constructor(private readonly testHooks: RunStreamProjectorTestHooks = {}) {}

  apply(event: BridgeStreamEvent): StreamProjectionChange {
    if (event.type === "connection") {
      this.#connection = event.state;
      return this.#rebuild(false);
    }
    const sequence = event.upstreamSeq;
    if (this.#conflictedSequences.has(sequence)) return { changed: false, conflict: false };
    if (event.type === "tool" && this.#compactedAssistantSequences.has(sequence)) {
      this.#conflictedSequences.add(sequence);
      return { changed: false, conflict: true };
    }
    if (event.type === "assistant_text" && this.#compactedAssistantSequences.has(sequence)) return { changed: false, conflict: false };
    const stored = storedEvent(event, event.type === "assistant_text" && sequence <= this.#firstAssistantSequence);
    const next = stored.value, previous = this.#events.get(sequence);
    const sameBaseline = this.#baseline?.sequence !== sequence || this.#baseline.prefix === stored.prefix;
    if (previous && isDeepStrictEqual(previous, next) && sameBaseline) return { changed: false, conflict: false };
    if (previous) {
      this.#events.delete(sequence);
      this.#conflictedSequences.add(sequence);
      if (previous.type === "assistant_text" || event.type === "assistant_text") {
        for (const [storedSequence, stored] of this.#events) {
          if (stored.type === "assistant_text" && storedSequence >= sequence) this.#events.delete(storedSequence);
        }
        if (this.#firstAssistantSequence >= sequence) this.#baseline = undefined;
        this.#firstAssistantSequence = Math.min(...[...this.#events.values()].filter(value => value.type === "assistant_text")
          .map(value => value.upstreamSeq), Number.POSITIVE_INFINITY);
      }
      const toolCallIds = new Set<string>();
      if (previous.type === "tool") toolCallIds.add(previous.callId);
      if (event.type === "tool") toolCallIds.add(event.callId);
      if (toolCallIds.size) {
        for (const [storedSequence, stored] of this.#events) {
          if (stored.type === "tool" && storedSequence >= sequence && toolCallIds.has(stored.callId)) this.#events.delete(storedSequence);
        }
      }
      this.#lastSequence = Math.max(-1, ...this.#events.keys());
      return this.#rebuild(true);
    }
    if (next.type === "assistant_text" && next.snapshot !== undefined) {
      for (const [storedSequence, existing] of this.#events) {
        if (existing.type !== "assistant_text" || storedSequence >= sequence) continue;
        this.#events.delete(storedSequence);
        this.#compactedAssistantSequences.add(storedSequence);
      }
      this.#baseline = undefined;
      this.#firstAssistantSequence = sequence;
    }
    this.#events.set(sequence, next);
    if (event.type === "assistant_text" && sequence < this.#firstAssistantSequence) {
      this.#firstAssistantSequence = sequence;
      this.#baseline = stored.prefix !== undefined ? { sequence, prefix: stored.prefix } : undefined;
    }
    this.#connection = "connected";
    if (sequence > this.#lastSequence) {
      this.#lastSequence = sequence;
      this.#append(next);
      return { changed: true, conflict: false };
    }
    return this.#rebuild(false);
  }

  snapshot(): PublicRunStream {
    return structuredClone(this.#public);
  }

  #append(event: StoredEvent): void {
    if (event.type === "assistant_text") {
      if (event.snapshot !== undefined) {
        if (!event.replace && event.snapshot.startsWith(this.#public.text)) {
          appendText(this.#public.items, event.upstreamSeq, event.snapshot.slice(this.#public.text.length));
        } else {
          for (let index = this.#public.items.length - 1; index >= 0; index--) if (this.#public.items[index]?.type === "text") this.#public.items.splice(index, 1);
          appendText(this.#public.items, event.upstreamSeq, event.snapshot);
        }
        this.#public.text = event.snapshot;
      } else {
        const addition = this.#baseline?.sequence === event.upstreamSeq ? this.#baseline.prefix + event.deltaText : event.deltaText;
        this.#public.text += addition;
        appendText(this.#public.items, event.upstreamSeq, addition);
      }
    } else {
      this.testHooks.onToolIndexLookup?.(); const item = this.#toolItems.get(event.callId);
      this.testHooks.onToolIndexLookup?.(); const tool = this.#tools.get(event.callId);
      const args = event.args ?? item?.args;
      if (item?.type === "tool") {
        item.updatedSequence = event.upstreamSeq; item.name = event.name; item.phase = event.phase;
        if (args !== undefined) item.args = args;
      } else {
        const created: Extract<PublicRunStreamItem, { type: "tool" }> = { type: "tool", sequence: event.upstreamSeq, updatedSequence: event.upstreamSeq,
          callId: event.callId, name: event.name, phase: event.phase, ...(args !== undefined ? { args } : {}) };
        this.#public.items.push(created); this.#toolItems.set(event.callId, created);
      }
      if (tool) {
        tool.name = event.name; tool.phase = event.phase;
        if (args !== undefined) tool.args = args;
      } else {
        const created: PublicRunTool = { callId: event.callId, name: event.name, phase: event.phase, ...(args !== undefined ? { args } : {}) };
        this.#public.tools.push(created); this.#tools.set(event.callId, created);
      }
    }
    this.#public.state = "streaming";
    this.#public.revision++;
  }

  #rebuild(conflict: boolean): StreamProjectionChange {
    this.testHooks.onProjectionRebuild?.();
    const projection = project(this.#events, this.#baseline);
    const state: PublicRunStream["state"] = this.#connection === "disconnected" ? "degraded" : projection.items.length ? "streaming" : "connecting";
    const content = { state, ...projection };
    const previous = { state: this.#public.state, text: this.#public.text, tools: this.#public.tools, items: this.#public.items };
    if (isDeepStrictEqual(previous, content)) return { changed: false, conflict };
    this.#public = { revision: this.#public.revision + 1, ...content };
    this.#toolItems = new Map(this.#public.items.filter((item): item is Extract<PublicRunStreamItem, { type: "tool" }> => item.type === "tool").map(item => [item.callId, item]));
    this.#tools = new Map(this.#public.tools.map(tool => [tool.callId, tool]));
    return { changed: true, conflict };
  }
}
