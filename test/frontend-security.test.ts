import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("frontend renders untrusted metadata with DOM text nodes", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  assert.doesNotMatch(source,/\.innerHTML\s*=/);
  assert.match(source,/textContent=/);
  assert.match(source,/text\/event-stream/);
  assert.match(source,/\/search\?q=/);
  assert.match(source,/\/fork/);
  assert.match(source,/\/resend/);
  assert.match(source,/activeRevision/);
  assert.doesNotMatch(source,/\bprompt\s*\(/);
  assert.match(source,/showModal\(\)/);
  assert.match(source,/addEventListener\("cancel"/);
  assert.match(source,/trimStart\(\)\.startsWith\("\/"\)/);
  assert.match(source,/\/auth\/logout/);
  assert.match(source,/\/revisions\?agentId=/);
  assert.match(source,/block\.input\?\?block\.arguments/);
  assert.match(source,/block\.text\?\?block\.thinking/);
  assert.match(source,/function activeBranch\(entries\)/);
  assert.match(source,/role!=="toolResult"/);
  assert.match(source,/activeRun\.abort\(\)/);
  assert.doesNotMatch(source,/\/compact|\/reset/);
});
