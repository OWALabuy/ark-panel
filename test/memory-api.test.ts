import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PanelMemoryApi } from "../src/server/memory-api.js";
import type { MemoryConsolidationStore, MemoryLedgerEntry } from "../src/storage/memory-consolidation.js";
import { tempFixture } from "./test-helpers.js";

test("PanelMemoryApi rejects unknown agents with a stable safe error", async () => {
  const api = new PanelMemoryApi(new Map());
  for (const operation of [() => api.list("missing"), () => api.read("missing", "MEMORY.md")]) {
    await assert.rejects(operation, error => {
      assert.equal((error as Error).message, "MEMORY_AGENT_NOT_CONFIGURED");
      return true;
    });
  }
});

test("PanelMemoryApi lists files and decorates only matching confirmed sources", async t => {
  const workspace = await tempFixture(t, "panel-memory-api-list-");
  await mkdir(join(workspace, "memory"));
  const memoryPath = join(workspace, "MEMORY.md"), notesPath = join(workspace, "memory", "notes.md");
  await writeFile(memoryPath, "# Durable memory\n");
  await writeFile(notesPath, "- Daily note\n");
  const older = new Date("2026-08-10T00:00:00.000Z"), newer = new Date("2026-08-11T00:00:00.000Z");
  await utimes(memoryPath, older, older); await utimes(notesPath, newer, newer);
  const confirmedAt = "2026-08-12T00:00:00.000Z";
  const ledger = (agentId: string, recordId: string, targetPath: string): MemoryLedgerEntry => ({
    batchId: "11111111-1111-4111-8111-111111111111",
    agentId,
    recordId,
    sourceKind: "panel",
    sourceRevision: "fixture-revision",
    fromEntryId: "entry-1",
    throughEntryId: "entry-2",
    contentHash: "fixture-hash",
    targetPath,
    createdAt: confirmedAt,
    confirmedAt,
    status: "confirmed"
  });
  let ledgerReads = 0;
  const consolidation = {
    async ledgers() {
      ledgerReads++;
      return [
        ledger("agent", "matching-record", "MEMORY.md"),
        ledger("other-agent", "other-record", "memory/notes.md"),
        ledger("agent", "missing-record", "memory/missing.md")
      ];
    }
  } as unknown as MemoryConsolidationStore;
  const workspaces = new Map([["agent", workspace]]);
  const decorated = await new PanelMemoryApi(workspaces, consolidation).list("agent");
  assert.equal(ledgerReads, 1);
  assert.deepEqual(decorated.find(file => file.path === "MEMORY.md")?.source, { recordId: "matching-record", confirmedAt });
  assert.equal(decorated.find(file => file.path === "memory/notes.md")?.source, undefined);
  assert.equal(decorated.some(file => file.path === "memory/missing.md"), false);

  await utimes(notesPath, older, older);
  const undecorated = await new PanelMemoryApi(workspaces).list("agent");
  assert.ok(undecorated.every(file => file.source === undefined));
});

test("PanelMemoryApi delegates allowed reads and preserves safe storage errors", async t => {
  const workspace = await tempFixture(t, "panel-memory-api-read-");
  await mkdir(join(workspace, "memory"));
  await writeFile(join(workspace, "memory", "notes.md"), "- Delegated content\n");
  const api = new PanelMemoryApi(new Map([["agent", workspace]]));

  const document = await api.read("agent", "memory/notes.md");
  assert.equal(document.content, "- Delegated content\n");
  assert.equal(document.path, "memory/notes.md");
  await assert.rejects(api.read("agent", "OTHER.md"), error => {
    assert.equal((error as Error).message, "MEMORY_PATH_NOT_ALLOWED");
    assert.doesNotMatch((error as Error).message, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    return true;
  });
});
