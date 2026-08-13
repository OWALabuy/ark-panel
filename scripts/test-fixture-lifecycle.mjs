import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compiledTests = [
  "dist/test/stream-client.test.js",
  "dist/test/cli-client.test.js",
  "dist/test/generation-api.test.js",
  "dist/test/bridge-service.test.js"
];
const modes = [
  { name: "default", arguments: [] },
  { name: "serial", arguments: ["--test-concurrency=1"] }
];
const signatureVariable = "ARK_PANEL_FIXTURE_ACCEPTANCE_SIGNATURE";
const runTimeoutMs = 30_000;
const closeDeadlineMs = runTimeoutMs + 2_000;
const outputLimitBytes = 16 * 1024 * 1024;

class AcceptanceError extends Error {}
class OwnedRootError extends AggregateError {}

function usage() {
  return "Usage: node scripts/test-fixture-lifecycle.mjs [--runs <positive integer> | --self-test-bounded-close | --self-test-root-identity | --self-test-owned-root-failure]";
}

function parseRuns(arguments_) {
  if (arguments_.length === 0) return 20;
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (arguments_.length !== 2 || arguments_[0] !== "--runs" || !/^[1-9]\d*$/u.test(arguments_[1] ?? "")) {
    throw new AcceptanceError(usage());
  }
  const runs = Number(arguments_[1]);
  if (!Number.isSafeInteger(runs) || runs > 100) throw new AcceptanceError("--runs must be between 1 and 100");
  return runs;
}

async function requireCompiledTests() {
  for (const path of compiledTests) {
    const metadata = await lstat(join(repositoryRoot, path)).catch(error => {
      if (error?.code === "ENOENT") throw new AcceptanceError(`missing compiled test: ${path}`);
      throw error;
    });
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AcceptanceError(`compiled test is not a regular file: ${path}`);
  }
}

async function procEntries() {
  if (process.platform !== "linux") throw new AcceptanceError("owned child residual checks require Linux /proc");
  return (await readdir("/proc", { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map(entry => Number(entry.name));
}

async function processInfo(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const processGroup = Number(fields[2]);
  return Number.isSafeInteger(processGroup) ? { state: fields[0], processGroup } : undefined;
}

async function hasSignature(pid, signature) {
  const environment = await readFile(`/proc/${pid}/environ`).catch(() => undefined);
  if (environment === undefined) return false;
  const marker = Buffer.from(`${signatureVariable}=${signature}\0`);
  return environment.indexOf(marker) !== -1;
}

async function ownedProcessIds(signature, processGroup) {
  const owned = [];
  for (const pid of await procEntries()) {
    const info = await processInfo(pid);
    if (info?.processGroup !== processGroup) continue;
    // The detached child owns this process group. Read the marker only for group members,
    // never the environments of unrelated user processes. A zombie may have no environment.
    if (info.state !== "Z" && !(await hasSignature(pid, signature))) {
      throw new AcceptanceError("fixture process-group member did not carry the owned signature");
    }
    owned.push(pid);
  }
  return owned.sort((left, right) => left - right);
}

function boundedChildClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onClose = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new AcceptanceError(`test child close was not observed within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function selfTestBoundedClose() {
  const child = new EventEmitter();
  const deadlineMs = 25;
  const started = process.hrtime.bigint();
  let rejected = false;
  try {
    await boundedChildClose(child, deadlineMs);
  } catch (error) {
    rejected = error instanceof Error && error.message === `test child close was not observed within ${deadlineMs} ms`;
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (!rejected || durationMs < deadlineMs - 5 || durationMs > 1_000) throw new AcceptanceError("bounded close self-test did not honor its deadline");
  process.stdout.write(`FIXTURE_LIFECYCLE selfTest=bounded-close result=pass deadlineMs=${deadlineMs}\n`);
}

function collect(stream, onLimit) {
  const chunks = [];
  let bytes = 0;
  stream.on("data", chunk => {
    bytes += chunk.length;
    if (bytes <= outputLimitBytes) chunks.push(chunk);
    else onLimit();
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

function tapCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu"))];
  const value = matches.at(-1)?.[1];
  return value === undefined ? undefined : Number(value);
}

async function removeAndVerifyRoot(root, expectedIdentity) {
  let entries;
  const metadata = await lstat(root, { bigint: true }).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) {
    entries = 0;
  } else {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AcceptanceError("fixture root identity changed");
    if (metadata.dev !== expectedIdentity.dev || metadata.ino !== expectedIdentity.ino) {
      throw new AcceptanceError("fixture root identity changed");
    }
    entries = (await readdir(root)).length;
    await rm(root, { recursive: true, force: false });
  }
  const after = await lstat(root).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (after !== undefined) throw new AcceptanceError("fixture root still exists after owned cleanup");
  return entries;
}

async function withOwnedRoot(prefix, operation) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const identity = await lstat(root, { bigint: true });
  let value;
  let operationError;
  try {
    value = await operation(root);
  } catch (error) {
    operationError = error;
  }
  let residualEntries;
  let cleanupError;
  try {
    residualEntries = await removeAndVerifyRoot(root, identity);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new OwnedRootError([operationError, cleanupError], "fixture operation and owned root cleanup both failed");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return { value, residualEntries };
}

async function selfTestRootIdentity() {
  const root = await mkdtemp(join(tmpdir(), "ark-panel-fixture-identity-self-test-"));
  const moved = `${root}-original`;
  const expectedIdentity = await lstat(root, { bigint: true });
  try {
    await rename(root, moved);
    await mkdir(root);
    await writeFile(join(root, "replacement-marker"), "fixture\n", "utf8");
    let rejected = false;
    try {
      await removeAndVerifyRoot(root, expectedIdentity);
    } catch (error) {
      rejected = error instanceof AcceptanceError && error.message === "fixture root identity changed";
    }
    const markerPreserved = await readFile(join(root, "replacement-marker"), "utf8").catch(() => undefined);
    if (!rejected || markerPreserved !== "fixture\n") throw new AcceptanceError("root identity self-test did not preserve the replacement");
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(moved, { recursive: true, force: true })]);
  }
  process.stdout.write("FIXTURE_LIFECYCLE selfTest=root-identity result=pass replacementPreserved=true\n");
}

async function selfTestOwnedRootFailure() {
  let observedRoot;
  let rejected = false;
  try {
    await withOwnedRoot("ark-panel-fixture-failure-self-test-", root => {
      observedRoot = root;
      throw new AcceptanceError("fixture pre-spawn fault");
    });
  } catch (error) {
    rejected = error instanceof AcceptanceError && error.message === "fixture pre-spawn fault";
  }
  if (observedRoot === undefined) throw new AcceptanceError("owned root failure self-test did not create a root");
  const rootAfter = await lstat(observedRoot).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rejected || rootAfter !== undefined) throw new AcceptanceError("owned root failure self-test did not remove its root");
  process.stdout.write("FIXTURE_LIFECYCLE selfTest=owned-root-failure result=pass rootRemoved=true\n");
}

async function runOnce(mode, iteration) {
  const signature = `${mode.name}-${iteration}-${randomUUID()}`;
  const owned = await withOwnedRoot("ark-panel-fixture-acceptance-", async root => {
    const processIdsBefore = new Set(await procEntries());
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, ["--test", ...mode.arguments, ...compiledTests], {
      cwd: repositoryRoot,
      detached: true,
      env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root, [signatureVariable]: signature },
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (child.pid === undefined) throw new AcceptanceError("test child did not receive a pid");
    if (processIdsBefore.has(child.pid)) throw new AcceptanceError("test child pid was present before spawn");
    const processGroup = child.pid;
    let outputExceeded = false;
    const stdout = collect(child.stdout, () => {
      if (outputExceeded) return;
      outputExceeded = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
    });
    collect(child.stderr, () => {
      if (outputExceeded) return;
      outputExceeded = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
    }, runTimeoutMs);
    const forceKill = setTimeout(() => {
      if (timedOut || outputExceeded) child.kill("SIGKILL");
    }, runTimeoutMs + 1_000);
    let close;
    let closeTimedOut = false;
    try {
      close = await boundedChildClose(child, closeDeadlineMs);
    } catch {
      closeTimedOut = true;
      close = { code: child.exitCode, signal: child.signalCode };
    }
    clearTimeout(timeout);
    clearTimeout(forceKill);
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const residualProcessIds = await ownedProcessIds(signature, processGroup);
    const output = stdout();
    return {
      code: close.code,
      signal: close.signal,
      durationMs,
      residualProcessIds,
      timedOut,
      closeTimedOut,
      outputExceeded,
      tests: tapCount(output, "tests"),
      passed: tapCount(output, "pass"),
      failed: tapCount(output, "fail")
    };
  });
  const result = owned.value;
  return {
    ...result,
    residualEntries: owned.residualEntries
  };
}

function assertSuccessful(result) {
  if (result.timedOut) throw new AcceptanceError("test child timed out");
  if (result.closeTimedOut) throw new AcceptanceError("test child close exceeded its independent deadline");
  if (result.outputExceeded) throw new AcceptanceError("test child output exceeded the capture limit");
  if (result.code !== 0 || result.signal !== null) throw new AcceptanceError(`test child exit was code=${result.code ?? "null"}, signal=${result.signal ?? "none"}`);
  if (result.tests === undefined || result.passed !== result.tests || result.failed !== 0) throw new AcceptanceError("test child emitted an invalid TAP summary");
  if (result.residualEntries !== 0) throw new AcceptanceError(`fixture root retained ${result.residualEntries} entries`);
  if (result.residualProcessIds.length !== 0) throw new AcceptanceError(`fixture run retained ${result.residualProcessIds.length} owned processes`);
}

function summary(mode, runs, results) {
  const durations = results.map(result => result.durationMs);
  const testsPerRun = results[0]?.tests ?? 0;
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  process.stdout.write([
    "FIXTURE_LIFECYCLE",
    `mode=${mode.name}`,
    "result=pass",
    `runs=${runs}`,
    `testsPerRun=${testsPerRun}`,
    "exitCodes=0",
    `durationMs=${Math.round(totalMs)}`,
    `minMs=${Math.round(Math.min(...durations))}`,
    `maxMs=${Math.round(Math.max(...durations))}`,
    `rootsCreated=${runs}`,
    `rootsRemoved=${runs}`,
    "residualEntries=0",
    "ownedProcessResiduals=0"
  ].join(" ") + "\n");
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--self-test-bounded-close") {
    await selfTestBoundedClose();
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--self-test-root-identity") {
    await selfTestRootIdentity();
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--self-test-owned-root-failure") {
    await selfTestOwnedRootFailure();
    return;
  }
  const runs = parseRuns(process.argv.slice(2));
  await requireCompiledTests();
  for (const mode of modes) {
    const results = [];
    for (let iteration = 1; iteration <= runs; iteration++) {
      const result = await runOnce(mode, iteration);
      try {
        assertSuccessful(result);
      } catch (error) {
        process.stderr.write(`FIXTURE_LIFECYCLE mode=${mode.name} result=fail iteration=${iteration} exitCode=${result.code ?? "null"} signal=${result.signal ?? "none"} durationMs=${Math.round(result.durationMs)} timedOut=${result.timedOut} closeTimedOut=${result.closeTimedOut} residualEntries=${result.residualEntries} ownedProcessResiduals=${result.residualProcessIds.length}\n`);
        throw error;
      }
      results.push(result);
    }
    summary(mode, runs, results);
  }
}

await main().catch(error => {
  const message = error instanceof AcceptanceError
    ? error.message
    : error instanceof OwnedRootError
      ? error.message
      : `unexpected runner operation failed${typeof error?.code === "string" ? ` (${error.code})` : ""}`;
  process.stderr.write(`Fixture lifecycle acceptance failed: ${message}\n`);
  process.exitCode = 1;
});
