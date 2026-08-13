import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedExclusions = [
  "src/gateway/paneltest-smoke.ts",
  "src/gateway/runtime-acceptance-cli.ts",
  "src/gateway/stream-probe.ts",
  "src/gateway/tool-result-schema-probe-cli.ts",
  "src/ops/backup-cli.ts",
  "src/ops/deployment-smoke.ts",
  "src/server/main.ts",
  "src/server/panel-claude-runtime-smoke.ts",
  "src/server/paneltest-app-smoke.ts"
];

const expectedTestHarnessExclusions = [
  "browser-cleanup-races.test.js",
  "browser-cleanup.test.js",
  "browser-startup-ownership.test.js",
  "geckodriver-launcher.test.js",
  "geckodriver-service.test.js",
  "linux-process-supervisor-races.test.js",
  "linux-process-supervisor.test.js"
];

test("coverage isolation preserves the dynamic inventory, gates, and explicit exclusions", async () => {
  const source = await readFile("scripts/test-coverage.mjs", "utf8");
  assert.match(source, /const thresholds = Object\.freeze\(\{ lines: 90, branches: 78, functions: 89 \}\);/);
  assert.equal(source.match(/--experimental-test-isolation=none/g)?.length, 1);
  assert.match(source, /const sourceFiles = \(await filesBelow\(join\(repositoryRoot, "src"\), "\.ts"\)\)/);
  assert.match(source, /assertSameFiles\(includedCompiled, includedSources\.map\(compiledPath\), "TypeScript-to-JavaScript coverage inventory"\)/);
  assert.doesNotMatch(source, /fileCount\s*[!=]==?\s*39/);

  const exclusionBlock = source.match(/const exclusions = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  const actualExclusions = [...exclusionBlock.matchAll(/^  "([^"]+)":/gm)].map(match => match[1]).sort();
  assert.deepEqual(actualExclusions, [...expectedExclusions].sort());

  const testExclusionBlock = source.match(/const testHarnessExclusions = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  const actualTestExclusions = [...testExclusionBlock.matchAll(/^  "([^"]+)":/gm)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(actualTestExclusions, [...expectedTestHarnessExclusions].sort());
  assert.match(source, /assertSameFiles\(excludedTestFiles, expectedExcludedTestFiles, "coverage test-harness exclusions"\)/);
  assert.match(source, /runCoverage\(coverageTestFiles, compiledExclusions\)/);
  assert.match(source, /testExclusions: excludedTestNames\.sort\(\)\.map\(name => \(\{ name, reason: testHarnessExclusions\[name\] \}\)\)/);
});

test("ordinary tests and the CI baseline retain default process isolation", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.equal(packageJson.scripts.test, "npm run build && node --test dist/test/**/*.test.js");
  assert.equal(packageJson.scripts["test:coverage"], "npm run build && node scripts/test-coverage.mjs");
  assert.doesNotMatch(packageJson.scripts.test, /test-isolation/);

  const baseline = workflow.match(/  baseline:\n([\s\S]*?)(?=\n  [a-z-]+:)/)?.[1] ?? "";
  const coverage = workflow.match(/  coverage:\n([\s\S]*?)(?=\n  [a-z-]+:)/)?.[1] ?? "";
  assert.match(baseline, /run: npm test/);
  assert.doesNotMatch(baseline, /test-isolation|test:coverage/);
  assert.match(coverage, /run: npm run test:coverage/);
});
