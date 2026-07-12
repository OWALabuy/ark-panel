import { randomUUID } from "node:crypto";
import { entryId, parentId, type JsonObject, type TranscriptDocument } from "./transcript.js";

export class ForkError extends Error { constructor(readonly code: string, message: string) { super(message); } }

function contentBlocks(entry: JsonObject): JsonObject[] {
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const content = (message as JsonObject).content;
  return Array.isArray(content) ? content.filter((v): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

function role(entry: JsonObject): string | undefined {
  const message = entry.message;
  return message && typeof message === "object" && !Array.isArray(message) && typeof (message as JsonObject).role === "string"
    ? (message as JsonObject).role as string : undefined;
}

function isToolCall(entry: JsonObject): boolean {
  return contentBlocks(entry).some((block) => block.type === "tool_use" || block.type === "toolCall");
}

export function isLegalForkBoundary(entry: JsonObject): boolean {
  const entryRole = role(entry);
  if (entryRole === "user") return true;
  if (entryRole === "assistant") return !isToolCall(entry) && entry.stopReason !== "toolUse" && entry.stopReason !== "tool_use";
  return entry.type === "compaction" || entry.type === "compaction_checkpoint";
}

export interface ForkMetadata { recordId: string; parentRecordId: string; forkedFromMessageId: string; createdAt: string }

export function deriveFork(source: TranscriptDocument, targetId: string, metadata: ForkMetadata): TranscriptDocument {
  const byId = new Map<string, JsonObject>();
  for (const entry of source.entries) {
    const id = entryId(entry);
    if (id) {
      if (byId.has(id)) throw new ForkError("FORK_INVALID_TRANSCRIPT", `重复 entry id: ${id}`);
      byId.set(id, entry);
    }
  }
  const target = byId.get(targetId);
  if (!target) throw new ForkError("FORK_TARGET_NOT_FOUND", "找不到 fork 目标");
  if (!isLegalForkBoundary(target)) throw new ForkError("FORK_BOUNDARY_INVALID", "该 entry 不是合法 fork 边界");

  const chain = new Set<string>();
  let current: JsonObject | undefined = target;
  while (current) {
    const id = entryId(current);
    if (!id) throw new ForkError("FORK_INVALID_TRANSCRIPT", "祖先链 entry 缺少 id");
    if (chain.has(id)) throw new ForkError("FORK_INVALID_TRANSCRIPT", "祖先链存在循环");
    chain.add(id);
    const parent = parentId(current);
    if (parent === null || parent === undefined) break;
    current = byId.get(parent);
    if (!current) throw new ForkError("FORK_INVALID_TRANSCRIPT", `找不到父 entry: ${parent}`);
  }

  const targetIndex = source.entries.indexOf(target);
  const selected = source.entries.filter((entry, index) => {
    if (index > targetIndex) return false;
    const id = entryId(entry);
    if (id) return chain.has(id);
    const parent = parentId(entry);
    return parent === undefined ? true : parent === null || chain.has(parent);
  });
  return {
    header: {
      ...source.header,
      id: randomUUID(),
      timestamp: metadata.createdAt,
      panel: metadata
    },
    entries: selected
  };
}
