import type { TranscriptDocument } from "./transcript.js";
import { currentTranscriptBranch } from "./branch.js";

export const DEFAULT_HISTORY_BUDGET_TOKENS = 100_000;

export interface ContextBudgetEstimate {
  estimatedTokens: number;
  budgetTokens: number;
  remainingTokens: number;
  method: "utf8-bytes-upper-bound-v3";
}

export interface ContextBudgetEstimator {
  estimate(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate;
  assertWithinBudget(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate;
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";
  constructor(readonly estimate: ContextBudgetEstimate) {
    super(`会话有效上下文过长（估算 ${estimate.estimatedTokens} tokens，当前安全上限 ${estimate.budgetTokens}）。面板不会静默删减；请先压缩上下文，或从较早位置 fork。`);
  }
}

const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return 0;
}
function contextEntry(entry: TranscriptDocument["entries"][number]): unknown | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") return { role: "user", content: entry.content, timestamp: timestampMs(entry.timestamp) };
  if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary) return {
    role: "user", content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}` }],
    timestamp: timestampMs(entry.timestamp)
  };
  return undefined;
}

/** Mirrors OpenClaw 2026.6.11 buildSessionContext message selection. */
export function effectiveContextMessages(history: TranscriptDocument): unknown[] {
  const branch = currentTranscriptBranch(history), entries = branch.entries;
  let compactionIndex = -1;
  for (let index = 0; index < entries.length; index++) if (entries[index]?.type === "compaction") compactionIndex = index;
  const messages: unknown[] = [];
  if (compactionIndex >= 0) {
    const compaction = entries[compactionIndex]!;
    messages.push({ role: "user", content: [{ type: "text",
      text: `${COMPACTION_SUMMARY_PREFIX}${String(compaction.summary ?? "")}${COMPACTION_SUMMARY_SUFFIX}` }],
      timestamp: timestampMs(compaction.timestamp) });
    let foundFirstKept = false;
    for (let index = 0; index < compactionIndex; index++) {
      const entry = entries[index]!;
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) { const value = contextEntry(entry); if (value !== undefined) messages.push(value); }
    }
    for (let index = compactionIndex + 1; index < entries.length; index++) {
      const value = contextEntry(entries[index]!); if (value !== undefined) messages.push(value);
    }
  } else {
    for (const entry of entries) { const value = contextEntry(entry); if (value !== undefined) messages.push(value); }
  }
  return messages;
}

export class ConservativeContextBudget implements ContextBudgetEstimator {
  constructor(readonly budgetTokens = DEFAULT_HISTORY_BUDGET_TOKENS, readonly bytesPerToken = 1, readonly perEntryOverhead = 8) {
    if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new Error("context budget 必须是正整数");
    if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) throw new Error("bytesPerToken 必须大于零");
    if (!Number.isInteger(perEntryOverhead) || perEntryOverhead < 0) throw new Error("perEntryOverhead 必须是非负整数");
  }
  estimate(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate {
    const messages = effectiveContextMessages(history);
    const serialized = JSON.stringify(history.header) + messages.map(message => `\n${JSON.stringify(message)}`).join("") + `\n${latestUserMessage}`;
    const estimatedTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / this.bytesPerToken) + (messages.length + 2) * this.perEntryOverhead;
    return { estimatedTokens, budgetTokens: this.budgetTokens, remainingTokens: Math.max(0, this.budgetTokens - estimatedTokens), method: "utf8-bytes-upper-bound-v3" };
  }
  assertWithinBudget(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate {
    const estimate = this.estimate(history, latestUserMessage); if (estimate.estimatedTokens > estimate.budgetTokens) throw new ContextBudgetExceededError(estimate); return estimate;
  }
}
