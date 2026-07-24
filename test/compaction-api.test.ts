import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelSession, loadPanelSession } from "../src/storage/panel-sessions.js";
import { PanelCompactionApi } from "../src/server/compaction-api.js";
import { SessionOperationCoordinator } from "../src/server/session-operation.js";

test("compact 使用当前 overrides、原子追加唯一 entry，并拒绝 revision race", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-api-")), operations = new SessionOperationCoordinator();
  await createPanelSession(root, "agent", { header: { type: "session" }, entries: [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "fixture" } }
  ] }, { recordId: "record" });
  const seen: unknown[] = [], entry = { type: "compaction", id: "c1", parentId: "u1", summary: "summary", firstKeptEntryId: "u1", tokensBefore: 12 };
  const api = new PanelCompactionApi({ async compact(request) { seen.push(request); return { compacted: true, entry }; } },
    { dataRoot: root, runtimeByAgent: new Map([["agent", "runtime"]]), operations });
  const result = await api.compact("record");
  assert.equal(result.compacted, true); assert.equal((await loadPanelSession(root, "agent", "record")).document.entries.at(-1)?.type, "compaction");
  assert.equal((seen[0] as { runtimeAgentId: string }).runtimeAgentId, "runtime");
  await assert.rejects(api.compact("record", "stale"), /REVISION_CONFLICT/);
});

test("compact 与生成互斥时立即 SESSION_BUSY，不排队", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-compact-busy-")), operations = new SessionOperationCoordinator();
  await createPanelSession(root, "agent", { header: { type: "session" }, entries: [{ type: "message", id: "u", parentId: null, message: { role: "user" } }] }, { recordId: "record" });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const running = operations.runGeneration("record", async () => await gate);
  const api = new PanelCompactionApi({ async compact() { return { compacted: false }; } },
    { dataRoot: root, runtimeByAgent: new Map([["agent", "runtime"]]), operations });
  await assert.rejects(api.compact("record"), /SESSION_BUSY/); release(); await running;
});
