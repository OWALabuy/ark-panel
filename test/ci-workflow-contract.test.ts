import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

function indentedBlock(source: string, key: string, indent: number): string {
  const lines = source.split("\n"), marker = `${" ".repeat(indent)}${key}:`;
  const start = lines.findIndex(line => line === marker || line.startsWith(`${marker} `));
  assert.notEqual(start, -1, `missing ${key} block`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() && !line.trimStart().startsWith("#") && line.length - line.trimStart().length <= indent) break;
    end++;
  }
  return lines.slice(start, end).join("\n");
}

function directKeys(block: string, indent: number): string[] {
  const pattern = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):`, "u");
  return block.split("\n").map(line => line.match(pattern)?.[1]).filter((key): key is string => key !== undefined);
}

function stepBlocks(job: string): string[] {
  const lines = job.split("\n"), starts = lines.flatMap((line, index) => /^ {6}- /u.test(line) ? [index] : []);
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
}

function stepName(step: string): string {
  const names = [...step.matchAll(/^ {6}- name: (.+)$/gmu)];
  assert.equal(names.length, 1, "each step must have exactly one name");
  return names[0]![1]!;
}

function stepValues(step: string, key: "uses" | "run"): string[] {
  return [...step.matchAll(new RegExp(`^ {8}${key}:\\s+([^\\n]+)$`, "gmu"))]
    .map(match => match[1]!.replace(/\s+#.*$/u, "").trim());
}

function privateFixture(t: TestContext, prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then(root => {
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  });
}

const minimalEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false"
};

function outputOf(result: ReturnType<typeof spawnSync>): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

function assertBoundedFailure(result: ReturnType<typeof spawnSync>): void {
  assert.equal(result.error, undefined, "fault probe must start and finish before its timeout");
  assert.notEqual(result.status, 0, "fault probe must return a non-zero exit status");
  assert.equal(result.signal, null, "fault probe must exit normally rather than by signal");
}

function validateWorkflow(workflow: string): void {
  for (const key of ["on", "permissions", "concurrency", "jobs"]) {
    assert.equal((workflow.match(new RegExp(`^${key}:`, "gmu")) ?? []).length, 1, `top-level ${key} must occur exactly once`);
  }
  const triggers = indentedBlock(workflow, "on", 0);
  assert.deepEqual(directKeys(triggers, 2), ["push", "pull_request"]);
  assert.match(indentedBlock(triggers, "push", 2), /^ {4}branches:\n {6}- main$/mu);

  const permissions = indentedBlock(workflow, "permissions", 0);
  assert.deepEqual(permissions.split("\n").slice(1).filter(line => line.trim()), ["  contents: read"]);
  const concurrency = indentedBlock(workflow, "concurrency", 0);
  assert.match(concurrency, /^ {2}group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}$/mu);
  assert.match(concurrency, /^ {2}cancel-in-progress: true$/mu);

  const jobs = indentedBlock(workflow, "jobs", 0);
  const expected = new Map([
    ["baseline", { name: "Node 22 baseline", timeout: "15", steps: [
      ["Check out repository", "uses", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
      ["Set up Node 22", "uses", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"],
      ["Install dependencies", "run", "npm ci"], ["Typecheck", "run", "npm run typecheck"],
      ["Check frontend JavaScript", "run", "npm run check:frontend"], ["Build and test", "run", "npm test"],
      ["Run browser fixture acceptance", "run", "npm run test:browser"],
      ["Upload sanitized browser failure screenshots", "uses", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]
    ] }],
    ["coverage", { name: "Node 22 coverage baseline", timeout: "15", steps: [
      ["Check out repository", "uses", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
      ["Set up Node 22", "uses", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"],
      ["Install dependencies", "run", "npm ci"], ["Run coverage baseline", "run", "npm run test:coverage"],
      ["Upload coverage reports", "uses", "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"]
    ] }],
    ["deployment-fixture", { name: "Deployment fixture", timeout: "10", steps: [
      ["Check out repository", "uses", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
      ["Set up Node 22", "uses", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"],
      ["Install dependencies", "run", "npm ci"], ["Run deployment fixture", "run", "npm run test:deployment"]
    ] }]
  ] as const);
  assert.deepEqual(directKeys(jobs, 2), [...expected.keys()]);
  for (const [jobId, contract] of expected) {
    const job = indentedBlock(jobs, jobId, 2);
    assert.match(job, new RegExp(`^ {4}name: ${contract.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
    assert.match(job, /^ {4}runs-on: ubuntu-latest$/mu);
    assert.match(job, new RegExp(`^ {4}timeout-minutes: ${contract.timeout}$`, "mu"));
    assert.doesNotMatch(job, /^ {4}(?:if|continue-on-error|needs):/mu);
    const observedSteps = stepBlocks(job); assert.deepEqual(observedSteps.map(stepName), contract.steps.map(step => step[0]));
    for (const [index, [name, kind, value]] of contract.steps.entries()) {
      const step = observedSteps[index]!, values = stepValues(step, kind), other = stepValues(step, kind === "uses" ? "run" : "uses");
      assert.deepEqual(values, [value], `${jobId}/${name} must have exactly one ${kind}`);
      assert.deepEqual(other, [], `${jobId}/${name} must select exactly one action kind`);
      assert.doesNotMatch(step, /^ {8}continue-on-error:/mu);
      if (name === "Check out repository") assert.deepEqual(step.match(/^ {10}persist-credentials: false$/gmu), ["          persist-credentials: false"]);
      if (name === "Set up Node 22") {
        assert.deepEqual(step.match(/^ {10}node-version: '22'$/gmu), ["          node-version: '22'"]);
        assert.deepEqual(step.match(/^ {10}cache: npm$/gmu), ["          cache: npm"]);
        assert.deepEqual(step.match(/^ {10}cache-dependency-path: package-lock\.json$/gmu), ["          cache-dependency-path: package-lock.json"]);
      }
      if (name === "Upload sanitized browser failure screenshots") {
        assert.deepEqual(step.match(/^ {8}if: failure\(\)$/gmu), ["        if: failure()"]);
      } else if (name === "Upload coverage reports") {
        assert.deepEqual(step.match(/^ {8}if: \$\{\{ !cancelled\(\).*hashFiles\('coverage\/lcov\.info'\).*hashFiles\('coverage\/summary\.json'\).*\}\}$/gmu),
          ["        if: ${{ !cancelled() && hashFiles('coverage/lcov.info') != '' && hashFiles('coverage/summary.json') != '' }}"]);
      } else assert.doesNotMatch(step, /^ {8}if:/mu);
    }
  }

  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)].map(match => match[1]!);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u);
  assert.doesNotMatch(workflow, /continue-on-error\s*:|\$\{\{\s*secrets\.|PANEL_ALLOW_(?:PANELTEST_INTEGRATION|STREAM_PROBE|TOOL_RESULT_SCHEMA_PROBE|COMPACTION_LIVE_PROBE|RUNTIME_ACCEPTANCE|CLAUDE_RUNTIME_ACCEPTANCE)|test:(?:paneltest|stream-probe|tool-result-schema-probe|compaction-live-probe|runtime-acceptance|app-paneltest|panel-claude-runtime)/u);
}

test("CI workflow statically locks the deterministic Node 22 contract", async () => {
  validateWorkflow(await readFile(".github/workflows/ci.yml", "utf8"));
});

test("CI workflow validator rejects duplicate roots and disabled jobs or commands", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.throws(() => validateWorkflow(`${workflow}\non:\n  pull_request:\n`), /top-level on must occur exactly once/u);
  assert.throws(() => validateWorkflow(workflow.replace("    name: Node 22 baseline", "    name: Node 22 baseline\n    if: false")));
  assert.throws(() => validateWorkflow(workflow.replace("        run: npm run typecheck", "        run: npm run typecheck\n        continue-on-error: true")));
  assert.throws(() => validateWorkflow(workflow.replace("      - name: Typecheck", "      - uses: fixture/missing-name@0000000000000000000000000000000000000000\n      - name: Typecheck")));
  assert.throws(() => validateWorkflow(workflow.replace("        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        if: false")));
  assert.throws(() => validateWorkflow(workflow.replace("        run: npm run typecheck", "        run: npm run typecheck\n        run: npm test")));
  assert.throws(() => validateWorkflow(workflow.replace("        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")));
});

test("npm ci rejects a package-lock mismatch offline before installation", async t => {
  const root = await privateFixture(t, "ark-panel-ci-lock-fault-");
  await mkdir(join(root, "packages", "locked"), { recursive: true });
  await mkdir(join(root, "packages", "requested"), { recursive: true });
  await writeFile(join(root, "packages", "locked", "package.json"), JSON.stringify({ name: "fixture-only-package", version: "1.0.0" }));
  await writeFile(join(root, "packages", "requested", "package.json"), JSON.stringify({ name: "fixture-only-package", version: "2.0.0" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "ci-lock-fault", version: "1.0.0", private: true,
    dependencies: { "fixture-only-package": "file:packages/requested" } }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "ci-lock-fault", version: "1.0.0", lockfileVersion: 3,
    packages: {
      "": { name: "ci-lock-fault", version: "1.0.0", dependencies: { "fixture-only-package": "file:packages/locked" } },
      "node_modules/fixture-only-package": { version: "1.0.0", resolved: "file:packages/locked" },
      "packages/locked": { name: "fixture-only-package", version: "1.0.0" }
    } }));
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--offline"], {
    cwd: root, env: { ...minimalEnvironment, npm_config_cache: join(root, ".npm-cache") }, encoding: "utf8", timeout: 10_000
  });
  assertBoundedFailure(result);
  assert.ok(/npm ci.*package\.json and package-lock\.json.*sync|Invalid: lock file's fixture-only-package@1\.0\.0 does not satisfy fixture-only-package@2\.0\.0/is.test(outputOf(result)),
    "npm ci must diagnose a package-lock mismatch before installation");
});

test("the project TypeScript CLI rejects a deterministic source error", async t => {
  const root = await privateFixture(t, "ark-panel-ci-typescript-fault-");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["fault.ts"] }));
  await writeFile(join(root, "fault.ts"), "const value: string = 42;\n");
  const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: root, env: minimalEnvironment, encoding: "utf8", timeout: 10_000
  });
  assertBoundedFailure(result);
  assert.ok(/TS2322: Type 'number' is not assignable to type 'string'/u.test(outputOf(result)),
    "TypeScript must diagnose the deterministic assignment error");
});

test("node:test returns non-zero for a failing isolated test", async t => {
  const root = await privateFixture(t, "ark-panel-ci-node-test-fault-");
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test", "fault.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture failure', () => assert.equal(1, 2));\n");
  const result = spawnSync(process.execPath, ["--test", "test/fault.test.mjs"], {
    cwd: root, env: minimalEnvironment, encoding: "utf8", timeout: 10_000
  });
  assertBoundedFailure(result);
  const output = outputOf(result);
  assert.ok(/not ok 1 - fixture failure/u.test(output), "node:test must report the fixture failure");
  assert.ok(/# fail 1/u.test(output), "node:test must report one failed test");
});
