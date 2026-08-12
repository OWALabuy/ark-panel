import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../src/storage/atomic.js";
import { PanelRunStore, type PanelRunRecord, type PanelRunStatus, type PanelRunStoreWriter } from "../src/server/run-store.js";
import { deferred, withTimeout, writeThenFailBeforeDirectorySync } from "./test-helpers.js";

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function fixtureRun(index: number, recordId: string, status: PanelRunStatus, sequence = 1): PanelRunRecord {
  const now = "2026-08-12T00:00:00.000Z";
  return { version: 1, runId: runId(index), recordId, requestHash: `hash-${index}`, sequence, status,
    createdAt: now, updatedAt: now, ...(["completed", "failed", "aborted"].includes(status) ? { finishedAt: now } : {}) };
}

test("active-run 索引只在首次访问扫描，并从权威 run 文件重建和移除终态", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new PanelRunStore(root);
  for (let index = 1; index <= 96; index++) await seed.put(fixtureRun(index, `terminal-${index}`, "completed"));
  const active = fixtureRun(100, "active-record", "accepted"); await seed.put(active);

  const observed = { scans: 0, reads: 0 };
  const store = new PanelRunStore(root, {
    onDirectoryScan() { observed.scans++; },
    onRecordRead() { observed.reads++; }
  });
  assert.deepEqual(await store.activeRecordIds(), new Set(["active-record"]));
  assert.deepEqual({ scans: observed.scans, reads: observed.reads }, { scans: 1, reads: 97 });

  for (let index = 0; index < 100; index++) assert.deepEqual(await store.activeRecordIds(), new Set(["active-record"]));
  assert.deepEqual({ scans: observed.scans, reads: observed.reads }, { scans: 1, reads: 97 });
  assert.equal((await store.activeForRecord("active-record"))?.runId, active.runId);
  assert.deepEqual({ scans: observed.scans, reads: observed.reads }, { scans: 1, reads: 98 });

  await store.put({ ...active, status: "running", sequence: 2 });
  assert.equal((await store.activeForRecord("active-record"))?.status, "running");
  await store.put({ ...active, status: "completed", sequence: 3, finishedAt: "2026-08-12T00:01:00.000Z" });
  assert.equal(await store.activeForRecord("active-record"), undefined);
  assert.equal(observed.scans, 1);

  const restartedObserved = { scans: 0, reads: 0 };
  const restarted = new PanelRunStore(root, {
    onDirectoryScan() { restartedObserved.scans++; },
    onRecordRead() { restartedObserved.reads++; }
  });
  assert.equal(await restarted.activeForRecord("active-record"), undefined);
  assert.deepEqual({ scans: restartedObserved.scans, reads: restartedObserved.reads }, { scans: 1, reads: 97 });
});

test("active-run 索引只反映成功的原子写入，失败的 accepted 和 terminal 写入不制造假状态", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root), active = fixtureRun(200, "active-record", "accepted");
  await store.put(active); assert.equal((await store.activeForRecord("active-record"))?.status, "accepted");

  const failedAccepted = fixtureRun(201, "false-active", "accepted");
  const failedAcceptedPath = join(root, "runs", `${failedAccepted.runId}.json`);
  await symlink(join(root, "runs", `${active.runId}.json`), failedAcceptedPath);
  await assert.rejects(store.put(failedAccepted), /拒绝符号链接/);
  await unlink(failedAcceptedPath);
  assert.equal(await store.activeForRecord("false-active"), undefined);

  const activePath = join(root, "runs", `${active.runId}.json`), backupPath = `${activePath}.fixture-backup`;
  await rename(activePath, backupPath); await symlink(backupPath, activePath);
  await assert.rejects(store.put({ ...active, status: "completed", sequence: 2 }), /拒绝符号链接/);
  await unlink(activePath); await rename(backupPath, activePath);
  assert.equal((await store.activeForRecord("active-record"))?.status, "accepted");

  await store.put({ ...active, status: "completed", sequence: 2 });
  assert.equal(await store.activeForRecord("active-record"), undefined);
});

test("active-run 首次扫描失败后不会缓存不完整索引", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new PanelRunStore(root), active = fixtureRun(300, "healthy-record", "accepted"); await seed.put(active);
  const corruptPath = join(root, "runs", `${runId(301)}.json`); await writeFile(corruptPath, "{invalid-json", "utf8");

  const store = new PanelRunStore(root);
  await assert.rejects(store.activeRecordIds());
  await unlink(corruptPath);
  assert.deepEqual(await store.activeRecordIds(), new Set(["healthy-record"]));
});

test("rename 后目录 sync 失败会按磁盘可见状态重建非终态更新与终态", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-post-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let failNext = false, scans = 0;
  const writer: PanelRunStoreWriter = async (path, data) => {
    if (failNext) { failNext = false; return await writeThenFailBeforeDirectorySync(path, data); }
    await atomicWrite(path, data);
  };
  const store = new PanelRunStore(root, { onDirectoryScan() { scans++; } }, writer);
  const accepted = fixtureRun(400, "active-record", "accepted"); await store.put(accepted);
  assert.equal((await store.activeForRecord("active-record"))?.status, "accepted"); assert.equal(scans, 1);

  failNext = true;
  await assert.rejects(store.put({ ...accepted, status: "running", sequence: 2 }), /parent directory sync failed/);
  assert.equal(JSON.parse(await readFile(join(root, "runs", `${accepted.runId}.json`), "utf8")).status, "running");
  assert.equal((await store.activeForRecord("active-record"))?.status, "running"); assert.equal(scans, 2);

  failNext = true;
  await assert.rejects(store.put({ ...accepted, status: "completed", sequence: 3 }), /parent directory sync failed/);
  assert.equal(JSON.parse(await readFile(join(root, "runs", `${accepted.runId}.json`), "utf8")).status, "completed");
  assert.equal(await store.activeForRecord("active-record"), undefined); assert.equal(scans, 3);
});

test("失效前启动的 active 索引扫描不能晚到覆盖 post-rename 状态", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new PanelRunStore(root).put(fixtureRun(500, "terminal-record", "completed"));
  const scanEntered = deferred(), releaseScan = deferred(); t.after(() => releaseScan.resolve());
  let blockFirstRead = true, scans = 0;
  const store = new PanelRunStore(root, {
    onDirectoryScan() { scans++; },
    async beforeRecordRead() {
      if (!blockFirstRead) return;
      blockFirstRead = false; scanEntered.resolve(); await releaseScan.promise;
    }
  }, writeThenFailBeforeDirectorySync);

  const rebuilding = store.activeRecordIds(); await withTimeout(scanEntered.promise, "stale active-index scan");
  const accepted = fixtureRun(501, "new-active-record", "accepted");
  await assert.rejects(store.put(accepted), /parent directory sync failed/);
  releaseScan.resolve();
  assert.deepEqual(await withTimeout(rebuilding, "replacement active-index scan"), new Set(["new-active-record"]));
  assert.equal(scans, 2);
  assert.deepEqual(await store.activeRecordIds(), new Set(["new-active-record"])); assert.equal(scans, 2);
});
