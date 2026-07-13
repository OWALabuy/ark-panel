import type { JsonObject, TranscriptDocument } from "./transcript.js";

function object(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function printable(value: unknown): string { if (typeof value === "string") return value; if (value === undefined) return ""; try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function fence(value: string, language = ""): string { const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length)); const marker = "`".repeat(longest + 1); return `${marker}${language}\n${value}\n${marker}`; }

function activeBranch(entries: JsonObject[]): JsonObject[] {
  const byId = new Map(entries.flatMap(entry => typeof entry.id === "string" ? [[entry.id, entry] as const] : []));
  let current = [...entries].reverse().find(entry => typeof entry.id === "string" && object(entry.message)); const ids = new Set<string>();
  while (current && typeof current.id === "string" && !ids.has(current.id)) { ids.add(current.id); current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined; }
  return ids.size ? entries.filter(entry => typeof entry.id === "string" && ids.has(entry.id)) : entries;
}

function blockMarkdown(block: unknown): string {
  if (typeof block === "string") return block; const value = object(block); if (!value) return printable(block); const type = String(value.type ?? "");
  if (type === "text") return printable(value.text);
  if (type === "thinking") return `<details>\n<summary>Thinking</summary>\n\n${printable(value.text ?? value.thinking)}\n\n</details>`;
  if (type === "tool_use" || type === "toolCall") return `**Tool call: ${String(value.name ?? "tool").replace(/[\r\n]+/g, " ")}**\n\n${fence(printable(value.input ?? value.arguments), "json")}`;
  if (type === "tool_result" || type === "toolResult") return `**Tool result${value.isError ? " (error)" : ""}**\n\n${fence(printable(value.content ?? value.result ?? value.text))}`;
  return fence(printable(value), "json");
}

function messageMarkdown(entry: JsonObject): string | undefined {
  const message = object(entry.message); if (!message || typeof message.role !== "string") return undefined;
  const labels: Record<string, string> = { user: "User", assistant: "Assistant", tool: "Tool result", toolResult: "Tool result", system: "System" };
  const role = labels[message.role] ?? message.role.replace(/[\r\n#]+/g, " "); const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : typeof message.timestamp === "string" ? message.timestamp : "";
  let parts: string[];
  if (message.role === "toolResult") parts = [`**Tool result${message.isError ? " (error)" : ""}**\n\n${fence(printable(message.content ?? message.details))}`];
  else if (Array.isArray(message.content)) parts = message.content.map(blockMarkdown).filter(Boolean); else parts = [printable(message.content)].filter(Boolean);
  return `## ${role}${timestamp ? ` · ${timestamp}` : ""}\n\n${parts.join("\n\n") || "_(empty)_"}`;
}

export function exportTranscriptMarkdown(document: TranscriptDocument, title: string, agentId: string, exportedAt = new Date()): string {
  const safeTitle = title.replace(/[\r\n#]+/g, " ").trim() || "Untitled conversation"; const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "");
  const messages = activeBranch(document.entries).map(messageMarkdown).filter((value): value is string => !!value);
  return `# ${safeTitle}\n\n- Agent: ${safeAgent}\n- Exported: ${exportedAt.toISOString()}\n\n${messages.join("\n\n---\n\n")}\n`;
}

export function markdownFilename(title: string): string {
  const base = title.normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "conversation";
  return `${base}.md`;
}
