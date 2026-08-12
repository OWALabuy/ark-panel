import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { CollectedOutput, OutputCaptureRequest } from "./adapter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 1) throw new Error(`${name}_INVALID`);
  return effective;
}

export interface PreparedOutputCapture {
  runRoot: string; outputsRoot: string; cleanupRoot: string; runDevice: number; runInode: number;
  maxFiles: number; maxTotalBytes: number;
}

interface OutputCaptureReadHooks {
  /** Test synchronization seam; production callers must leave this unset. */
  afterFirstChunk?: () => Promise<void>;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && right.nlink === 1n && right.dev === left.dev && right.ino === left.ino &&
    right.size === left.size && right.mtimeNs === left.mtimeNs && right.ctimeNs === left.ctimeNs;
}

function captureError(error: unknown): Error {
  if (error instanceof Error && /^OUTPUT_CAPTURE_[A-Z_]+$/.test(error.message)) return error;
  return new Error("OUTPUT_CAPTURE_FILE_RACE");
}

async function readStableFile(handle: FileHandle, expected: BigIntStats, maximum: number,
  hooks: OutputCaptureReadHooks): Promise<Buffer> {
  if (expected.size > BigInt(maximum)) throw new Error("OUTPUT_CAPTURE_BYTE_LIMIT");
  const bytes = Buffer.alloc(Number(expected.size)); let offset = 0; let firstChunk = true;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
    if (result.bytesRead === 0) throw new Error("OUTPUT_CAPTURE_FILE_RACE");
    offset += result.bytesRead;
    if (firstChunk) { firstChunk = false; await hooks.afterFirstChunk?.(); }
  }
  if (bytes.length !== Number(expected.size)) throw new Error("OUTPUT_CAPTURE_FILE_RACE");
  return bytes;
}

async function ensurePrivateDirectory(root: string, components: readonly string[]): Promise<string> {
  let path = root;
  for (const component of components) {
    path = join(path, component);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("OUTPUT_CAPTURE_PATH_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { mode: 0o700 });
    }
  }
  return path;
}

export async function prepareOutputCapture(request: OutputCaptureRequest, runUuid: string): Promise<PreparedOutputCapture> {
  if (!UUID.test(runUuid)) throw new Error("OUTPUT_CAPTURE_RUN_ID_INVALID");
  const configuredRoot = resolve(request.workspaceRoot);
  const rootStat = await lstat(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("OUTPUT_CAPTURE_WORKSPACE_UNSAFE");
  const workspaceRoot = await realpath(configuredRoot);
  const configuredCleanupRoot = resolve(request.cleanupRoot);
  await mkdir(configuredCleanupRoot, { recursive: true, mode: 0o700 });
  const cleanupStat = await lstat(configuredCleanupRoot);
  if (!cleanupStat.isDirectory() || cleanupStat.isSymbolicLink() || await realpath(configuredCleanupRoot) !== configuredCleanupRoot) {
    throw new Error("OUTPUT_CAPTURE_CLEANUP_ROOT_UNSAFE");
  }
  const runRoot = join(workspaceRoot, ".openclaw", "tmp", "ark-panel", runUuid);
  const outputsRoot = join(runRoot, "outputs");
  if (!within(workspaceRoot, outputsRoot)) throw new Error("OUTPUT_CAPTURE_PATH_ESCAPE");
  const parent = await ensurePrivateDirectory(workspaceRoot, [".openclaw", "tmp", "ark-panel"]);
  try { await mkdir(runRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("OUTPUT_CAPTURE_RUN_EXISTS"); throw error; }
  try {
    await mkdir(join(parent, runUuid, "outputs"), { mode: 0o700 });
    const actual = await realpath(outputsRoot);
    if (actual !== outputsRoot) throw new Error("OUTPUT_CAPTURE_PATH_UNSAFE");
    const runStat = await lstat(runRoot);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("OUTPUT_CAPTURE_PATH_UNSAFE");
    return { runRoot, outputsRoot, cleanupRoot: configuredCleanupRoot, runDevice: runStat.dev, runInode: runStat.ino,
      maxFiles: limit(request.maxFiles, DEFAULT_MAX_FILES, "OUTPUT_CAPTURE_MAX_FILES"),
      maxTotalBytes: limit(request.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "OUTPUT_CAPTURE_MAX_BYTES") };
  } catch (error) {
    // Refuse recursive cleanup from a model-writable path. A failed preparation may leave this
    // fresh UUID directory behind; maintenance can report/remove it out of band.
    throw error;
  }
}

export function collectOutputDirectory(prepared: PreparedOutputCapture): Promise<CollectedOutput[]>;
export async function collectOutputDirectory(prepared: PreparedOutputCapture,
  hooks: OutputCaptureReadHooks = {}): Promise<CollectedOutput[]> {
  const outputs: CollectedOutput[] = []; let count = 0; let bytesUsed = 0;
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { throw captureError(error); }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      let stat: BigIntStats;
      try { stat = await lstat(path, { bigint: true }); }
      catch (error) { throw captureError(error); }
      if (stat.isSymbolicLink()) throw new Error("OUTPUT_CAPTURE_SYMLINK_REJECTED");
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile()) throw new Error("OUTPUT_CAPTURE_SPECIAL_FILE_REJECTED");
      if (stat.nlink !== 1n) throw new Error("OUTPUT_CAPTURE_HARDLINK_REJECTED");
      if (++count > prepared.maxFiles) throw new Error("OUTPUT_CAPTURE_FILE_LIMIT");
      try {
        const resolvedPath = await realpath(path);
        if (!within(prepared.outputsRoot, resolvedPath)) throw new Error("OUTPUT_CAPTURE_PATH_ESCAPE");
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const opened = await handle.stat({ bigint: true });
          if (!sameFile(stat, opened)) throw new Error("OUTPUT_CAPTURE_FILE_RACE");
          bytes = await readStableFile(handle, opened, prepared.maxTotalBytes - bytesUsed, hooks);
          const after = await handle.stat({ bigint: true });
          const resolvedAfter = await realpath(path);
          const current = await lstat(path, { bigint: true });
          if (!within(prepared.outputsRoot, resolvedAfter)) throw new Error("OUTPUT_CAPTURE_PATH_ESCAPE");
          if (resolvedAfter !== resolvedPath || !sameFile(opened, after) || !sameFile(opened, current)) {
            throw new Error("OUTPUT_CAPTURE_FILE_RACE");
          }
        } finally { await handle.close(); }
        bytesUsed += bytes.length;
        outputs.push({ source: "output-directory", fileName: relative(prepared.outputsRoot, path), bytes });
      } catch (error) { throw captureError(error); }
    }
  }
  await walk(prepared.outputsRoot);
  return outputs;
}

export function enforceOutputLimits(outputs: readonly CollectedOutput[], maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES): void {
  if (outputs.length > maxFiles) throw new Error("OUTPUT_CAPTURE_FILE_LIMIT");
  let bytes = 0;
  for (const output of outputs) {
    bytes += output.bytes.byteLength;
    if (bytes > maxTotalBytes) throw new Error("OUTPUT_CAPTURE_BYTE_LIMIT");
  }
}

export async function cleanOutputCapture(prepared: PreparedOutputCapture): Promise<void> {
  const name = basename(prepared.runRoot);
  if (!UUID.test(name) || prepared.outputsRoot !== join(prepared.runRoot, "outputs")) throw new Error("OUTPUT_CAPTURE_CLEANUP_REFUSED");
  const before = await lstat(prepared.runRoot);
  if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== prepared.runDevice || before.ino !== prepared.runInode) {
    throw new Error("OUTPUT_CAPTURE_CLEANUP_REFUSED");
  }
  const quarantine = join(prepared.cleanupRoot, `${name}-${Date.now()}`);
  // Rename first: recursive deletion never traverses the model-writable workspace. If the source was
  // replaced during the rename race, the inode check below refuses deletion of the moved object.
  await rename(prepared.runRoot, quarantine);
  const moved = await lstat(quarantine);
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== prepared.runDevice || moved.ino !== prepared.runInode) {
    throw new Error("OUTPUT_CAPTURE_CLEANUP_REFUSED");
  }
  await rm(quarantine, { recursive: true, force: true });
}
