import type { TranscriptDocument } from "./transcript.js";

export const DEFAULT_HISTORY_BUDGET_TOKENS = 100_000;

export interface ContextBudgetEstimate {
  estimatedTokens: number;
  budgetTokens: number;
  remainingTokens: number;
  method: "utf8-bytes-upper-bound-v2";
}

export interface ContextBudgetEstimator {
  estimate(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate;
  assertWithinBudget(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate;
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED";
  constructor(readonly estimate: ContextBudgetEstimate) {
    super(`会话历史过长（估算 ${estimate.estimatedTokens} tokens，当前安全上限 ${estimate.budgetTokens}）。第一版不会自动删减或伪造摘要；请从较早位置 fork，或等待后续压缩功能。`);
  }
}

export class ConservativeContextBudget implements ContextBudgetEstimator {
  constructor(readonly budgetTokens = DEFAULT_HISTORY_BUDGET_TOKENS, readonly bytesPerToken = 1, readonly perEntryOverhead = 8) {
    if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new Error("context budget 必须是正整数");
    if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) throw new Error("bytesPerToken 必须大于零");
    if (!Number.isInteger(perEntryOverhead) || perEntryOverhead < 0) throw new Error("perEntryOverhead 必须是非负整数");
  }
  estimate(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate {
    const serialized = JSON.stringify(history.header) + history.entries.map(entry => `\n${JSON.stringify(entry)}`).join("") + `\n${latestUserMessage}`;
    const estimatedTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / this.bytesPerToken) + (history.entries.length + 2) * this.perEntryOverhead;
    return { estimatedTokens, budgetTokens: this.budgetTokens, remainingTokens: Math.max(0, this.budgetTokens - estimatedTokens), method: "utf8-bytes-upper-bound-v2" };
  }
  assertWithinBudget(history: TranscriptDocument, latestUserMessage: string): ContextBudgetEstimate {
    const estimate = this.estimate(history, latestUserMessage); if (estimate.estimatedTokens > estimate.budgetTokens) throw new ContextBudgetExceededError(estimate); return estimate;
  }
}
