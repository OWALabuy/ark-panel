import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listMemoryFiles, MAX_MEMORY_FILE_BYTES, readMemoryFile } from "../src/storage/memory-files.js";

test("记忆文件只列出固定 Markdown allowlist 并可安全读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-")); await mkdir(join(root, "memory", "topics"), { recursive: true });
  await writeFile(join(root, "MEMORY.md"), "# long\n"); await writeFile(join(root, "DREAMS.md"), "# dreams\n");
  await writeFile(join(root, "memory", "2026-07-22.md"), "daily\n"); await writeFile(join(root, "memory", "topics", "ark.md"), "topic\n");
  await writeFile(join(root, "memory", "ignored.txt"), "secret\n"); await writeFile(join(root, "OTHER.md"), "outside\n");
  const files = await listMemoryFiles(root);
  assert.deepEqual(new Set(files.map(file => file.path)), new Set(["MEMORY.md", "DREAMS.md", "memory/2026-07-22.md", "memory/topics/ark.md"]));
  assert.equal((await readMemoryFile(root, "memory/topics/ark.md")).content, "topic\n");
  await assert.rejects(readMemoryFile(root, "OTHER.md"), /MEMORY_PATH_NOT_ALLOWED/);
  await assert.rejects(readMemoryFile(root, "..%2Fsecret"), /MEMORY_PATH_NOT_ALLOWED/);
});

test("记忆读取拒绝 symlink、hardlink 与超限文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-memory-secure-")), outside = join(await mkdtemp(join(tmpdir(), "panel-memory-outside-")), "secret.md");
  await mkdir(join(root, "memory")); await writeFile(outside, "secret"); await symlink(outside, join(root, "memory", "linked.md"));
  await link(outside, join(root, "memory", "hard.md")); await writeFile(join(root, "memory", "large.md"), Buffer.alloc(MAX_MEMORY_FILE_BYTES + 1));
  const listed = await listMemoryFiles(root);
  assert.ok(!listed.some(file => file.path === "memory/linked.md"));
  await assert.rejects(readMemoryFile(root, "memory/linked.md"), /MEMORY_PATH_NOT_ALLOWED|MEMORY_FILE_UNSAFE/);
  await assert.rejects(readMemoryFile(root, "memory/hard.md"), /MEMORY_FILE_UNSAFE/);
  await assert.rejects(readMemoryFile(root, "memory/large.md"), /MEMORY_FILE_TOO_LARGE/);
});
