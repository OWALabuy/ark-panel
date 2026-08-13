import sharp from "sharp";

export interface BrowserSuccessScreenshot {
  width: number;
  height: number;
  channels: number;
  uniqueColors: number;
  entropy: number;
}

export async function inspectBrowserSuccessScreenshot(encoded: string, expected: Readonly<{ width: number; height: number }>):
  Promise<BrowserSuccessScreenshot> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("BROWSER_SUCCESS_SCREENSHOT_INVALID_BASE64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("BROWSER_SUCCESS_SCREENSHOT_NOT_PNG");
  }
  const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: expected.width * expected.height })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expected.width || info.height !== expected.height || info.channels !== 4) {
    throw new Error("BROWSER_SUCCESS_SCREENSHOT_DIMENSIONS_MISMATCH");
  }
  const colors = new Set<number>();
  const counts = new Map<number, number>();
  const pixelCount = info.width * info.height;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const color = ((data[offset] ?? 0) << 24) | ((data[offset + 1] ?? 0) << 16) | ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
    colors.add(color); counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) { const probability = count / pixelCount; entropy -= probability * Math.log2(probability); }
  if (colors.size < 16 || entropy < 0.25) throw new Error("BROWSER_SUCCESS_SCREENSHOT_VISUALLY_EMPTY");
  return Object.freeze({ width: info.width, height: info.height, channels: info.channels, uniqueColors: colors.size, entropy });
}
