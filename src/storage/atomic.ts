import { open, rename, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export function assertWithin(root: string, candidate: string): string {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  if (normalized !== normalizedRoot && !normalized.startsWith(normalizedRoot + sep)) throw new Error("路径越界");
  return normalized;
}

export async function assertNotSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("拒绝符号链接"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function atomicWrite(path: string, data: string): Promise<void> {
  await assertNotSymlink(path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(data, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
