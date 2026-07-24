import { randomUUID } from "node:crypto";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession, updatePanelMetadata, type PanelMetadata } from "../storage/panel-sessions.js";
import { SessionOperationCoordinator } from "./session-operation.js";
import { currentTranscriptBranch } from "../domain/branch.js";

export const PANEL_COMMAND_ALLOWLIST_VERSION = 3;
export const PANEL_COMMAND_ALLOWLIST = Object.freeze(["model", "think", "reasoning", "new", "commands", "help", "status", "models", "tools", "usage", "compact"] as const);
export type PanelCommandName = typeof PANEL_COMMAND_ALLOWLIST[number];

export interface ModelDescriptor { key: string; name?: string; available: boolean; input?: unknown; contextWindow?: number; tags?: string[]; missing?: unknown }
export interface CommandProviders {
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<unknown>;
  status(): Promise<unknown>;
  tools?(agentId: string): Promise<unknown>;
  createPanel(agentId: string, title?: string): Promise<unknown>;
  thinkingLevels?: readonly string[];
  supportsThinkingLevel?(modelKey: string | undefined, level: string): Promise<boolean>;
  validateOverrides?(agentId: string, overrides: { modelOverride?: string; thinkingLevel?: string }): Promise<void>;
  compact?(recordId: string, expectedRevision?: string): Promise<{ compacted: boolean; revision: string; reason?: string }>;
}
export interface CommandRequest { command: string; args: string[]; revision?: string }
export interface CommandResult { command: PanelCommandName; allowlistVersion: number; effect: "read" | "updated" | "created"; data: unknown }

function latestEntryId(document: TranscriptDocument): string | null {
  const id = currentTranscriptBranch(document).entries.at(-1)?.id; return typeof id === "string" ? id : null;
}
function event(command: PanelCommandName, value: string | undefined, document: TranscriptDocument): JsonObject {
  const now = new Date(); return { type: command === "model" ? "model_change" : "custom", id: randomUUID(), parentId: latestEntryId(document), timestamp: now.toISOString(),
    customType: "panel_command", command, ...(value === undefined ? {} : { value }), message: { role: "system", content: [{ type: "text", text: value === undefined ? `/${command} 已恢复默认` : `/${command} 已设置为 ${value}` }], timestamp: now.getTime() } };
}
function commandName(input: string): string { return input.startsWith("/") ? input.slice(1) : input; }

function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function usageNumber(usage: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) { const value = usage[name]; if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value; }
  return undefined;
}
export function transcriptUsage(document: TranscriptDocument): unknown {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reportedTotal: 0 };
  let assistantMessages = 0, messagesWithUsage = 0, messagesWithReportedTotal = 0;
  for (const entry of currentTranscriptBranch(document).entries) {
    const message = object(entry.message); if (message?.role !== "assistant") continue; assistantMessages++;
    const usage = object(message.usage) ?? object(entry.usage); if (!usage) continue; messagesWithUsage++;
    totals.input += usageNumber(usage, ["input", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens"]) ?? 0;
    totals.output += usageNumber(usage, ["output", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"]) ?? 0;
    totals.cacheRead += usageNumber(usage, ["cacheRead", "cache_read", "cache_read_input_tokens", "cached_tokens"]) ?? 0;
    totals.cacheWrite += usageNumber(usage, ["cacheWrite", "cache_write", "cache_creation_input_tokens"]) ?? 0;
    totals.reasoning += usageNumber(usage, ["reasoningTokens", "reasoning_tokens"]) ?? 0;
    const reported = usageNumber(usage, ["total", "totalTokens", "total_tokens"]); if (reported !== undefined) { totals.reportedTotal += reported; messagesWithReportedTotal++; }
  }
  return { source: "model-reported-transcript-usage", scope: "current-branch", estimated: false,
    coverage: { assistantMessages, messagesWithUsage, messagesWithReportedTotal },
    tokens: { ...totals, reportedTotal: messagesWithReportedTotal ? totals.reportedTotal : null } };
}

function commandCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const catalog = value as { commands?: unknown };
  if (!Array.isArray(catalog.commands)) return value;
  return { ...catalog, commands: catalog.commands.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const command = item as Record<string, unknown>;
    const name = typeof command.name === "string" ? commandName(command.name) : "";
    return { ...command, supported: (PANEL_COMMAND_ALLOWLIST as readonly string[]).includes(name) };
  }) };
}

export class PanelCommandApi {
  private readonly levels: readonly string[];
  private readonly operations: SessionOperationCoordinator;
  constructor(private readonly dataRoot: string, private readonly agentIds: readonly string[], private readonly providers: CommandProviders, operations?: SessionOperationCoordinator) {
    this.levels = providers.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh"];
    this.operations = operations ?? new SessionOperationCoordinator();
  }
  private async session(recordId: string): Promise<{ metadata: PanelMetadata; document: TranscriptDocument }> {
    for (const agentId of this.agentIds) if ((await listPanelSessions(this.dataRoot, agentId)).some(item => item.recordId === recordId)) return await loadPanelSession(this.dataRoot, agentId, recordId);
    throw new Error("PANEL_SESSION_NOT_FOUND");
  }
  private result(command: PanelCommandName, effect: CommandResult["effect"], data: unknown): CommandResult { return { command, allowlistVersion: PANEL_COMMAND_ALLOWLIST_VERSION, effect, data }; }
  private async validateOverrides(agentId: string, overrides: { modelOverride?: string; thinkingLevel?: string }): Promise<void> {
    if (!this.providers.validateOverrides) return;
    try { await this.providers.validateOverrides(agentId, overrides); }
    catch { throw new Error("THINKING_LEVEL_UNSUPPORTED"); }
  }
  async dispatch(recordId: string, request: CommandRequest): Promise<CommandResult> {
    const name = commandName(request.command);
    if (name === "compact") {
      if (request.args.length || !this.providers.compact) throw new Error(request.args.length ? "COMMAND_ARGS_INVALID" : "COMMAND_UNAVAILABLE");
      const data = await this.providers.compact(recordId, request.revision);
      return this.result("compact", data.compacted ? "updated" : "read", data);
    }
    return await this.operations.runCommand(recordId, () => this.dispatchOnce(recordId, request));
  }
  private async dispatchOnce(recordId: string, request: CommandRequest): Promise<CommandResult> {
    const name = commandName(request.command);
    if (!(PANEL_COMMAND_ALLOWLIST as readonly string[]).includes(name)) throw new Error("COMMAND_NOT_ALLOWED");
    const command = name as PanelCommandName; if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string")) throw new Error("COMMAND_ARGS_INVALID");
    if (["commands", "help", "status", "models", "tools", "usage", "compact"].includes(command) && request.args.length) throw new Error("COMMAND_ARGS_INVALID");
    const loaded = await this.session(recordId);
    if (command === "commands") return this.result(command, "read", commandCatalog(await this.providers.commands()));
    if (command === "status") return this.result(command, "read", await this.providers.status());
    if (command === "models") return this.result(command, "read", await this.providers.models());
    if (command === "tools") { if (!this.providers.tools) throw new Error("COMMAND_UNAVAILABLE"); return this.result(command, "read", await this.providers.tools(loaded.metadata.agentId)); }
    if (command === "usage") return this.result(command, "read", transcriptUsage(loaded.document));
    if (command === "help") return this.result(command, "read", { allowlistVersion: PANEL_COMMAND_ALLOWLIST_VERSION, commands: PANEL_COMMAND_ALLOWLIST });
    if (command === "new") {
      const title = request.args.join(" ").trim() || undefined; return this.result(command, "created", await this.providers.createPanel(loaded.metadata.agentId, title));
    }
    if (request.args.length > 1) throw new Error("COMMAND_ARGS_INVALID");
    const argument = request.args[0];
    if (argument === undefined) {
      if (command === "model") return this.result(command, "read", { current: loaded.metadata.modelOverride ?? null, models: await this.providers.models() });
      if (command === "think") return this.result(command, "read", { current: loaded.metadata.thinkingLevel ?? null, levels: this.levels });
      return this.result(command, "read", { current: loaded.metadata.reasoningLevel ?? null, modes: ["on", "off", "stream"] });
    }
    let value: string | undefined = argument === "default" ? undefined : argument;
    if (command === "model" && value !== undefined) {
      const matches = (await this.providers.models()).filter(model => model.key === value || model.tags?.includes(`alias:${value}`));
      if (matches.length !== 1 || !matches[0]!.available) throw new Error("MODEL_NOT_AVAILABLE"); value = matches[0]!.key;
      if (loaded.metadata.thinkingLevel) await this.validateOverrides(loaded.metadata.agentId, { modelOverride: value, thinkingLevel: loaded.metadata.thinkingLevel });
    }
    if (command === "think" && value !== undefined) {
      if (!this.levels.includes(value)) throw new Error("THINKING_LEVEL_INVALID");
      if (this.providers.supportsThinkingLevel && !await this.providers.supportsThinkingLevel(loaded.metadata.modelOverride, value)) throw new Error("THINKING_LEVEL_UNSUPPORTED");
      await this.validateOverrides(loaded.metadata.agentId, { ...(loaded.metadata.modelOverride ? { modelOverride: loaded.metadata.modelOverride } : {}), thinkingLevel: value });
    }
    if (command === "reasoning" && value !== undefined && !["on", "off", "stream"].includes(value)) throw new Error("REASONING_LEVEL_INVALID");
    const metadata = await updatePanelMetadata(this.dataRoot, loaded.metadata.agentId, recordId, current => {
      const next = { ...current };
      const key = command === "model" ? "modelOverride" : command === "think" ? "thinkingLevel" : "reasoningLevel";
      if (value === undefined) delete next[key]; else Object.assign(next, { [key]: value }); return next;
    });
    loaded.document.entries.push(event(command, value, loaded.document)); await commitPanelTranscript(this.dataRoot, metadata, loaded.document);
    return this.result(command, "updated", { current: value ?? null });
  }
}
