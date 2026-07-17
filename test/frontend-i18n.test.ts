import assert from "node:assert/strict";
import test from "node:test";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort();
}

test("Chinese and English catalogs have identical keys and placeholders", async () => {
  const zhCN = (await import(new URL("src/frontend/i18n/zh-CN.js", `file://${process.cwd()}/`).href)).default as Record<string, string>;
  const en = (await import(new URL("src/frontend/i18n/en.js", `file://${process.cwd()}/`).href)).default as Record<string, string>;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
  for (const key of Object.keys(zhCN)) assert.deepEqual(placeholders(en[key]!), placeholders(zhCN[key]!), key);
});
