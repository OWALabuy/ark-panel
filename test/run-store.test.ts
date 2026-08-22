import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../src/storage/atomic.js";
import { isPanelRunTombstone, PanelRunStore, publicRun, type PanelRunRecord, type PanelRunStatus } from "../src/server/run-store.js";
import { compatibleGenerationRequestFingerprintMatcherVersion, currentGenerationRequestFingerprintMatcherVersion } from "../src/domain/generation-request.js";
import { deferred, withTimeout, writeThenFailBeforeDirectorySync } from "./test-helpers.js";

interface RunStoreTestHooks {
  onDirectoryScan?(): void;
  onRecordRead?(runId: string): void;
  onTombstoneShardParse?(shard: string): void;
  listRunFileNames?(): Promise<string[]>;
  beforeRecordRead?(runId: string): Promise<void>;
  writeRunRecord?(path: string, data: string): Promise<void>;
  writeTombstoneShard?(path: string, data: string): Promise<void>;
  writeSchemaBarrier?(path: string, data: string): Promise<void>;
  unlinkRunRecord?(path: string): Promise<void>;
  syncRunsDirectory?(path: string): Promise<void>;
  maxTombstoneShardBytes?: number;
  maxTombstoneTotalBytes?: number;
  maxRetentionScanned?: number;
  maxRetentionRetired?: number;
  maxRetentionElapsedMs?: number;
  monotonicNow?(): number;
}
// The runtime implementation accepts this test-only seam, while its exported overload keeps
// production callers on the authoritative one-argument constructor.
const TestPanelRunStore = PanelRunStore as unknown as new (dataRoot: string, hooks: RunStoreTestHooks) => PanelRunStore;

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function shardFor(run: string): string {
  return createHash("sha256").update(run, "utf8").digest("hex").slice(0, 2);
}

function fixtureRun(index: number, recordId: string, status: PanelRunStatus, sequence = 1): PanelRunRecord {
  const now = "2026-08-12T00:00:00.000Z";
  return { version: 1, runId: runId(index), recordId,
    requestHash: createHash("sha256").update(`request-${index}`, "utf8").digest("hex"), sequence, status,
    createdAt: now, updatedAt: now, ...(["completed", "failed", "aborted"].includes(status) ? { finishedAt: now } : {}) };
}

test("active-run 索引只在首次访问扫描，并从权威 run 文件重建和移除终态", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new PanelRunStore(root);
  for (let index = 1; index <= 96; index++) await seed.put(fixtureRun(index, `terminal-${index}`, "completed"));
  const active = fixtureRun(100, "active-record", "accepted"); await seed.put(active);

  const observed = { scans: 0, reads: 0 };
  const store = new TestPanelRunStore(root, {
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
  const restarted = new TestPanelRunStore(root, {
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
  const writer = async (path: string, data: string): Promise<void> => {
    if (failNext) { failNext = false; return await writeThenFailBeforeDirectorySync(path, data); }
    await atomicWrite(path, data);
  };
  const store = new TestPanelRunStore(root, { onDirectoryScan() { scans++; }, writeRunRecord: writer });
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
  const store = new TestPanelRunStore(root, {
    onDirectoryScan() { scans++; },
    async beforeRecordRead() {
      if (!blockFirstRead) return;
      blockFirstRead = false; scanEntered.resolve(); await releaseScan.promise;
    },
    writeRunRecord: writeThenFailBeforeDirectorySync
  });

  const rebuilding = store.activeRecordIds(); await withTimeout(scanEntered.promise, "stale active-index scan");
  const accepted = fixtureRun(501, "new-active-record", "accepted");
  await assert.rejects(store.put(accepted), /parent directory sync failed/);
  releaseScan.resolve();
  assert.deepEqual(await withTimeout(rebuilding, "replacement active-index scan"), new Set(["new-active-record"]));
  assert.equal(scans, 2);
  assert.deepEqual(await store.activeRecordIds(), new Set(["new-active-record"])); assert.equal(scans, 2);
});

test("retention 首次删除需要 backup 确认，barrier 持久后转换严格隐私 tombstone", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root), eligible = { ...fixtureRun(600, "retired-record", "failed"),
    finishedAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", message: "private fixture prompt",
    attachmentIds: ["att_private_fixture"], runtimeAgentId: "private-runtime", temporaryTranscriptPath: "/private/fixture/path",
    error: { code: "GATEWAY_RUN_FAILED", message: "private upstream detail" } } satisfies PanelRunRecord;
  const pending = { ...fixtureRun(601, "pending-record", "completed"), finishedAt: "2026-06-01T00:00:00.000Z", cleanupPending: true };
  const young = { ...fixtureRun(602, "young-record", "completed"), finishedAt: "2026-08-10T00:00:00.000Z" };
  const missingFinish = { ...fixtureRun(603, "missing-finish", "completed") }; delete missingFinish.finishedAt;
  const active = fixtureRun(604, "active-record", "running");
  for (const record of [eligible, pending, young, missingFinish, active]) await store.put(record);

  await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z") }),
    /RUN_RETENTION_BACKUP_CONFIRMATION_REQUIRED/);
  assert.deepEqual(await readdir(join(root, "run-tombstones", "v1")), []);
  await assert.rejects(readFile(join(root, "runs", ".tombstone-schema-v1.json"), "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    { scanned: 5, retired: 1, retained: 4 });
  const barrier = JSON.parse(await readFile(join(root, "runs", ".tombstone-schema-v1.json"), "utf8"));
  assert.deepEqual(barrier, { version: 1, kind: "panel-run-tombstone-schema-barrier", tombstoneSchemaVersion: 1 });
  const shard = JSON.parse(await readFile(join(root, "run-tombstones", "v1", `${shardFor(eligible.runId)}.json`), "utf8"));
  const tombstone = shard.tombstones[eligible.runId];
  assert.deepEqual(Object.keys(tombstone).sort(), ["createdAt", "failureCode", "fingerprintMatcherVersion", "finishedAt", "kind", "recordId",
    "requestHash", "retiredAt", "runId", "sequence", "status", "updatedAt", "version"].sort());
  assert.equal(tombstone.fingerprintMatcherVersion, compatibleGenerationRequestFingerprintMatcherVersion);
  assert.equal(tombstone.failureCode, "GATEWAY_RUN_FAILED");
  assert.doesNotMatch(JSON.stringify(shard), /private|attachment|runtime|transcript|upstream|message/i);
  await assert.rejects(readFile(join(root, "runs", `${eligible.runId}.json`), "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const stored = await store.get(eligible.runId); assert.ok(stored && isPanelRunTombstone(stored));
  assert.deepEqual(publicRun(stored).error, { code: "GATEWAY_RUN_FAILED", message: "OpenClaw 运行失败，请检查服务日志后重试。" });
  assert.deepEqual(await store.activeRecordIds(), new Set(["active-record"]));
  await assert.rejects(store.put(eligible), /RUN_TOMBSTONE_EXISTS/);

  const later = { ...fixtureRun(605, "later-record", "completed"), finishedAt: "2026-06-01T00:00:00.000Z",
    fingerprintMatcherVersion: currentGenerationRequestFingerprintMatcherVersion } satisfies PanelRunRecord;
  await store.put(later);
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z") }),
    { scanned: 5, retired: 1, retained: 4 });
  const laterStored = await store.get(later.runId); assert.ok(laterStored && isPanelRunTombstone(laterStored));
  assert.equal(laterStored.fingerprintMatcherVersion, currentGenerationRequestFingerprintMatcherVersion);
});

test("retention days=0 不扫描、不建 barrier 且不要求 backup", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-disabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let scans = 0; const store = new TestPanelRunStore(root, { onDirectoryScan() { scans++; } });
  await store.put({ ...fixtureRun(610, "old-record", "completed"), finishedAt: "2020-01-01T00:00:00.000Z" });
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 0 }), { scanned: 0, retired: 0, retained: 0 });
  assert.equal(scans, 0);
  await assert.rejects(readFile(join(root, "runs", ".tombstone-schema-v1.json"), "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("backup 确认在尚无到期记录时持久激活，后续到期无需再次提供 token", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root), record = { ...fixtureRun(611, "young-record", "completed"),
    finishedAt: "2026-08-10T00:00:00.000Z" };
  await store.put(record);
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    { scanned: 1, retired: 0, retained: 1 });
  assert.equal(JSON.parse(await readFile(join(root, "runs", ".tombstone-schema-v1.json"), "utf8")).tombstoneSchemaVersion, 1);
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-10-12T00:00:00.000Z") }),
    { scanned: 1, retired: 1, retained: 0 });
  assert.ok(isPanelRunTombstone((await store.get(record.runId))!));
});

test("存在 tombstone shard 却缺少 schema barrier 时初始化失败关闭", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-missing-barrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { ...fixtureRun(612, "barrier-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
  const store = new PanelRunStore(root); await store.put(record);
  await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  await unlink(join(root, "runs", ".tombstone-schema-v1.json"));
  await assert.rejects(new PanelRunStore(root).initialize(), /RUN_TOMBSTONE_BARRIER_REQUIRED/);
  await assert.rejects(new PanelRunStore(root).get(record.runId), /RUN_TOMBSTONE_BARRIER_REQUIRED/);
});

test("full 与 shard 共存时一致 tombstone 权威，身份冲突则失败关闭", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-tombstone-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root), record = { ...fixtureRun(620, "authority-record", "completed"),
    startedAt: "2026-01-01T00:00:01.000Z", finishedAt: "2026-01-01T00:00:02.000Z", revision: "10:20" };
  await store.put(record); const before = publicRun((await store.get(record.runId))!);
  await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  const fullPath = join(root, "runs", `${record.runId}.json`);
  await writeFile(fullPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  const authoritative = await store.get(record.runId); assert.ok(authoritative && isPanelRunTombstone(authoritative));
  assert.equal(authoritative.revision, "10:20");
  assert.deepEqual(publicRun(authoritative), before);

  await writeFile(fullPath, JSON.stringify({ ...record, requestHash: "conflicting-hash" }, null, 2) + "\n", { mode: 0o600 });
  await assert.rejects(store.get(record.runId), /RUN_TOMBSTONE_CONFLICT/);
  await assert.rejects(store.list(), /RUN_TOMBSTONE_CONFLICT/);
});

test("nonterminal full 不得掩盖同 runId tombstone", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-active-tombstone-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const terminal = { ...fixtureRun(621, "conflict-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
  const store = new PanelRunStore(root); await store.put(terminal);
  await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  await writeFile(join(root, "runs", `${terminal.runId}.json`), JSON.stringify({ ...terminal, status: "running", finishedAt: undefined }, null, 2) + "\n",
    { mode: 0o600 });
  await assert.rejects(store.get(terminal.runId), /RUN_TOMBSTONE_CONFLICT/);
  await assert.rejects(store.listFullRunsForRecovery(), /RUN_TOMBSTONE_CONFLICT/);
});

test("retention 拒绝把非规范或可能承载私密内容的字段复制进 tombstone", async t => {
  const cases: Array<[string, (record: PanelRunRecord) => PanelRunRecord]> = [
    ["request-hash", record => ({ ...record, requestHash: "private fixture prompt" })],
    ["record-id", record => ({ ...record, recordId: "../private/path" })],
    ["sequence", record => ({ ...record, sequence: -1 })],
    ["created-at", record => ({ ...record, createdAt: "2026-01-01" })],
    ["updated-at", record => ({ ...record, updatedAt: "not-an-instant" })],
    ["revision", record => ({ ...record, revision: `private\n${"x".repeat(257)}` })]
  ];
  for (let index = 0; index < cases.length; index++) {
    const [label, mutate] = cases[index]!;
    const root = await mkdtemp(join(tmpdir(), `run-store-private-field-${label}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const record = mutate({ ...fixtureRun(622 + index, `record-${index}`, "completed"),
      finishedAt: "2026-01-01T00:00:00.000Z", revision: "1:1" });
    const store = new PanelRunStore(root); await store.put(record);
    await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
      /RUN_RECORD_NOT_RETIREABLE/, label);
    assert.equal(JSON.parse(await readFile(join(root, "runs", `${record.runId}.json`), "utf8")).runId, record.runId);
    assert.deepEqual(await readdir(join(root, "run-tombstones", "v1")), []);
  }

  const root = await mkdtemp(join(tmpdir(), "run-store-invalid-finished-at-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidFinished = { ...fixtureRun(629, "invalid-finished", "completed"), finishedAt: "2026-01-01T00:00:00Z" };
  const store = new PanelRunStore(root); await store.put(invalidFinished);
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    { scanned: 1, retired: 0, retained: 1 });
  assert.equal(JSON.parse(await readFile(join(root, "runs", `${invalidFinished.runId}.json`), "utf8")).runId, invalidFinished.runId);
});

test("shard rename 后 durability 失败保留 full，重试识别一致 shard 后完成删除", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-tombstone-post-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { ...fixtureRun(630, "post-rename-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
  const store = new TestPanelRunStore(root, { writeTombstoneShard: writeThenFailBeforeDirectorySync }); await store.put(record);
  await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    /parent directory sync failed/);
  assert.equal(JSON.parse(await readFile(join(root, "runs", `${record.runId}.json`), "utf8")).runId, record.runId);
  const visible = await store.get(record.runId); assert.ok(visible && isPanelRunTombstone(visible));

  const retry = new PanelRunStore(root);
  assert.deepEqual(await retry.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z") }),
    { scanned: 1, retired: 1, retained: 0 });
  await assert.rejects(readFile(join(root, "runs", `${record.runId}.json`), "utf8"),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("barrier、shard 或 full 删除静默 no-op 时绝不报告退休成功或丢失幂等权威", async t => {
  const now = new Date("2026-08-12T00:00:00.000Z");
  for (const [label, hooks, expected] of [
    ["barrier", { async writeSchemaBarrier() {} }, /RUN_RETENTION_BARRIER_WRITE_UNCONFIRMED/],
    ["shard", { async writeTombstoneShard() {} }, /RUN_TOMBSTONE_WRITE_UNCONFIRMED/],
    ["unlink", { async unlinkRunRecord() {} }, /RUN_RECORD_DELETE_UNCONFIRMED/]
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `run-store-${label}-noop-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new TestPanelRunStore(root, hooks), record = { ...fixtureRun(label === "barrier" ? 632 : label === "shard" ? 633 : 634,
      `${label}-noop-record`, "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
    await store.put(record);
    if (label === "shard") await atomicWrite(join(root, "runs", ".tombstone-schema-v1.json"), JSON.stringify({
      version: 1, kind: "panel-run-tombstone-schema-barrier", tombstoneSchemaVersion: 1
    }, null, 2) + "\n");
    await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now, backupConfirmed: true }), expected);
    assert.equal(JSON.parse(await readFile(join(root, "runs", `${record.runId}.json`), "utf8")).runId, record.runId);
    assert.ok(await store.get(record.runId));
  }
});

test("retire 在 shard 持久后重读 full 原始身份，变化时不 unlink", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retirement-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { ...fixtureRun(640, "identity-record", "failed"), finishedAt: "2026-01-01T00:00:00.000Z",
    error: { code: "RUN_FAILED", message: "fixed fixture" } }, fullPath = join(root, "runs", `${runId(640)}.json`);
  const store = new TestPanelRunStore(root, { async writeTombstoneShard(path, data) {
    await atomicWrite(path, data);
    await writeFile(fullPath, JSON.stringify({ ...record, message: "changed while retiring" }, null, 2) + "\n", { mode: 0o600 });
  } });
  await store.put(record);
  await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    /RUN_RECORD_CHANGED_DURING_RETIREMENT/);
  assert.equal(JSON.parse(await readFile(fullPath, "utf8")).message, "changed while retiring");
  const authoritative = await store.get(record.runId); assert.ok(authoritative && isPanelRunTombstone(authoritative));
});

test("put 与 retire 共享 run lock，不能在 shard/full 切换中复活 full", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  let fullWriteAfterRetirement = false;
  const record = { ...fixtureRun(650, "locked-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
  const store = new TestPanelRunStore(root, {
    async writeTombstoneShard(path, data) { entered.resolve(); await release.promise; await atomicWrite(path, data); },
    async writeRunRecord(path, data) { if (JSON.parse(data).sequence > record.sequence) fullWriteAfterRetirement = true; await atomicWrite(path, data); }
  });
  await store.put(record);
  const retiring = store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  await withTimeout(entered.promise, "retention shard write");
  const replacing = store.put({ ...record, sequence: record.sequence + 1, updatedAt: "2026-08-12T00:01:00.000Z" });
  await Promise.resolve(); assert.equal(fullWriteAfterRetirement, false);
  release.resolve(); await retiring;
  await assert.rejects(replacing, /RUN_TOMBSTONE_EXISTS/);
  assert.equal(fullWriteAfterRetirement, false);
});

test("barrier/shard 严格 schema 与 shard 容量异常全部失败关闭", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-tombstone-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root); await store.initialize();
  await writeFile(join(root, "runs", ".tombstone-schema-v1.json"), JSON.stringify({ version: 1,
    kind: "panel-run-tombstone-schema-barrier", tombstoneSchemaVersion: 1, extra: "forbidden" }), "utf8");
  await assert.rejects(store.list(), /schema barrier/);
  await writeFile(join(root, "runs", ".tombstone-schema-v1.json"), JSON.stringify({ version: 1,
    kind: "panel-run-tombstone-schema-barrier", tombstoneSchemaVersion: 1 }), "utf8");
  await chmod(join(root, "runs", ".tombstone-schema-v1.json"), 0o600);
  const id = runId(660), shardPath = join(root, "run-tombstones", "v1", `${shardFor(id)}.json`);
  await writeFile(shardPath, "x".repeat(8 * 1024 * 1024 + 1), "utf8");
  await chmod(shardPath, 0o600);
  await assert.rejects(store.get(id), /RUN_TOMBSTONE_CAPACITY_EXCEEDED/);
});

test("startup recovery 不加载 tombstone 历史，按 key shard 读取使用有界身份缓存", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-tombstone-cold-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new PanelRunStore(root), retired = { ...fixtureRun(665, "retired-only", "completed"),
    finishedAt: "2026-01-01T00:00:00.000Z" }, active = fixtureRun(666, "active-only", "running");
  await seed.put(retired); await seed.put(active);
  await seed.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  let shardParses = 0;
  const restarted = new TestPanelRunStore(root, { onTombstoneShardParse() { shardParses++; } });
  assert.deepEqual((await restarted.listFullRunsForRecovery()).map(record => record.runId), [active.runId]);
  assert.equal(shardParses, 0);
  assert.ok(isPanelRunTombstone((await restarted.get(retired.runId))!)); assert.equal(shardParses, 1);
  assert.ok(isPanelRunTombstone((await restarted.get(retired.runId))!)); assert.equal(shardParses, 1);
});

test("startup 按 shard 分组核验 full 冲突，超过 LRU 容量也不重复解析 shard", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-tombstone-grouped-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buckets = new Map<string, PanelRunRecord[]>();
  for (let index = 800; buckets.size < 9 || [...buckets.values()].some(records => records.length < 2); index++) {
    const record = { ...fixtureRun(index, `grouped-${index}`, "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
    const shard = shardFor(record.runId), records = buckets.get(shard);
    if (records) { if (records.length < 2) records.push(record); }
    else if (buckets.size < 9) buckets.set(shard, [record]);
  }
  const records = [...buckets.values()].flat(), seed = new PanelRunStore(root);
  for (const record of records) await seed.put(record);
  assert.equal((await seed.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true })).retired,
    records.length);
  for (const record of records) await atomicWrite(join(root, "runs", `${record.runId}.json`), JSON.stringify(record, null, 2) + "\n");
  const deliberatelyInterleaved = [0, 1].flatMap(position => [...buckets.values()].map(group => `${group[position]!.runId}.json`));
  let shardParses = 0;
  const restarted = new TestPanelRunStore(root, {
    async listRunFileNames() { return deliberatelyInterleaved; },
    onTombstoneShardParse() { shardParses++; }
  });
  assert.equal((await restarted.listFullRunsForRecovery()).length, records.length);
  assert.equal(shardParses, buckets.size);
});

test("retention 在 per-shard 或 total bytes 达上限时保留 full 并固定失败", async t => {
  for (const [label, limits] of [["shard", { maxTombstoneShardBytes: 1, maxTombstoneTotalBytes: 1024 * 1024 }],
    ["total", { maxTombstoneShardBytes: 1024 * 1024, maxTombstoneTotalBytes: 1 }]] as const) {
    const root = await mkdtemp(join(tmpdir(), `run-store-${label}-capacity-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const record = { ...fixtureRun(label === "shard" ? 670 : 671, `${label}-capacity-record`, "completed"),
      finishedAt: "2026-01-01T00:00:00.000Z" };
    const store = new TestPanelRunStore(root, limits); await store.put(record);
    await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
      /RUN_TOMBSTONE_CAPACITY_EXCEEDED/);
    assert.equal(JSON.parse(await readFile(join(root, "runs", `${record.runId}.json`), "utf8")).runId, record.runId);
    assert.deepEqual(await readdir(join(root, "run-tombstones", "v1")), []);
  }
});

test("retention 严格限制 days 和批次 scan/retire，派生 cursor 轮转不饿饿后缀", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TestPanelRunStore(root, { maxRetentionScanned: 2, maxRetentionRetired: 1, maxRetentionElapsedMs: 60_000 });
  for (let index = 700; index < 703; index++) await store.put(fixtureRun(index, `active-${index}`, "running"));
  for (let index = 703; index < 705; index++) await store.put({ ...fixtureRun(index, `old-${index}`, "completed"),
    finishedAt: "2026-01-01T00:00:00.000Z" });
  const now = new Date("2026-08-12T00:00:00.000Z");
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now }), { scanned: 2, retired: 0, retained: 2 });
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now, backupConfirmed: true }), { scanned: 2, retired: 1, retained: 1 });
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now }), { scanned: 1, retired: 1, retained: 0 });
  assert.ok(isPanelRunTombstone((await store.get(runId(703)))!));
  assert.ok(isPanelRunTombstone((await store.get(runId(704)))!));
  for (const invalid of [-1, 0.5, 36_501, Number.NaN]) {
    await assert.rejects(store.retireTerminalRuns({ retentionDays: invalid }), /RUN_RETENTION_DAYS_INVALID/);
  }
});

test("retention elapsed bound 在到界后停止当前批次", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retention-time-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ticks = [0, 0, 3]; let index = 0;
  const store = new TestPanelRunStore(root, { maxRetentionScanned: 10, maxRetentionRetired: 10, maxRetentionElapsedMs: 2,
    monotonicNow: () => ticks[index++] ?? 3 });
  await store.put(fixtureRun(710, "active-one", "running")); await store.put(fixtureRun(711, "active-two", "running"));
  assert.deepEqual(await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z") }),
    { scanned: 1, retired: 0, retained: 1 });
});

test("retire 遇到同字节 inode 替换时不 unlink full", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-retirement-inode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { ...fixtureRun(720, "inode-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" },
    fullPath = join(root, "runs", `${runId(720)}.json`), source = JSON.stringify(record, null, 2) + "\n";
  const store = new TestPanelRunStore(root, { async writeTombstoneShard(path, data) {
    await atomicWrite(path, data); await atomicWrite(fullPath, source);
  } });
  await store.put(record);
  await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
    /RUN_RECORD_CHANGED_DURING_RETIREMENT/);
  assert.equal(await readFile(fullPath, "utf8"), source);
});

test("pinned runs/v1 root 被替换时失败关闭且不删 full", async t => {
  for (const target of ["runs", "v1"] as const) {
    const root = await mkdtemp(join(tmpdir(), `run-store-${target}-root-race-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const index = target === "runs" ? 730 : 731, record = { ...fixtureRun(index, `${target}-root-record`, "completed"),
      finishedAt: "2026-01-01T00:00:00.000Z" };
    const original = target === "runs" ? join(root, "runs") : join(root, "run-tombstones", "v1"), moved = `${original}-replaced`;
    const store = new TestPanelRunStore(root, { async writeTombstoneShard(path, data) {
      await atomicWrite(path, data); await rename(original, moved); await mkdir(original, { mode: 0o700 });
    } });
    await store.put(record);
    await assert.rejects(store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true }),
      /RUN_STORE_ROOT_CHANGED/);
    const authoritativeFull = target === "runs" ? join(moved, `${record.runId}.json`) : join(root, "runs", `${record.runId}.json`);
    assert.equal(JSON.parse(await readFile(authoritativeFull, "utf8")).runId, record.runId);
  }
});

test("full 和 shard hardlink 都被拒绝", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-hardlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PanelRunStore(root), record = { ...fixtureRun(740, "hardlink-record", "completed"),
    finishedAt: "2026-01-01T00:00:00.000Z" }, fullPath = join(root, "runs", `${record.runId}.json`), fullLink = `${fullPath}.link`;
  await store.put(record); await link(fullPath, fullLink);
  await assert.rejects(store.get(record.runId), /文件不安全/); await unlink(fullLink);
  await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  const shardPath = join(root, "run-tombstones", "v1", `${shardFor(record.runId)}.json`), shardLink = `${shardPath}.link`;
  await link(shardPath, shardLink);
  await assert.rejects(store.get(record.runId), /shard 文件不安全/);
});

test("run roots、full、barrier 与 shard 必须保持私有权限", async t => {
  const root = await mkdtemp(join(tmpdir(), "run-store-private-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = { ...fixtureRun(710, "private-mode-record", "completed"), finishedAt: "2026-01-01T00:00:00.000Z" };
  const store = new PanelRunStore(root); await store.put(record);
  const fullPath = join(root, "runs", `${record.runId}.json`); await chmod(fullPath, 0o644);
  await assert.rejects(store.get(record.runId), /文件不安全/); await chmod(fullPath, 0o600);
  await store.retireTerminalRuns({ retentionDays: 30, now: new Date("2026-08-12T00:00:00.000Z"), backupConfirmed: true });
  const barrierPath = join(root, "runs", ".tombstone-schema-v1.json"); await chmod(barrierPath, 0o644);
  await assert.rejects(new PanelRunStore(root).initialize(), /schema barrier/); await chmod(barrierPath, 0o600);
  const shardPath = join(root, "run-tombstones", "v1", `${shardFor(record.runId)}.json`); await chmod(shardPath, 0o644);
  await assert.rejects(new PanelRunStore(root).get(record.runId), /shard 文件不安全/); await chmod(shardPath, 0o600);
  await chmod(join(root, "run-tombstones", "v1"), 0o755);
  await assert.rejects(new PanelRunStore(root).initialize(), /schema 目录不安全/);
});
