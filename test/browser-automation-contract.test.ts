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
  const cleanup = await readFile(join(process.cwd(), "test/browser-cleanup.ts"), "utf8");
  const ownership = await readFile(join(process.cwd(), "test/browser-startup-ownership.ts"), "utf8");
  const service = await readFile(join(process.cwd(), "test/geckodriver-service.ts"), "utf8");
  const fakeService = await readFile(join(process.cwd(), "test/fixtures/fake-geckodriver.mjs"), "utf8");
  const supervisor = await readFile(join(process.cwd(), "test/linux-process-supervisor.ts"), "utf8");
  assert.match(harness, /Object\.freeze\(\{\s*desktop: resolve\(FAILURE_ROOT, "desktop\.png"\),\s*mobile: resolve\(FAILURE_ROOT, "mobile\.png"\)/);
  assert.match(harness, /SCREENSHOT_CAPTURE_FAILED/);
  assert.match(harness, /SCREENSHOT_WRITE_FAILED/);
  assert.match(harness, /BrowserCleanupController/);
  assert.match(harness, /cleanup\.beginStartup\(\)/);
  assert.match(harness, /attachOwnedProcessesOrStop\(cleanup, service, CLEANUP_MS\)/);
  assert.match(harness, /attachDriverOrQuit\(cleanup, driver, CLEANUP_MS\)/);
  assert.match(harness, /attachFixtureOrClose\(cleanup, fixture, CLEANUP_MS\)/);
  assert.match(harness, /t\.after\(async \(\) =>/);
  assert.match(harness, /cleanup\.armWatchdog\(options\.watchdogMs\)/);
  const numericConstants = new Map([...harness.matchAll(
    /const ([A-Z_]+) = ([A-Z_]+ \* \d+|[A-Z_]+ \+ [A-Z_]+|[\d_]+);/g
  )].map(match => [match[1], match[2]]));
  const evaluate = (name: string): number => {
    const expression = numericConstants.get(name);
    assert.ok(expression, `missing browser timeout constant ${name}`);
    if (/^[\d_]+$/.test(expression)) return Number(expression.replaceAll("_", ""));
    const multiplied = /^([A-Z_]+) \* (\d+)$/.exec(expression);
    if (multiplied?.[1] && multiplied[2]) return evaluate(multiplied[1]) * Number(multiplied[2]);
    const added = /^([A-Z_]+) \+ ([A-Z_]+)$/.exec(expression);
    if (added?.[1] && added[2]) return evaluate(added[1]) + evaluate(added[2]);
    throw new Error(`unsupported browser timeout expression ${expression}`);
  };
  const worstCleanup = evaluate("CLEANUP_WORST_CASE_MS");
  const margin = evaluate("CLEANUP_MARGIN_MS");
  assert.ok(evaluate("CLEANUP_HOOK_MS") >= worstCleanup + margin);
  assert.ok(evaluate("DESKTOP_WATCHDOG_MS") + worstCleanup + margin < evaluate("DESKTOP_TEST_TIMEOUT_MS"));
  assert.ok(evaluate("MOBILE_WATCHDOG_MS") + worstCleanup + margin < evaluate("MOBILE_TEST_TIMEOUT_MS"));
  assert.match(harness, /new Executor\(new HttpClient\(endpoint\.origin\)\)/);
  assert.match(harness, /capabilities\.get\("moz:processID"\)/);
  assert.match(harness, /service\.owns\(browserProcessId\)/);
  assert.match(cleanup, /DRIVER_QUIT_TIMED_OUT/);
  assert.match(cleanup, /diagnostics\.push\("SCENARIO_WATCHDOG_TRIGGERED"\)/);
  assert.match(cleanup, /await this\.#startupBarrier/);
  assert.match(ownership, /fixture\.close\(\)/);
  assert.match(ownership, /processes\.stop\(\)/);
  assert.match(ownership, /driver\.quit\(\)/);
  assert.match(supervisor, /startTimeTicks/);
  assert.match(supervisor, /stableEmptyListings >= 2/);
  assert.match(service, /detached: true/);
  assert.match(service, /"--port", "0"/);
  assert.match(service, /ownsLoopbackListener/);
  assert.doesNotMatch(fakeService, /setTimeout\(\(\) => process\.exit\(0\), \d[\d_]*\)\.unref\(\)/,
    "the default fake target must live until supervised cleanup, not a blind deadline");
  const buildDriver = harness.indexOf("async function buildDriver");
  const scenario = harness.indexOf("async function scenario");
  assert.ok(buildDriver >= 0 && scenario >= 0);
  assert.ok(harness.indexOf("attachOwnedProcessesOrStop", buildDriver)
    < harness.indexOf("waitForOwnedGeckodriverStatus", buildDriver));
  assert.ok(harness.indexOf("attachDriverOrQuit", buildDriver)
    < harness.indexOf("driver.getSession", buildDriver));
  assert.ok(harness.indexOf("t.after(async () =>", scenario)
    < harness.indexOf("clearFailureScreenshot(name)", scenario));
  assert.ok(harness.indexOf("cleanup.armWatchdog", scenario)
    < harness.indexOf("startBrowserFixture()", scenario));
  assert.match(harness, /throw primaryError/);
  assert.doesNotMatch(harness, /driver\.quit\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(`${harness}\n${cleanup}\n${ownership}\n${service}\n${supervisor}`,
    /pkill|killall|process\.kill\(-/);
  assert.doesNotMatch(harness, /PANEL_BROWSER_ARTIFACT_DIR/);
});
