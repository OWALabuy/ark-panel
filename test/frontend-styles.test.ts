import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applicationStylesheetHrefs, readApplicationStyles } from "./frontend-styles.js";

const BASELINE_INVENTORY_FINGERPRINT = "d910da5d54f1c46388a1ecee3e474f47938511b2a79b30f8c974742f10ea2265";
const TOKENS_THEMES_ORDERED_FINGERPRINT = "d1f5e91d299d6fd70d23a569113ee22d0d20d78a98bdfd8f0c286cd542610e61";
const COMPONENTS_ORDERED_FINGERPRINT = "795913baf11aad7bb63f5beb544ab904fa6191a6f7806c9d6d03b210fb26073b";

function stylesheetStatements(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const statements: string[] = [];
  let start = 0, depth = 0, quote = "", escaped = false;
  for (let index = 0; index < withoutComments.length; index++) {
    const character = withoutComments[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      const statement = withoutComments.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  if (quote || depth !== 0 || withoutComments.slice(start).trim()) throw new Error("invalid stylesheet structure");
  return statements;
}

function fingerprint(statements: string[]): string {
  return createHash("sha256").update(statements.join("\n")).digest("hex");
}

test("application stylesheets load tokens and themes before component rules", async () => {
  assert.deepEqual(await applicationStylesheetHrefs(), ["/tokens-themes.css", "/styles.css"]);
});

test("the application styles preserve the monolithic CSS rule inventory", async () => {
  assert.equal(fingerprint(stylesheetStatements(await readApplicationStyles()).sort()), BASELINE_INVENTORY_FINGERPRINT);
});

test("the token and theme layer contains no component declarations", async () => {
  const source=(await readFile("src/frontend/tokens-themes.css","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const properties=[...source.matchAll(/\{([^{}]*)\}/g)].flatMap(match=>match[1]!.split(";")
    .map(declaration=>declaration.trim()).filter(Boolean).map(declaration=>declaration.slice(0,declaration.indexOf(":")).trim()));
  assert.ok(properties.length>100,"expected the complete appearance token inventory");
  assert.deepEqual(properties.filter(property=>property!=="color-scheme"&&!property.startsWith("--")),[]);
  assert.equal(fingerprint(stylesheetStatements(source)),TOKENS_THEMES_ORDERED_FINGERPRINT);
  assert.equal(fingerprint(stylesheetStatements(await readFile("src/frontend/styles.css","utf8"))),COMPONENTS_ORDERED_FINGERPRINT);
});
