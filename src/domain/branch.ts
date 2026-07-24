import type { JsonObject, TranscriptDocument } from "./transcript.js";

interface TreeNode {
  id: string;
  parentId: string | null;
  leafId?: string | null;
  appendParentId: string | null;
  entry: JsonObject;
}

const CANONICAL_TYPES = new Set([
  "message", "thinking_level_change", "model_change", "compaction",
  "branch_summary", "custom", "custom_message", "label", "session_info"
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function canonical(entry: JsonObject): boolean {
  return typeof entry.type === "string" && CANONICAL_TYPES.has(entry.type);
}
function leafControl(entry: JsonObject): boolean {
  return entry.type === "leaf";
}
function explicit(entry: JsonObject): Omit<TreeNode, "entry"> | undefined {
  if (!Object.hasOwn(entry, "parentId")) return undefined;
  const id = text(entry.id), parentId = entry.parentId === null ? null : text(entry.parentId);
  if (!id || parentId === undefined) return undefined;
  if (!leafControl(entry)) return {
    id, parentId, ...(canonical(entry) && entry.appendMode !== "side" ? { leafId: id } : {}),
    appendParentId: id
  };
  const targetId = entry.targetId === null ? null : text(entry.targetId);
  const appendParentId = entry.appendParentId === undefined ? targetId :
    entry.appendParentId === null ? null : text(entry.appendParentId);
  if (targetId === undefined || appendParentId === undefined ||
    entry.appendMode !== undefined && entry.appendMode !== "side") return undefined;
  return { id, parentId: targetId, leafId: targetId, appendParentId };
}
function resolveParent(parentId: string | null, byId: ReadonlyMap<string, TreeNode>): string | null {
  const seen = new Set<string>(); let current = parentId;
  while (current !== null) {
    if (seen.has(current)) return current;
    seen.add(current); const node = byId.get(current);
    if (!node || !leafControl(node.entry)) return current;
    current = node.parentId;
  }
  return null;
}

/**
 * Minimal equivalent of OpenClaw 2026.6.11 scanSessionTranscriptTree. It
 * follows leaf controls, side-append cursors, canonical non-message entries,
 * and legacy parentless rows without allowing opaque controls into the result.
 */
export function currentTranscriptBranch(document: TranscriptDocument): TranscriptDocument {
  const nodes: TreeNode[] = [], byId = new Map<string, TreeNode>(), invalidLeafIds = new Set<string>();
  let leafId: string | null = null, appendParentId: string | null = null;
  for (const entry of document.entries) {
    const parsed = explicit(entry);
    const known = (id: string | null): boolean => id === null || byId.has(id) && !invalidLeafIds.has(id);
    if (parsed && leafControl(entry) && (!known(parsed.leafId ?? null) || !known(parsed.appendParentId))) {
      invalidLeafIds.add(parsed.id);
      const invalid: TreeNode = { ...parsed, parentId: entry.parentId as string | null, appendParentId, entry };
      nodes.push(invalid); byId.set(invalid.id, invalid); continue;
    }
    let next = parsed;
    if (!next && canonical(entry) && !Object.hasOwn(entry, "parentId")) {
      const id = text(entry.id);
      if (id) next = { id, parentId: leafId, ...(entry.appendMode !== "side" ? { leafId: id } : {}), appendParentId: id };
    }
    if (!next) continue;
    if (canonical(entry)) {
      const parent = resolveParent(parsed && entry.appendMode !== "side" &&
        next.parentId === appendParentId && leafId !== appendParentId ? leafId : next.parentId, byId);
      next = { ...next, parentId: parent };
    }
    const node: TreeNode = { ...next, entry }; nodes.push(node); byId.set(node.id, node);
    appendParentId = node.appendParentId;
    if (node.leafId !== undefined) leafId = node.leafId;
  }
  if (leafId === null) return { header: document.header, entries: [] };
  const path: TreeNode[] = [], seen = new Set<string>(); let current: string | null = leafId;
  while (current) {
    if (seen.has(current)) return { header: document.header, entries: [] };
    seen.add(current); const node = byId.get(current); if (!node) break;
    if (!leafControl(node.entry)) path.unshift(node);
    current = node.parentId;
  }
  return { header: document.header, entries: path.map(node =>
    node.entry.parentId === node.parentId ? node.entry : { ...node.entry, parentId: node.parentId }) };
}
