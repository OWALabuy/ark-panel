import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("browser failure artifacts are pinned, bounded, and limited to sanitized screenshots", async () => {
  const workflow = await readFile(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
  const upload = workflow.match(/      - name: Upload sanitized browser failure screenshots\n([\s\S]*?)(?=\n  [a-z-]+:|\n      - name:|$)/)?.[1] ?? "";
  const coverageUpload = workflow.match(/      - name: Upload coverage reports\n([\s\S]*?)(?=\n  [a-z-]+:|\n      - name:|$)/)?.[1] ?? "";
  assert.equal(workflow.match(/- name: Upload sanitized browser failure screenshots/g)?.length, 1);
  assert.match(upload, /if: failure\(\)/);
  assert.match(upload, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.match(upload, /browser-artifacts\/desktop\.png/);
  assert.match(upload, /browser-artifacts\/mobile\.png/);
  assert.match(upload, /if-no-files-found: warn/);
  assert.match(upload, /retention-days: 3/);
  assert.doesNotMatch(upload, /browser-artifacts\/\*|browser-artifacts\/$/m);
  assert.equal(workflow.match(/- name: Upload coverage reports/g)?.length, 1);
  assert.match(coverageUpload, /if: \$\{\{ !cancelled\(\) && hashFiles\('coverage\/lcov\.info'\) != '' && hashFiles\('coverage\/summary\.json'\) != '' \}\}/);
  assert.match(coverageUpload, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/);
  assert.match(coverageUpload, /coverage\/lcov\.info/);
  assert.match(coverageUpload, /coverage\/summary\.json/);
  assert.match(coverageUpload, /if-no-files-found: error/);
  assert.equal(workflow.match(/actions\/upload-artifact@/g)?.length, 2);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
});

test("browser harness preserves primary failures and diagnoses bounded cleanup", async () => {
  const harness = await readFile(join(process.cwd(), "test/browser-acceptance.test.mjs"), "utf8");
  assert.match(harness, /Object\.freeze\(\{\s*desktop: resolve\(FAILURE_ROOT, "desktop\.png"\),\s*mobile: resolve\(FAILURE_ROOT, "mobile\.png"\)/);
  assert.match(harness, /SCREENSHOT_CAPTURE_FAILED/);
  assert.match(harness, /SCREENSHOT_WRITE_FAILED/);
  assert.match(harness, /DRIVER_QUIT_FAILED/);
  assert.match(harness, /browser\.service\.kill\(\)/);
  assert.match(harness, /throw primaryError/);
  assert.doesNotMatch(harness, /driver\.quit\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(harness, /PANEL_BROWSER_ARTIFACT_DIR/);
});
