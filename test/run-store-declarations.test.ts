import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("active-run 测试 seam 不进入公开 TypeScript 声明", async () => {
  const runStore = await readFile("dist/src/server/run-store.d.ts", "utf8");
  const generation = await readFile("dist/src/server/generation-api.d.ts", "utf8");
  assert.deepEqual(runStore.match(/^\s+constructor\(.*$/gm), ["    constructor(dataRoot: string);"]);
  assert.deepEqual(generation.match(/^\s+constructor\(.*$/gm), [
    "    constructor(bridge: BridgeRunner, config: GenerationConfig);"
  ]);

  const config = generation.match(/export interface GenerationConfig \{[\s\S]*?\n\}/)?.[0];
  assert.ok(config); assert.doesNotMatch(config, /runStore|instrumentation|writer|hook/i);
  for (const seam of ["PanelRunStoreInstrumentation", "PanelRunStoreWriter", "runStoreInstrumentation",
    "runStoreWriter", "beforeRecordRead", "onDirectoryScan", "onRecordRead", "writeRunRecord", "createRunStore",
    "PanelRunStoreTestHooks", "PanelGenerationApiTestHooks", "testHooks"]) {
    assert.equal(runStore.includes(seam) || generation.includes(seam), false, `${seam} leaked into generated declarations`);
  }
});
