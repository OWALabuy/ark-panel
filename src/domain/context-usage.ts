import { currentTranscriptBranch } from "./branch.js";
import type { JsonObject, TranscriptDocument } from "./transcript.js";

export interface OpenClawContextUsage {
  source: "openclaw-session";
  totalTokens: number | null;
  contextTokens: number | null;
  totalTokensFresh: boolean;
}

interface StoredOpenClawContextUsage extends OpenClawContextUsage {
  throughEntryId: string;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function tokenCount(value: unknown, allowZero: boolean): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? value : null;
}

export function contextUsageAtCurrentTip(document: TranscriptDocument): OpenClawContextUsage | null {
  const panel = object(document.header.panel), stored = object(panel?.contextUsage);
  if (stored?.source !== "openclaw-session" || typeof stored.throughEntryId !== "string" ||
    typeof stored.totalTokensFresh !== "boolean") return null;
  const tip = currentTranscriptBranch(document).entries.at(-1)?.id;
  if (typeof tip !== "string" || stored.throughEntryId !== tip) return null;
  const contextTokens = tokenCount(stored.contextTokens, false);
  const reportedTotal = tokenCount(stored.totalTokens, true);
  const totalTokensFresh = stored.totalTokensFresh && reportedTotal !== null;
  return { source: "openclaw-session", totalTokens: totalTokensFresh ? reportedTotal : null,
    contextTokens, totalTokensFresh };
}

export function headerWithContextUsage(header: JsonObject, usage: OpenClawContextUsage | undefined,
  throughEntryId: string | undefined): JsonObject {
  const existingPanel = object(header.panel);
  if (!existingPanel) return header;
  const panel = { ...existingPanel }; delete panel.contextUsage;
  const totalTokens = usage ? tokenCount(usage.totalTokens, true) : null;
  const contextTokens = usage ? tokenCount(usage.contextTokens, false) : null;
  if (usage && throughEntryId && (totalTokens !== null || contextTokens !== null)) {
    const stored: StoredOpenClawContextUsage = { source: "openclaw-session",
      totalTokens: usage.totalTokensFresh && totalTokens !== null ? totalTokens : null,
      contextTokens, totalTokensFresh: usage.totalTokensFresh && totalTokens !== null, throughEntryId };
    panel.contextUsage = stored;
  }
  return { ...header, panel };
}
