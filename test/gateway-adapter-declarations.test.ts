import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Gateway adapter 只公开协议契约，generation 由 BridgeService 编排", async () => {
  const [adapter, bridgeService] = await Promise.all([
    readFile("dist/src/gateway/adapter.d.ts", "utf8"),
    readFile("dist/src/gateway/bridge-service.d.ts", "utf8")
  ]);

  assert.equal(adapter.includes("runBridge"), false);
  assert.equal(bridgeService.split("\n").some(line =>
    line.trim() === "generate(request: BridgeRequest): Promise<BridgeResult>;"), true);
});
