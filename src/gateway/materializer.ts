import { readFile } from "node:fs/promises";
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
