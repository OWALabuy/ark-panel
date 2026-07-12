import { createHash, randomUUID } from "node:crypto";

export type SourceKind = "active" | "reset" | "panel";

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 32);
}

export function externalRecordId(agentId: string, kind: Exclude<SourceKind, "panel">, stableSource: string): string {
  if (!agentId || !stableSource) throw new Error("稳定标识字段不能为空");
  return `ext_${stableHash(["v1", agentId, kind, stableSource])}`;
}

export function newPanelRecordId(): string { return `panel_${randomUUID()}`; }
