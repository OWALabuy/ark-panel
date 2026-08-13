import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { inspectBrowserSuccessScreenshot } from "./browser-success-screenshot.js";

async function screenshot(width: number, height: number, colors: number): Promise<string> {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const value = index % colors, offset = index * 4;
    data[offset] = value * 17; data[offset + 1] = value * 11; data[offset + 2] = value * 7; data[offset + 3] = 255;
  }
  return (await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()).toString("base64");
}

test("success screenshot inspection accepts a non-empty PNG at the exact viewport", async () => {
  const result = await inspectBrowserSuccessScreenshot(await screenshot(32, 24, 16), { width: 32, height: 24 });
  assert.deepEqual({ width: result.width, height: result.height, channels: result.channels, uniqueColors: result.uniqueColors },
    { width: 32, height: 24, channels: 4, uniqueColors: 16 });
  assert.ok(result.entropy >= 0.25);
});

test("success screenshot inspection rejects malformed, wrong-sized, and visually empty captures", async () => {
  await assert.rejects(inspectBrowserSuccessScreenshot("not-base64!", { width: 32, height: 24 }), /INVALID_BASE64/u);
  await assert.rejects(inspectBrowserSuccessScreenshot(Buffer.from("not png").toString("base64"), { width: 32, height: 24 }), /NOT_PNG/u);
  await assert.rejects(inspectBrowserSuccessScreenshot(await screenshot(31, 24, 16), { width: 32, height: 24 }), /DIMENSIONS_MISMATCH/u);
  await assert.rejects(inspectBrowserSuccessScreenshot(await screenshot(32, 24, 1), { width: 32, height: 24 }), /VISUALLY_EMPTY/u);
});
