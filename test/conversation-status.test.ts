import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type StatusHelpers = {
  compactTokenCount(value: unknown, locale?: string): string;
};

async function statusHelpers(): Promise<StatusHelpers> {
  const url = pathToFileURL(join(process.cwd(), "src/frontend/conversation-status.js")).href;
  return await import(`${url}?compact-token-count`) as StatusHelpers;
}

test("compact token counts keep useful precision around the k boundary", async () => {
  const { compactTokenCount } = await statusHelpers();
  assert.equal(compactTokenCount(0, "en"), "0");
  assert.equal(compactTokenCount(999, "en"), "999");
  assert.equal(compactTokenCount(1000, "en"), "1k");
  assert.equal(compactTokenCount(1499, "en"), "1.5k");
  assert.equal(compactTokenCount(9999, "en"), "10k");
  assert.equal(compactTokenCount(10_000, "en"), "10k");
  assert.equal(compactTokenCount(127_013, "en"), "127k");
  assert.equal(compactTokenCount(1_000_000, "en"), "1000k");
});

test("compact token counts reject invalid values and clamp negative estimates", async () => {
  const { compactTokenCount } = await statusHelpers();
  assert.equal(compactTokenCount(-1, "en"), "0");
  assert.equal(compactTokenCount(Number.NaN, "en"), "");
  assert.equal(compactTokenCount(Number.POSITIVE_INFINITY, "en"), "");
});
