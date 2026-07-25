import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseTranscript, serializeTranscript, type JsonObject, type TranscriptDocument } from "../domain/transcript.js";
import { atomicWrite } from "../storage/atomic.js";
import type { BridgeMaterializer, CreatedSession } from "./adapter.js";

function textOfUser(entry: JsonObject): string | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
  const message = entry.message as JsonObject; if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content.map((block) => block && typeof block === "object" && !Array.isArray(block) && (block as JsonObject).type === "text" ? (block as JsonObject).text : "")
    .filter((text): text is string => typeof text === "string").join("");
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function kind(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}
function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function structuralFingerprint(entry: JsonObject | undefined): JsonObject | null {
  if (!entry) return null;
  const message = object(entry.message), content = message?.content;
  return {
    type: typeof entry.type === "string" ? entry.type : kind(entry.type),
    role: typeof message?.role === "string" ? message.role : null,
    entryKeys: Object.keys(entry).sort(),
    messageKeys: message ? Object.keys(message).sort() : [],
    entryBytes: serializedBytes(entry),
    contentKind: kind(content),
    contentBytes: content === undefined ? 0 : serializedBytes(content),
    blockTypes: Array.isArray(content) ? content.map(block => {
      const value = object(block); return typeof value?.type === "string" ? value.type : kind(block);
    }) : [],
    blockKeySets: Array.isArray(content) ? content.map(block => {
      const value = object(block); return value ? Object.keys(value).sort() : [];
    }) : []
  };
}
function changedKeys(expected: JsonObject | undefined, actual: JsonObject | undefined): string[] {
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  return [...keys].filter(key => !isDeepStrictEqual(expected?.[key], actual?.[key])).sort();
}
function compactionRewriteDiagnostic(created: CreatedSession, history: TranscriptDocument, actual: TranscriptDocument): JsonObject {
  const mismatchIndex = history.entries.findIndex((entry, index) => !isDeepStrictEqual(entry, actual.entries[index]));
  const expected = mismatchIndex >= 0 ? history.entries[mismatchIndex] : undefined;
  const observed = mismatchIndex >= 0 ? actual.entries[mismatchIndex] : undefined;
  return {
    event: "compaction_rewrite_rejected",
    headerIdMatches: actual.header.id === created.sessionId,
    expectedHistoricalEntries: history.entries.length,
    actualEntries: actual.entries.length,
    firstHistoricalMismatch: mismatchIndex >= 0 ? {
      index: mismatchIndex,
      changedEntryKeys: changedKeys(expected, observed),
      changedMessageKeys: changedKeys(object(expected?.message), object(observed?.message)),
      expected: structuralFingerprint(expected),
      actual: structuralFingerprint(observed)
    } : null,
    actualTail: actual.entries.slice(history.entries.length).map(entry => structuralFingerprint(entry))
  };
}
function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function runtimeCompactionPrelude(entries: readonly JsonObject[], priorIds: ReadonlySet<string>,
  expectedParent: string | null): { parentId: string | null; ids: Set<string> } | undefined {
  if (entries.length > 2) return undefined;
  let parentId = expectedParent; const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const id = typeof entry.id === "string" && entry.id ? entry.id : undefined;
    if (!id || priorIds.has(id) || ids.has(id) || entry.parentId !== parentId || !validTimestamp(entry.timestamp)) return undefined;
    if (entry.type === "thinking_level_change") {
      if (index !== 0 || !exactKeys(entry, ["id", "parentId", "thinkingLevel", "timestamp", "type"]) ||
        typeof entry.thinkingLevel !== "string" || !entry.thinkingLevel) return undefined;
    } else if (entry.type === "custom") {
      const data = object(entry.data);
      if (!exactKeys(entry, ["customType", "data", "id", "parentId", "timestamp", "type"]) ||
        entry.customType !== "model-snapshot" || !data ||
        !exactKeys(data, ["modelApi", "modelId", "provider", "timestamp"]) ||
        typeof data.provider !== "string" || !data.provider ||
        typeof data.modelApi !== "string" || !data.modelApi ||
        typeof data.modelId !== "string" || !data.modelId ||
        typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return undefined;
    } else return undefined;
    ids.add(id); parentId = id;
  }
  return { parentId, ids };
}

export class FileBridgeMaterializer implements BridgeMaterializer {
  constructor(private readonly now: () => Date = () => new Date(),
    private readonly diagnose: (event: JsonObject) => void =
      event => process.stderr.write(`[ark-panel] ${JSON.stringify(event)}\n`)) {}

  async replaceCreatedTranscript(created: CreatedSession, history: TranscriptDocument): Promise<number> {
    // OpenClaw derives session freshness from the transcript header when its
    // newly-created registry entry has no sessionStartedAt yet. Keeping the
    // panel session's original timestamp here can therefore trigger the daily
    // reset policy immediately: OpenClaw rotates to another sessionId while the
    // bridge keeps polling the file belonging to `created.sessionId`.
    const document = { header: { ...history.header, id: created.sessionId, timestamp: this.now().toISOString() }, entries: history.entries };
    await atomicWrite(created.transcriptPath, serializeTranscript(document)); return history.entries.length;
  }
  async readNewEntries(created: CreatedSession, previousEntryCount: number): Promise<JsonObject[]> {
    const document = parseTranscript(await readFile(created.transcriptPath, "utf8"));
    if (document.entries.length <= previousEntryCount) throw new Error("gateway 没有追加完整 run");
    return document.entries.slice(previousEntryCount);
  }
  async readAndVerifyCompaction(created: CreatedSession, history: TranscriptDocument): Promise<JsonObject> {
    let document: TranscriptDocument;
    try { document = parseTranscript(await readFile(created.transcriptPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("OPENCLAW_COMPACTION_ROTATION_UNSUPPORTED");
      throw error;
    }
    if (document.header.id !== created.sessionId || document.entries.length <= history.entries.length ||
      !history.entries.every((entry, index) => isDeepStrictEqual(entry, document.entries[index]))) {
      this.diagnose(compactionRewriteDiagnostic(created, history, document));
      throw new Error("OPENCLAW_COMPACTION_REWRITE_UNSUPPORTED");
    }
    const tail = document.entries.slice(history.entries.length), entry = tail.at(-1)!;
    const priorIds = new Set(history.entries.flatMap(value => typeof value.id === "string" ? [value.id] : []));
    const lastHistoryId = history.entries.at(-1)?.id;
    const expectedParent = typeof lastHistoryId === "string" ? lastHistoryId : null;
    const prelude = runtimeCompactionPrelude(tail.slice(0, -1), priorIds, expectedParent);
    if (!prelude) {
      this.diagnose(compactionRewriteDiagnostic(created, history, document));
      throw new Error("OPENCLAW_COMPACTION_REWRITE_UNSUPPORTED");
    }
    if (entry.type !== "compaction" || typeof entry.id !== "string" || !entry.id ||
      typeof entry.summary !== "string" || !entry.summary.trim() ||
      !validTimestamp(entry.timestamp) ||
      typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0) {
      throw new Error("OPENCLAW_COMPACTION_ENTRY_INVALID");
    }
    if (priorIds.has(entry.id) || prelude.ids.has(entry.id)) throw new Error("OPENCLAW_COMPACTION_ENTRY_INVALID");
    if (entry.parentId !== prelude.parentId) throw new Error("OPENCLAW_COMPACTION_PARENT_INVALID");
    if (entry.firstKeptEntryId !== entry.id &&
      (typeof entry.firstKeptEntryId !== "string" || !priorIds.has(entry.firstKeptEntryId))) {
      throw new Error("OPENCLAW_COMPACTION_BOUNDARY_INVALID");
    }
    if (typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId !== entry.id) {
      const byId = new Map(history.entries.flatMap(value => typeof value.id === "string" ? [[value.id, value] as const] : []));
      let current = typeof expectedParent === "string" ? byId.get(expectedParent) : undefined;
      const ancestors = new Set<string>();
      while (current && typeof current.id === "string" && !ancestors.has(current.id)) {
        ancestors.add(current.id);
        current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
      }
      if (!ancestors.has(entry.firstKeptEntryId)) throw new Error("OPENCLAW_COMPACTION_BOUNDARY_INVALID");
    }
    return entry.parentId === expectedParent ? entry : { ...entry, parentId: expectedParent };
  }
  verifyAndStripSubmittedUser(entries: JsonObject[], expectedMessage: string, panelUserEntryId: string): JsonObject[] {
    const userIndexes = entries.flatMap((entry, index) => textOfUser(entry) === undefined ? [] : [index]);
    if (userIndexes.length !== 1 || textOfUser(entries[userIndexes[0]!]!) !== expectedMessage) throw new Error("gateway 新增的 user entry 与提交消息不一致");
    const gatewayUserId = entries[userIndexes[0]!]!.id;
    if (typeof gatewayUserId !== "string") throw new Error("gateway user entry 缺少 id");
    const runEntries = entries.filter((_, index) => index !== userIndexes[0]).map((entry) =>
      entry.parentId === gatewayUserId ? { ...entry, parentId: panelUserEntryId } : entry);
    if (!runEntries.some((entry) => entry.type === "message")) throw new Error("run 没有 message entry");
    return runEntries;
  }
}
