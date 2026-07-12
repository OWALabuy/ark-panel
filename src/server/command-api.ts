import { randomUUID } from "node:crypto";
import type { JsonObject, TranscriptDocument } from "../domain/transcript.js";
import { commitPanelTranscript, listPanelSessions, loadPanelSession, updatePanelMetadata, type PanelMetadata } from "../storage/panel-sessions.js";
import { SessionOperationCoordinator } from "./session-operation.js";

export const PANEL_COMMAND_ALLOWLIST_VERSION = 1;
export const PANEL_COMMAND_ALLOWLIST = Object.freeze(["model", "think", "reasoning", "new", "commands", "help", "status", "models"] as const);
export type PanelCommandName = typeof PANEL_COMMAND_ALLOWLIST[number];

export interface ModelDescriptor { key: string; name?: string; available: boolean; input?: unknown; contextWindow?: number; tags?: string[]; missing?: unknown }
export interface CommandProviders {
  models(): Promise<ModelDescriptor[]>;
  commands(): Promise<unknown>;
  status(): Promise<unknown>;
  createPanel(agentId: string, title?: string): Promise<unknown>;
  thinkingLevels?: readonly string[];
  supportsThinkingLevel?(modelKey: string | undefined, level: string): Promise<boolean>;
  validateOverrides?(agentId: string, overrides: { modelOverride?: string; thinkingLevel?: string }): Promise<void>;
}
export interface CommandRequest { command: string; args: string[] }
export interface CommandResult { command: PanelCommandName; allowlistVersion: number; effect: "read" | "updated" | "created"; data: unknown }

function latestEntryId(document: TranscriptDocument): string | null {
  for (let index = document.entries.length - 1; index >= 0; index--) if (typeof document.entries[index]!.id === "string") return document.entries[index]!.id as string;
  return null;
}
function event(command: PanelCommandName, value: string | undefined, document: TranscriptDocument): JsonObject {
  const now = new Date(); return { type: command === "model" ? "model_change" : "custom", id: randomUUID(), parentId: latestEntryId(document), timestamp: now.toISOString(),
    customType: "panel_command", command, ...(value === undefined ? {} : { value }), message: { role: "system", content: [{ type: "text", text: value === undefined ? `/${command} 已恢复默认` : `/${command} 已设置为 ${value}` }], timestamp: now.getTime() } };
}
function commandName(input: string): string { return input.startsWith("/") ? input.slice(1) : input; }

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
    return await this.operations.runCommand(recordId, () => this.dispatchOnce(recordId, request));
  }
  private async dispatchOnce(recordId: string, request: CommandRequest): Promise<CommandResult> {
    const name = commandName(request.command);
    if (!(PANEL_COMMAND_ALLOWLIST as readonly string[]).includes(name)) throw new Error("COMMAND_NOT_ALLOWED");
    const command = name as PanelCommandName; if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string")) throw new Error("COMMAND_ARGS_INVALID");
    if (["commands", "help", "status", "models"].includes(command) && request.args.length) throw new Error("COMMAND_ARGS_INVALID");
    if (command === "commands") return this.result(command, "read", commandCatalog(await this.providers.commands()));
    if (command === "status") return this.result(command, "read", await this.providers.status());
    if (command === "models") return this.result(command, "read", await this.providers.models());
    if (command === "help") return this.result(command, "read", { allowlistVersion: PANEL_COMMAND_ALLOWLIST_VERSION, commands: PANEL_COMMAND_ALLOWLIST });
    const loaded = await this.session(recordId);
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
