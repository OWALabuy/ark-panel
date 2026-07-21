import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { assertWithin } from "./atomic.js";

export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;
export const MAX_MEMORY_FILES = 512;

export type MemoryFileKind = "long-term" | "dreams" | "daily";
export interface MemoryFileSummary {
  path: string;
  kind: MemoryFileKind;
  sizeBytes: number;
  modifiedAt: string;
}
export interface MemoryFileDocument extends MemoryFileSummary { content: string }

function allowedPath(path: string): MemoryFileKind | undefined {
  if (path === "MEMORY.md") return "long-term";
  if (path === "DREAMS.md") return "dreams";
  if (/^memory\/(?:[^/]+\/)*[^/]+\.md$/u.test(path) && !path.split("/").some(part => part === "." || part === ".." || !part)) return "daily";
  return undefined;
}

async function safeWorkspace(workspaceRoot: string): Promise<string> {
  const configured = await lstat(workspaceRoot);
  if (!configured.isDirectory() || configured.isSymbolicLink()) throw new Error("MEMORY_WORKSPACE_UNSAFE");
  return await realpath(workspaceRoot);
}

async function safeFile(root: string, relativePath: string): Promise<{ path: string; dev: number; ino: number; summary: MemoryFileSummary }> {
  const kind = allowedPath(relativePath); if (!kind) throw new Error("MEMORY_PATH_NOT_ALLOWED");
  const path = assertWithin(root, join(root, ...relativePath.split("/")));
  const resolved = await realpath(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("MEMORY_FILE_NOT_FOUND"); throw error; });
  const fromRoot = relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) throw new Error("MEMORY_PATH_NOT_ALLOWED");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("MEMORY_FILE_UNSAFE");
  if (stat.size > MAX_MEMORY_FILE_BYTES) throw new Error("MEMORY_FILE_TOO_LARGE");
  return { path, dev: stat.dev, ino: stat.ino, summary: { path: relativePath, kind, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() } };
}

async function discover(root: string, directory: string, prefix: string, output: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_MEMORY_FILES) throw new Error("MEMORY_FILE_LIMIT_EXCEEDED");
    const path = assertWithin(root, join(directory, entry.name));
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    const child = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (stat.isDirectory()) await discover(root, path, child, output);
    else if (stat.isFile() && entry.name.endsWith(".md")) output.push(`memory/${child}`);
  }
}

export async function listMemoryFiles(workspaceRoot: string): Promise<MemoryFileSummary[]> {
  const root = await safeWorkspace(resolve(workspaceRoot)); const candidates = ["MEMORY.md", "DREAMS.md"];
  await discover(root, join(root, "memory"), "", candidates);
  const files: MemoryFileSummary[] = [];
  for (const path of candidates) {
    try { files.push((await safeFile(root, path)).summary); }
    catch (error) { if (!["MEMORY_FILE_NOT_FOUND", "MEMORY_FILE_UNSAFE", "MEMORY_FILE_TOO_LARGE"].includes((error as Error).message)) throw error; }
  }
  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path));
}

export async function readMemoryFile(workspaceRoot: string, relativePath: string): Promise<MemoryFileDocument> {
  const root = await safeWorkspace(resolve(workspaceRoot));
  const file = await safeFile(root, relativePath);
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.summary.sizeBytes) throw new Error("MEMORY_FILE_UNSAFE");
    return { ...file.summary, content: await readFile(handle, "utf8") };
  } finally { await handle.close(); }
}
