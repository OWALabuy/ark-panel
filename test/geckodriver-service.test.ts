import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { BrowserCleanupController } from "./browser-cleanup.js";
import { spawnOwnedGeckodriver, waitForOwnedGeckodriverStatus } from "./geckodriver-service.js";
import { readLinuxProcessIdentity } from "./linux-process-supervisor.js";
import { withTimeout } from "./test-helpers.js";

const linuxOnly = process.platform === "linux" ? false : "Linux /proc supervision is required";
const fixturePath = join(process.cwd(), "test/fixtures/fake-geckodriver.mjs");

async function fixtureStatus(origin: string): Promise<void> {
  const response = await fetch(`${origin}/status`);
  if (!response.ok) throw new Error("fixture status failed");
}

test("port zero yields distinct child-owned endpoints despite an occupied listener", { skip: linuxOnly }, async t => {
  const occupied = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: { ready: true } }));
  });
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => {
    occupied.closeAllConnections();
    occupied.close(() => resolve());
  }));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("occupied fixture address missing");

  const first = spawnOwnedGeckodriver(process.execPath, { argumentsPrefix: [fixturePath] });
  const second = spawnOwnedGeckodriver(process.execPath, { argumentsPrefix: [fixturePath] });
  t.after(() => first.stop());
  t.after(() => second.stop());
  const [firstEndpoint, secondEndpoint] = await Promise.all([
    waitForOwnedGeckodriverStatus(first, origin => fixtureStatus(origin), 1_000),
    waitForOwnedGeckodriverStatus(second, origin => fixtureStatus(origin), 1_000)
  ]);

  assert.notEqual(firstEndpoint.port, address.port);
  assert.notEqual(secondEndpoint.port, address.port);
  assert.notEqual(firstEndpoint.port, secondEndpoint.port);
  assert.equal(await first.ownsEndpoint(firstEndpoint.port), true);
  assert.equal(await second.ownsEndpoint(secondEndpoint.port), true);
  assert.deepEqual((await first.stop()).diagnostics, []);
  assert.deepEqual((await second.stop()).diagnostics, []);
});

test("status from another listener cannot satisfy owned endpoint readiness", { skip: linuxOnly }, async t => {
  const occupied = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: { ready: true } }));
  });
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => {
    occupied.closeAllConnections();
    occupied.close(() => resolve());
  }));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("occupied fixture address missing");
  const service = spawnOwnedGeckodriver(process.execPath, {
    argumentsPrefix: [fixturePath, `--report-port=${address.port}`]
  });
  t.after(() => service.stop());

  await assert.rejects(
    waitForOwnedGeckodriverStatus(service, origin => fixtureStatus(origin), 1_000),
    /DRIVER_SERVICE_ENDPOINT_UNOWNED/
  );
  assert.deepEqual((await service.stop()).diagnostics, []);
});

test("spawn failure and half-session failure share bounded owned cleanup", { skip: linuxOnly }, async t => {
  const missing = spawnOwnedGeckodriver("/fictional-missing-geckodriver");
  await assert.rejects(missing.ready, /DRIVER_SERVICE_SPAWN_FAILED/);
  await withTimeout(missing.closed, "failed exec child close", 1_000);
  assert.deepEqual((await missing.stop()).diagnostics, []);

  const service = spawnOwnedGeckodriver(process.execPath, { argumentsPrefix: [fixturePath] });
  t.after(() => service.stop());
  const controller = new BrowserCleanupController({ quitTimeoutMs: 2, processStopTimeoutMs: 2_000 });
  controller.attachOwnedProcesses(() => service.stop());
  controller.attachDriver(() => new Promise(() => {}));
  const endpoint = await service.ready;
  assert.equal(await service.ownsEndpoint(endpoint.port), true);
  const pid = service.child.pid;
  if (!pid) throw new Error("fixture service pid unavailable");

  const result = await controller.cleanup();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await readLinuxProcessIdentity(pid), undefined);
});

test("capture rejection aborts the launcher before any target can start", { skip: linuxOnly }, async () => {
  const service = spawnOwnedGeckodriver(process.execPath, {
    argumentsPrefix: [fixturePath, "--exit-ms=20"],
    termTimeoutMs: 500,
    killTimeoutMs: 500,
    captureSupervisor: async () => { throw new Error("fixture capture rejected"); }
  });
  await assert.rejects(service.ready, /fixture capture rejected/);
  await withTimeout(service.closed, "capture-rejected child close", 1_000);
  assert.deepEqual((await service.stop()).diagnostics, []);
  if (service.child.pid) assert.equal(await readLinuxProcessIdentity(service.child.pid), undefined);
});
