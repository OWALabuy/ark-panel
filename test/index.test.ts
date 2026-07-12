import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importResetSnapshot, rebuildIndex, scanAgent } from "../src/storage/index.js";

const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-11T00:00:00Z" }) + "\n";

test("扫描 active/reset，忽略 deleted/trajectory，并可稳定重建索引", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-index-"));
  const sessions = join(root, "sessions"); const data = join(root, "data");
  await mkdir(sessions); await mkdir(data);
  const uuid = "11111111-1111-4111-8111-111111111111";
  await writeFile(join(sessions, `${uuid}.jsonl`), header(uuid));
  await writeFile(join(sessions, `${uuid}.jsonl.reset.2026-07-11T00-00-00Z`), header(uuid));
  await writeFile(join(sessions, `${uuid}.jsonl.deleted.x`), header(uuid));
  await writeFile(join(sessions, `${uuid}.trajectory.jsonl`), "{}\n");
  const agent = { agentId: "fixture", sessionsRoot: sessions };
  const first = await scanAgent(agent);
  assert.deepEqual(first.map((r) => r.sourceKind).sort(), ["active", "reset"]);
  const reset = first.find((r) => r.sourceKind === "reset")!;
  const imported = await importResetSnapshot(agent, reset, data);
  assert.ok(imported.snapshotPath);
  const indexPath = join(data, "index.json");
  const rebuilt1 = await rebuildIndex([agent], indexPath);
  const rebuilt2 = await rebuildIndex([agent], indexPath);
  assert.deepEqual(rebuilt1.map((r) => r.recordId), rebuilt2.map((r) => r.recordId));
  assert.equal(JSON.parse(await readFile(indexPath, "utf8")).records.length, 2);
});
