import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOutputCapture, collectOutputDirectory, prepareOutputCapture } from "../src/gateway/output-capture.js";

const RUN = "12345678-1234-4234-8234-123456789abc";

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
  await assert.rejects(collectOutputDirectory(prepared), /ENOENT/);
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
