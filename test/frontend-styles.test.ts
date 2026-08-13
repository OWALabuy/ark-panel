import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applicationStylesheetHrefs, readApplicationStyles } from "./frontend-styles.js";

const BASELINE_INVENTORY_FINGERPRINT = "d910da5d54f1c46388a1ecee3e474f47938511b2a79b30f8c974742f10ea2265";
const TOKENS_THEMES_ORDERED_FINGERPRINT = "d1f5e91d299d6fd70d23a569113ee22d0d20d78a98bdfd8f0c286cd542610e61";
const SHELL_NAVIGATION_ORDERED_FINGERPRINT = "5b855c56366188d9135d2c78ae57cc46083f39ae337894ddd6054a8799979ffb";
const CONVERSATION_COMPOSER_ORDERED_FINGERPRINT = "b08cf93514aa210bc8022c85a8103f2d187e90965bac5d20a08e69d62eb7c575";
const SETTINGS_MEMORY_ORDERED_FINGERPRINT = "7062bbac02b0f5175e38a6e9a69a8aa805550742993163fc3b063d5bc4c00d3c";
const REMAINING_STYLES_ORDERED_FINGERPRINT = "88ba38e8e442ee23580d7ba56f44544b0b3de81049f590a68d9becc582975b08";
const RESPONSIVE_ORDERED_FINGERPRINT = "7cbb1e3d54a0f4c938b4a6cb8e704b24a5d06be9c033b02856118ec77d5974a5";

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

test("application semantic stylesheets load in their explicit cascade order", async () => {
  assert.deepEqual(await applicationStylesheetHrefs(), ["/tokens-themes.css", "/shell-navigation.css", "/conversation-composer.css", "/settings-memory.css", "/styles.css", "/responsive.css"]);
});

test("the application styles preserve the monolithic CSS rule inventory", async () => {
  assert.equal(fingerprint(stylesheetStatements(await readApplicationStyles()).sort()), BASELINE_INVENTORY_FINGERPRINT);
});

test("the token, shell, and remaining layers preserve their ordered responsibilities", async () => {
  const source=(await readFile("src/frontend/tokens-themes.css","utf8")).replace(/\/\*[\s\S]*?\*\//g,"");
  const properties=[...source.matchAll(/\{([^{}]*)\}/g)].flatMap(match=>match[1]!.split(";")
    .map(declaration=>declaration.trim()).filter(Boolean).map(declaration=>declaration.slice(0,declaration.indexOf(":")).trim()));
  assert.ok(properties.length>100,"expected the complete appearance token inventory");
  assert.deepEqual(properties.filter(property=>property!=="color-scheme"&&!property.startsWith("--")),[]);
  assert.equal(fingerprint(stylesheetStatements(source)),TOKENS_THEMES_ORDERED_FINGERPRINT);
  const shell=await readFile("src/frontend/shell-navigation.css","utf8");
  assert.equal(fingerprint(stylesheetStatements(shell)),SHELL_NAVIGATION_ORDERED_FINGERPRINT);
  assert.match(shell,/\.shell\{height:100vh;height:100dvh;/);
  assert.match(shell,/\.session-quick-menu\.opens-up \.session-quick-actions\{top:auto;bottom:46px\}/);
  assert.match(shell,/\.shell\.sidebar-collapsed\{grid-template-columns:60px minmax\(0,1fr\)\}/);
  assert.doesNotMatch(shell,/@media|\.conversation|\.composer|\.settings|\.memory|\.login/);
  const conversation=await readFile("src/frontend/conversation-composer.css","utf8");
  assert.equal(fingerprint(stylesheetStatements(conversation)),CONVERSATION_COMPOSER_ORDERED_FINGERPRINT);
  assert.match(conversation,/\.conversation\{min-width:0;[^}]*display:flex;flex-direction:column\}/);
  assert.match(conversation,/\.composer\.dragging\{border-color:var\(--accent\)/);
  assert.match(conversation,/\.image-preview-dialog>img\{min-height:0;flex:1;height:auto\}/);
  assert.doesNotMatch(conversation,/@media|\.settings|\.memory|\.login|\.agents|\.sessions|\.session-quick/);
  const settingsMemory=await readFile("src/frontend/settings-memory.css","utf8");
  assert.equal(fingerprint(stylesheetStatements(settingsMemory)),SETTINGS_MEMORY_ORDERED_FINGERPRINT);
  assert.match(settingsMemory,/\.settings-drawer\{position:absolute;[^}]*display:flex;flex-direction:column/);
  assert.match(settingsMemory,/\.memory-page\{grid-column:2\/4;[^}]*display:grid/);
  assert.match(settingsMemory,/\.shell\.show-memory>\.sessions,\.shell\.show-memory>\.conversation\{display:none\}/);
  assert.match(settingsMemory,/\.memory-tree-group button\{position:relative;display:grid/);
  assert.doesNotMatch(settingsMemory,/@media|\.composer|\.login|\.sessions header|\.editor-dialog/);
  const remaining=await readFile("src/frontend/styles.css","utf8");
  assert.equal(fingerprint(stylesheetStatements(remaining)),REMAINING_STYLES_ORDERED_FINGERPRINT);
  assert.doesNotMatch(remaining,/@media/);
  const responsive=await readFile("src/frontend/responsive.css","utf8");
  assert.equal(fingerprint(stylesheetStatements(responsive)),RESPONSIVE_ORDERED_FINGERPRINT);
  assert.match(responsive,/@media\(max-width:760px\)\{\.shell\{display:block\}/);
  assert.match(responsive,/:root\{--visual-viewport-height:100dvh;--visual-viewport-top:0px\}/);
  assert.match(responsive,/\.memory-candidate-dialog\{width:min\(760px,calc\(100% - 28px\)\)\}/);
  assert.match(responsive,/@media\(max-width:760px\),\(hover:none\)[\s\S]*\.session-quick-action\{min-height:44px;padding:8px 10px/);
});
