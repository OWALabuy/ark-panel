import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coverageRoot = join(repositoryRoot, "coverage");
const inventoryPath = join(coverageRoot, "inventory.test.mjs");
const inventoryLcovPath = join(coverageRoot, "inventory.lcov.info");
const lcovPath = join(coverageRoot, "lcov.info");
const summaryPath = join(coverageRoot, "summary.json");

const thresholds = Object.freeze({ lines: 90, branches: 78, functions: 89 });
const exclusions = Object.freeze({
  "src/gateway/paneltest-smoke.ts": "requires a real OpenClaw test agent and gateway",
  "src/gateway/runtime-acceptance-cli.ts": "live runtime acceptance command entry point",
  "src/gateway/stream-probe.ts": "requires a real authenticated OpenClaw gateway",
  "src/ops/backup-cli.ts": "manual operations command entry point; backup logic remains included",
  "src/ops/deployment-smoke.ts": "deployment entry point covered by the isolated deployment fixture job",
  "src/server/main.ts": "production startup and dependency-composition entry point",
  "src/server/panel-claude-runtime-smoke.ts": "requires an explicitly authorized live runtime",
  "src/server/paneltest-app-smoke.ts": "requires an explicitly configured OpenClaw test runtime"
});
const testHarnessExclusions = Object.freeze({
  "browser-cleanup-races.test.js": "test-only browser startup and cleanup race harness",
  "browser-cleanup.test.js": "test-only browser cleanup controller harness",
  "browser-startup-ownership.test.js": "test-only browser startup ownership harness",
  "geckodriver-launcher.test.js": "Linux process and IPC fixture; no dist/src module coverage",
  "geckodriver-service.test.js": "Linux process and socket ownership fixture; no dist/src module coverage",
  "linux-process-supervisor-races.test.js": "Linux /proc race fixture; no dist/src module coverage",
  "linux-process-supervisor.test.js": "Linux /proc process fixture; no dist/src module coverage"
});

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

async function filesBelow(directory, suffix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(repositoryPath(path));
  }
  return files.sort();
}

function compiledPath(sourcePath) {
  return `dist/${sourcePath.slice(0, -3)}.js`;
}

function setDifference(left, right) {
  return [...left].filter(item => !right.has(item)).sort();
}

function assertSameFiles(actualFiles, expectedFiles, description) {
  const actual = new Set(actualFiles), expected = new Set(expectedFiles);
  if (actual.size !== actualFiles.length || expected.size !== expectedFiles.length) {
    throw new Error(`${description} contains duplicate paths`);
  }
  const missing = setDifference(expected, actual), unexpected = setDifference(actual, expected);
  if (missing.length || unexpected.length) {
    throw new Error(`${description} mismatch: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`);
  }
}

function inventorySource(files) {
  const imports = files.map(path => `    await import(new URL(${JSON.stringify(`../${path}`)}, import.meta.url));`).join("\n");
  return `import test from "node:test";\n\n` +
    `test("coverage inventory imports every non-excluded core module", async () => {\n${imports}\n});\n`;
}

function coverageArguments(compiledExclusions) {
  return [
    "--experimental-test-coverage",
    // Node 22's process-isolated LCOV merge can add 95 zero-hit ranges for the same URL.
    // Keep coverage-only tests in one isolate; ordinary npm test retains process isolation.
    "--experimental-test-isolation=none",
    "--test-coverage-include=dist/src/**/*.js",
    ...compiledExclusions.map(path => `--test-coverage-exclude=${path}`)
  ];
}

async function runNode(arguments_, stdio = ["ignore", "inherit", "inherit"]) {
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: repositoryRoot, stdio });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`coverage test runner terminated by ${signal}`));
      else accept(code ?? 1);
    });
  });
}

async function runCoverage(testFiles, compiledExclusions) {
  const arguments_ = [
    "--test",
    "--test-concurrency=1",
    ...coverageArguments(compiledExclusions),
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${repositoryPath(lcovPath)}`,
    ...testFiles
  ];
  return await runNode(arguments_);
}

function lcovCount(record, name) {
  const match = record.match(new RegExp(`^${name}:(\\d+)$`, "mu"));
  if (!match) throw new Error(`LCOV record is missing ${name}`);
  return Number(match[1]);
}

function percentage(covered, total) {
  return total === 0 ? 100 : Math.round(covered / total * 10_000) / 100;
}

function metric(covered, total) {
  return { covered, total, percent: percentage(covered, total) };
}

function parseLcov(value) {
  const files = [];
  for (const record of value.split("end_of_record").map(item => item.trim()).filter(Boolean)) {
    const source = record.match(/^SF:(.+)$/mu)?.[1];
    if (!source) throw new Error("LCOV record is missing SF");
    files.push({
      path: source.replace(/^\.\//u, ""),
      record,
      lines: metric(lcovCount(record, "LH"), lcovCount(record, "LF")),
      branches: metric(lcovCount(record, "BRH"), lcovCount(record, "BRF")),
      functions: metric(lcovCount(record, "FNH"), lcovCount(record, "FNF"))
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function zeroLcovRecord(record) {
  return record.split("\n").map(line => {
    if (/^FNDA:/u.test(line)) return line.replace(/^FNDA:\d+,/u, "FNDA:0,");
    if (/^FNH:/u.test(line)) return "FNH:0";
    if (/^BRDA:/u.test(line)) return line.replace(/^(BRDA:[^,]+,[^,]+,[^,]+),.*$/u, "$1,0");
    if (/^BRH:/u.test(line)) return "BRH:0";
    if (/^DA:/u.test(line)) return line.replace(/^DA:(\d+),\d+(.*)$/u, "DA:$1,0$2");
    if (/^LH:/u.test(line)) return "LH:0";
    return line;
  }).join("\n");
}

function serializeLcov(files) {
  return files.map(file => `${file.record}\nend_of_record\n`).join("");
}

async function zeroCoverageForUnloaded(files, compiledExclusions) {
  if (files.length === 0) return [];
  await writeFile(inventoryPath, inventorySource(files), "utf8");
  const exitCode = await runNode([
    "--test",
    ...coverageArguments(compiledExclusions),
    "--test-reporter=lcov",
    `--test-reporter-destination=${repositoryPath(inventoryLcovPath)}`,
    repositoryPath(inventoryPath)
  ], ["ignore", "ignore", "inherit"]);
  if (exitCode !== 0) throw new Error(`coverage inventory runner exited with code ${exitCode}`);
  const inventory = parseLcov(await readFile(inventoryLcovPath, "utf8"));
  const selected = inventory.filter(file => files.includes(file.path));
  assertSameFiles(selected.map(file => file.path), files, "unloaded core-file inventory");
  return parseLcov(serializeLcov(selected.map(file => ({ ...file, record: zeroLcovRecord(file.record) }))));
}

function total(files, name) {
  const covered = files.reduce((sum, file) => sum + file[name].covered, 0);
  const count = files.reduce((sum, file) => sum + file[name].total, 0);
  return metric(covered, count);
}

function printAuthoritativeSummary(coverage, fileCount, unloaded) {
  process.stdout.write("\nAuthoritative all-core coverage baseline\n");
  process.stdout.write(`  Files: ${fileCount}\n`);
  for (const name of ["lines", "branches", "functions"]) {
    const value = coverage[name];
    process.stdout.write(`  ${name}: ${value.percent.toFixed(2)}% (${value.covered}/${value.total}), threshold ${thresholds[name]}%\n`);
  }
  if (unloaded.length) {
    process.stdout.write("  Unloaded core modules counted at 0%:\n");
    for (const path of unloaded) process.stdout.write(`    - ${path}\n`);
  }
}

async function main() {
  const sourceFiles = (await filesBelow(join(repositoryRoot, "src"), ".ts"))
    .filter(path => !path.endsWith(".d.ts"));
  const compiledFiles = await filesBelow(join(repositoryRoot, "dist", "src"), ".js");
  const testFiles = await filesBelow(join(repositoryRoot, "dist", "test"), ".test.js");
  const excludedTestNames = Object.keys(testHarnessExclusions);
  const coverageTestFiles = testFiles.filter(path => !excludedTestNames.includes(path.split("/").at(-1) ?? ""));
  const excludedSources = Object.keys(exclusions).sort();
  const compiledExclusions = excludedSources.map(compiledPath);
  const includedSources = sourceFiles.filter(path => !Object.hasOwn(exclusions, path));
  const includedCompiled = compiledFiles.filter(path => !compiledExclusions.includes(path));

  assertSameFiles(excludedSources, excludedSources.filter(path => sourceFiles.includes(path)), "coverage exclusions");
  assertSameFiles(includedCompiled, includedSources.map(compiledPath), "TypeScript-to-JavaScript coverage inventory");
  if (testFiles.length === 0) throw new Error("coverage baseline found no compiled tests");
  const excludedTestFiles = testFiles.filter(path => !coverageTestFiles.includes(path));
  const expectedExcludedTestFiles = excludedTestNames
    .map(name => `dist/test/${name}`)
    .sort();
  assertSameFiles(excludedTestFiles, expectedExcludedTestFiles, "coverage test-harness exclusions");

  await rm(coverageRoot, { recursive: true, force: true });
  await mkdir(coverageRoot, { recursive: true });

  let testExitCode;
  try {
    testExitCode = await runCoverage(coverageTestFiles, compiledExclusions);
    const observed = parseLcov(await readFile(lcovPath, "utf8"));
    const unexpected = observed.map(file => file.path).filter(path => !includedCompiled.includes(path));
    if (unexpected.length) throw new Error(`LCOV contains files outside the core inventory: ${JSON.stringify(unexpected)}`);
    const unloaded = includedCompiled.filter(path => !observed.some(file => file.path === path));
    const files = [...observed, ...await zeroCoverageForUnloaded(unloaded, compiledExclusions)]
      .sort((left, right) => left.path.localeCompare(right.path));
    assertSameFiles(files.map(file => file.path), includedCompiled, "LCOV core-file inventory");
    await writeFile(lcovPath, serializeLcov(files), "utf8");
    const coverage = {
      lines: total(files, "lines"),
      branches: total(files, "branches"),
      functions: total(files, "functions")
    };
    const summary = {
      schemaVersion: 1,
      scope: "compiled TypeScript core modules",
      sourceMapping: "src/**/*.ts -> dist/src/**/*.js",
      thresholds,
      coverage,
      files: files.map(({ record: _record, ...file }) => file),
      exclusions: excludedSources.map(path => ({ path, reason: exclusions[path] })),
      testExclusions: excludedTestNames.sort().map(name => ({ name, reason: testHarnessExclusions[name] }))
    };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
    printAuthoritativeSummary(coverage, files.length, unloaded);
    process.stdout.write(`Coverage reports: ${repositoryPath(lcovPath)}, ${repositoryPath(summaryPath)}\n`);

    const failures = Object.entries(thresholds)
      .filter(([name, threshold]) => coverage[name].percent < threshold)
      .map(([name, threshold]) => `${name} ${coverage[name].percent}% < ${threshold}%`);
    if (testExitCode !== 0) failures.unshift(`test runner exited with code ${testExitCode}`);
    if (failures.length) throw new Error(`tests or thresholds failed: ${failures.join(", ")}`);
  } finally {
    for (const temporary of [inventoryPath, inventoryLcovPath]) {
      await unlink(temporary).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

await main().catch(error => {
  process.stderr.write(`Coverage baseline failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
