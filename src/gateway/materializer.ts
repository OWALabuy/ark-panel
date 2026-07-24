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

export class FileBridgeMaterializer implements BridgeMaterializer {
  constructor(private readonly now: () => Date = () => new Date()) {}

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
    if (document.header.id !== created.sessionId || document.entries.length !== history.entries.length + 1 ||
      !history.entries.every((entry, index) => isDeepStrictEqual(entry, document.entries[index]))) {
      throw new Error("OPENCLAW_COMPACTION_REWRITE_UNSUPPORTED");
    }
    const entry = document.entries.at(-1)!;
    if (entry.type !== "compaction" || typeof entry.id !== "string" || !entry.id ||
      typeof entry.summary !== "string" || !entry.summary.trim() ||
      typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0) {
      throw new Error("OPENCLAW_COMPACTION_ENTRY_INVALID");
    }
    const priorIds = new Set(history.entries.flatMap(value => typeof value.id === "string" ? [value.id] : []));
    if (priorIds.has(entry.id)) throw new Error("OPENCLAW_COMPACTION_ENTRY_INVALID");
    const expectedParent = [...history.entries].reverse().find(value =>
      value.type === "message" || value.type === "compaction")?.id ?? null;
    if (entry.parentId !== expectedParent) throw new Error("OPENCLAW_COMPACTION_PARENT_INVALID");
    if (entry.firstKeptEntryId !== entry.id &&
      (typeof entry.firstKeptEntryId !== "string" || !priorIds.has(entry.firstKeptEntryId))) {
      throw new Error("OPENCLAW_COMPACTION_BOUNDARY_INVALID");
    }
    if (typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId !== entry.id) {
      const byId = new Map(history.entries.flatMap(value => typeof value.id === "string" ? [[value.id, value] as const] : []));
      let current = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
      const ancestors = new Set<string>();
      while (current && typeof current.id === "string" && !ancestors.has(current.id)) {
        ancestors.add(current.id);
        current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
      }
      if (!ancestors.has(entry.firstKeptEntryId)) throw new Error("OPENCLAW_COMPACTION_BOUNDARY_INVALID");
    }
    return entry;
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
