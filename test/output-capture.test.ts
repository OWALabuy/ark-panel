import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { appendFile, link, mkdir, mkdtemp, open, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanOutputCapture, collectOutputDirectory, prepareOutputCapture } from "../src/gateway/output-capture.js";

const RUN = "12345678-1234-4234-8234-123456789abc";
const execFileAsync = promisify(execFile);
type PreparedCapture = Awaited<ReturnType<typeof prepareOutputCapture>>;
// The implementation signature accepts this test-only synchronization seam, while its exported
// overload intentionally keeps production callers on the one-argument API.
const collectWithReadHook = collectOutputDirectory as unknown as (prepared: PreparedCapture,
  hooks: { beforeFileOpen?: () => Promise<void>; afterDirectoryRead?: (directory: string) => Promise<void>;
    afterFirstChunk?: () => Promise<void> }) => ReturnType<typeof collectOutputDirectory>;

test("只采集本轮 UUID outputs 内的普通文件并在持久化后清理", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "panel-output-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-cleanup-")); t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
  const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
  await mkdir(join(prepared.outputsRoot, "nested"));
  await writeFile(join(prepared.outputsRoot, "nested", "report.docx"), Buffer.from([0x50, 0x4b, 3, 4]));
  await writeFile(join(workspace, "secret"), "not collected");
  const outputs = await collectOutputDirectory(prepared);
  assert.equal(outputs.length, 1); assert.equal(outputs[0]?.fileName, join("nested", "report.docx"));
  assert.deepEqual(outputs[0]?.bytes, Buffer.from([0x50, 0x4b, 3, 4]));
  await cleanOutputCapture(prepared);
  await assert.rejects(collectOutputDirectory(prepared), error => {
    assert.equal(error instanceof Error && error.message, "OUTPUT_CAPTURE_FILE_RACE");
    assert.equal(String(error), "Error: OUTPUT_CAPTURE_FILE_RACE");
    return true;
  });
});

test("拒绝无效 run id、符号链接、硬链接和配额越界", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "panel-output-unsafe-")); t.after(() => rm(workspace, { recursive: true, force: true }));
  const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-cleanup-")); t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
  await assert.rejects(prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, "../../other"), /RUN_ID_INVALID/);
  const linkedWorkspace = await mkdtemp(join(tmpdir(), "panel-output-linked-")); t.after(() => rm(linkedWorkspace, { recursive: true, force: true }));
  await symlink(workspace, join(linkedWorkspace, ".openclaw"));
  await assert.rejects(prepareOutputCapture({ workspaceRoot: linkedWorkspace, cleanupRoot }, RUN), /PATH_UNSAFE/);
  const symlinkCapture = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
  await symlink(join(workspace, "elsewhere"), join(symlinkCapture.outputsRoot, "link"));
  await assert.rejects(collectOutputDirectory(symlinkCapture), /SYMLINK_REJECTED/);
  await rm(symlinkCapture.runRoot, { recursive: true, force: true });

  const hardlinkCapture = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
  const source = join(workspace, "source"); await writeFile(source, "x"); await link(source, join(hardlinkCapture.outputsRoot, "hard"));
  await assert.rejects(collectOutputDirectory(hardlinkCapture), /HARDLINK_REJECTED/);
  await rm(hardlinkCapture.runRoot, { recursive: true, force: true });

  const limited = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot, maxTotalBytes: 1 }, RUN);
  await writeFile(join(limited.outputsRoot, "large"), "xx");
  await assert.rejects(collectOutputDirectory(limited), /BYTE_LIMIT/);
  await assert.rejects(prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN), /RUN_EXISTS/);
});

test("收集期间拒绝追加、截断、原地覆盖、替换和链接数变化", async t => {
  const cases: ReadonlyArray<readonly [string, (path: string) => Promise<void>]> = [
    ["append", async path => { await appendFile(path, "appended"); }],
    ["truncate", async path => { await truncate(path, 32 * 1024); }],
    ["overwrite", async path => {
      const handle = await open(path, "r+");
      try {
        await handle.write(Buffer.alloc(1024, 0x62), 0, 1024, 96 * 1024);
        await handle.sync();
      } finally { await handle.close(); }
      await utimes(path, new Date(0), new Date("2040-01-01T00:00:00.000Z"));
    }],
    ["replace", async path => {
      const replacement = `${path}.replacement`;
      await writeFile(replacement, Buffer.alloc(128 * 1024, 0x62));
      await rename(replacement, path);
    }],
    ["link-count", async path => { await link(path, `${path}.alias`); }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async subtest => {
      const workspace = await mkdtemp(join(tmpdir(), `panel-output-race-${name}-`));
      subtest.after(() => rm(workspace, { recursive: true, force: true }));
      const cleanupRoot = await mkdtemp(join(tmpdir(), `panel-output-race-cleanup-${name}-`));
      subtest.after(() => rm(cleanupRoot, { recursive: true, force: true }));
      const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
      const path = join(prepared.outputsRoot, "private-output.bin");
      await writeFile(path, Buffer.alloc(128 * 1024, 0x61));
      let mutated = false;

      await assert.rejects(collectWithReadHook(prepared, { afterFirstChunk: async () => {
        assert.equal(mutated, false); mutated = true; await mutate(path);
      } }), error => {
        assert.equal(error instanceof Error && error.message, "OUTPUT_CAPTURE_FILE_RACE");
        assert.equal(String(error), "Error: OUTPUT_CAPTURE_FILE_RACE");
        return true;
      });
      assert.equal(mutated, true);
    });
  }
});

test("定长读取按剩余总预算拒绝后续文件", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "panel-output-cumulative-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-cumulative-cleanup-"));
  t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
  const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot, maxTotalBytes: 3 }, RUN);
  await writeFile(join(prepared.outputsRoot, "first"), "aa");
  await writeFile(join(prepared.outputsRoot, "second"), "bb");
  let reads = 0;
  await assert.rejects(collectWithReadHook(prepared, { afterFirstChunk: async () => { reads += 1; } }),
    /OUTPUT_CAPTURE_BYTE_LIMIT/);
  assert.equal(reads, 1);
});

test("文件在打开前换成 FIFO 时不会阻塞", async t => {
  if (process.platform === "win32") { t.skip("FIFO requires POSIX mkfifo"); return; }
  const workspace = await mkdtemp(join(tmpdir(), "panel-output-fifo-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-fifo-cleanup-"));
  t.after(() => rm(cleanupRoot, { recursive: true, force: true }));
  const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
  const path = join(prepared.outputsRoot, "candidate"), fifo = join(workspace, "replacement-fifo");
  await writeFile(path, "regular"); await execFileAsync("mkfifo", [fifo]);
  await assert.rejects(collectWithReadHook(prepared, { beforeFileOpen: async () => { await rename(fifo, path); } }),
    error => error instanceof Error && error.message === "OUTPUT_CAPTURE_FILE_RACE");
  await assert.rejects(async () => {
    const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
    await writer.close();
  }, error => (error as NodeJS.ErrnoException).code === "ENXIO");
});

test("拒绝 outputs 根目录和嵌套目录在遍历期间被替换", async t => {
  await t.test("root replaced by empty external symlink", async subtest => {
    const workspace = await mkdtemp(join(tmpdir(), "panel-output-root-race-"));
    subtest.after(() => rm(workspace, { recursive: true, force: true }));
    const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-root-race-cleanup-"));
    subtest.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    const outside = await mkdtemp(join(tmpdir(), "panel-output-root-race-outside-"));
    subtest.after(() => rm(outside, { recursive: true, force: true }));
    const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
    await rm(prepared.outputsRoot, { recursive: true }); await symlink(outside, prepared.outputsRoot);
    await assert.rejects(collectOutputDirectory(prepared), /OUTPUT_CAPTURE_PATH_ESCAPE/);
  });

  await t.test("root replaced by another empty directory", async subtest => {
    const workspace = await mkdtemp(join(tmpdir(), "panel-output-root-identity-"));
    subtest.after(() => rm(workspace, { recursive: true, force: true }));
    const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-root-identity-cleanup-"));
    subtest.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
    await rename(prepared.outputsRoot, join(workspace, "original-outputs"));
    await mkdir(prepared.outputsRoot);
    await assert.rejects(collectOutputDirectory(prepared), /OUTPUT_CAPTURE_FILE_RACE/);
  });

  await t.test("nested directory replaced after read", async subtest => {
    const workspace = await mkdtemp(join(tmpdir(), "panel-output-nested-race-"));
    subtest.after(() => rm(workspace, { recursive: true, force: true }));
    const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-nested-race-cleanup-"));
    subtest.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
    const nested = join(prepared.outputsRoot, "nested"), moved = join(prepared.outputsRoot, "moved");
    await mkdir(nested);
    let replaced = false;
    await assert.rejects(collectWithReadHook(prepared, { afterDirectoryRead: async directory => {
      if (directory !== nested) return;
      replaced = true; await rename(nested, moved); await mkdir(nested);
    } }), /OUTPUT_CAPTURE_FILE_RACE/);
    assert.equal(replaced, true);
  });

  await t.test("nested directory mutated after read", async subtest => {
    const workspace = await mkdtemp(join(tmpdir(), "panel-output-nested-mutation-"));
    subtest.after(() => rm(workspace, { recursive: true, force: true }));
    const cleanupRoot = await mkdtemp(join(tmpdir(), "panel-output-nested-mutation-cleanup-"));
    subtest.after(() => rm(cleanupRoot, { recursive: true, force: true }));
    const prepared = await prepareOutputCapture({ workspaceRoot: workspace, cleanupRoot }, RUN);
    const nested = join(prepared.outputsRoot, "nested");
    await mkdir(nested);
    await assert.rejects(collectWithReadHook(prepared, { afterDirectoryRead: async directory => {
      if (directory === nested) await writeFile(join(nested, "late-output"), "changed");
    } }), /OUTPUT_CAPTURE_FILE_RACE/);
  });
});
