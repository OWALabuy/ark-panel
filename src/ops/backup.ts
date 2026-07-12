import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface BackupEntry { path: string; size: number; sha256: string }
export interface BackupManifest { version: 1; createdAt: string; files: BackupEntry[]; directories?: string[] }
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024, MAX_ENTRIES = 20_000, MAX_PATH_BYTES = 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

function overlaps(a: string, b: string): boolean {
  const x = relative(resolve(a), resolve(b)), y = relative(resolve(b), resolve(a));
  return x === "" || (x !== ".." && !x.startsWith(`..${sep}`)) || (y !== ".." && !y.startsWith(`..${sep}`));
}
function rejectOpenClaw(path: string): void {
  const parts = resolve(path).split(sep);
  for (let i = 0; i + 2 < parts.length; i++) if (parts[i] === ".openclaw" && parts[i + 1] === "agents") throw new Error("拒绝把 OpenClaw agent 目录作为 panel 备份或恢复路径");
}
async function safeDirectory(path: string, label: string): Promise<string> {
  const value = await lstat(path); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`${label}不是安全目录`);
  if (typeof process.getuid === "function" && value.uid !== process.getuid()) throw new Error(`${label}所有者不安全`);
  const canonical=await realpath(path);rejectOpenClaw(canonical);return canonical;
}
async function readRegular(path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const value = await handle.stat(); if (!value.isFile()) throw new Error("备份只支持普通文件"); if (value.size > maxBytes) throw new Error("备份文件超过资源上限"); const bytes = await handle.readFile(); if (bytes.length > maxBytes) throw new Error("备份文件超过资源上限"); return bytes; }
  finally { await handle.close(); }
}
function safeRelative(value: string): string {
  if (!value || Buffer.byteLength(value) > MAX_PATH_BYTES || value.includes("\\") || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("清单包含不安全路径"); return value;
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function syncTreeDirectories(root: string): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) if (item.isDirectory()) await syncTreeDirectories(join(root, item.name));
  await syncDirectory(root);
}

interface CopyState { files: BackupEntry[]; directories: string[]; totalBytes: number }
async function copyTree(source: string, target: string, state: CopyState, prefix = ""): Promise<void> {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name, from = join(source, item.name), to = join(target, item.name); const value = await lstat(from);
    safeRelative(rel); if (state.files.length + state.directories.length >= MAX_ENTRIES) throw new Error("备份条目超过资源上限");
    if (value.isSymbolicLink()) throw new Error(`拒绝备份符号链接: ${rel}`);
    if (value.isDirectory()) { state.directories.push(rel); await mkdir(to, { mode: 0o700 }); await copyTree(from, to, state, rel); await syncDirectory(to); }
    else if (value.isFile()) {
      const bytes = await readRegular(from); state.totalBytes += bytes.length; if (state.totalBytes > MAX_TOTAL_BYTES) throw new Error("备份总大小超过资源上限");
      const handle = await open(to, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      state.files.push({ path: rel, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else throw new Error(`拒绝备份特殊文件: ${rel}`);
  }
}

async function sameDirectory(path: string, expected: { dev: number | bigint; ino: number | bigint }): Promise<boolean> { const value = await lstat(path); return value.isDirectory() && !value.isSymbolicLink() && value.dev === expected.dev && value.ino === expected.ino; }

export async function createBackup(dataRoot: string, backupsRoot: string, name = new Date().toISOString().replace(/[:.]/g, "-")): Promise<string> {
  rejectOpenClaw(dataRoot); rejectOpenClaw(backupsRoot); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error("备份名称无效");
  dataRoot=await safeDirectory(dataRoot, "PANEL_DATA_DIR"); backupsRoot=await safeDirectory(backupsRoot, "备份根目录"); if (overlaps(dataRoot, backupsRoot)) throw new Error("数据目录与备份目录不得重叠");
  const final = join(backupsRoot, name), stage = join(backupsRoot, `.${name}.${randomUUID()}.tmp`), lockPath = join(backupsRoot, `.${name}.backup.lock`);
  const parentIdentity = await lstat(backupsRoot), lock = await open(lockPath, "wx", 0o600);
  try {
    try { await lstat(final); throw new Error("备份目标已存在"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(stage, { mode: 0o700 });
    const data = join(stage, "data"); await mkdir(data, { mode: 0o700 }); const state: CopyState = { files: [], directories: [], totalBytes: 0 }; await copyTree(dataRoot, data, state);
    state.files.sort((a,b)=>a.path.localeCompare(b.path)); state.directories.sort();
    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), files: state.files, directories: state.directories }; const handle = await open(join(stage, "manifest.json"), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(data); await syncDirectory(stage); if (!await sameDirectory(backupsRoot, parentIdentity)) throw new Error("备份父目录在操作期间发生变化");
    try { await lstat(final); throw new Error("备份目标已存在"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(stage, final); await syncDirectory(backupsRoot); return final;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  finally { await lock.close().catch(()=>undefined); await rm(lockPath, { force: true }); }
}

export async function verifyBackup(backupPath: string): Promise<BackupManifest> {
  rejectOpenClaw(backupPath); backupPath=await safeDirectory(backupPath, "备份"); await safeDirectory(join(backupPath,"data"), "备份 data ");
  const manifest = JSON.parse((await readRegular(join(backupPath, "manifest.json"), MAX_MANIFEST_BYTES)).toString("utf8")) as BackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || (manifest.directories !== undefined && !Array.isArray(manifest.directories)) || manifest.files.length + (manifest.directories?.length ?? 0) > MAX_ENTRIES) throw new Error("备份清单版本、格式或资源上限无效"); const expected = new Set<string>(), expectedDirectories = new Set<string>(); let totalBytes = 0;
  for (const directory of manifest.directories ?? []) { if (typeof directory !== "string") throw new Error("备份目录清单无效"); const rel=safeRelative(directory); if(expectedDirectories.has(rel))throw new Error("备份目录清单路径重复");expectedDirectories.add(rel); }
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("备份清单条目无效");
    totalBytes += entry.size; if(totalBytes>MAX_TOTAL_BYTES)throw new Error("备份总大小超过资源上限");
    const rel = safeRelative(entry.path); if (expected.has(rel) || expectedDirectories.has(rel)) throw new Error("备份清单路径重复"); expected.add(rel); const bytes = await readRegular(join(backupPath, "data", ...rel.split("/")));
    if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`备份校验失败: ${rel}`);
  }
  const actual: string[] = [], actualDirectories: string[] = []; async function walk(root: string, prefix = ""): Promise<void> {
    for (const item of await readdir(root, { withFileTypes: true })) { const rel = prefix ? `${prefix}/${item.name}` : item.name, path = join(root, item.name), value = await lstat(path);
      if (value.isSymbolicLink()) throw new Error(`备份包含符号链接: ${rel}`); if (value.isDirectory()) { actualDirectories.push(rel); await walk(path, rel); } else if (value.isFile()) actual.push(rel); else throw new Error(`备份包含特殊文件: ${rel}`); }
  }
  await walk(join(backupPath, "data")); if (actual.length !== expected.size || actual.some(path => !expected.has(path)) || (manifest.directories !== undefined && (actualDirectories.length !== expectedDirectories.size || actualDirectories.some(path=>!expectedDirectories.has(path))))) throw new Error("备份数据与清单不一致"); return manifest;
}

export async function restoreBackup(backupPath: string, targetDataRoot: string): Promise<void> {
  rejectOpenClaw(backupPath); rejectOpenClaw(targetDataRoot); if (overlaps(backupPath, targetDataRoot)) throw new Error("备份与恢复目标不得重叠");
  try { await lstat(targetDataRoot); throw new Error("恢复目标必须不存在"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  backupPath=await safeDirectory(backupPath,"备份"); const manifest = await verifyBackup(backupPath); let parent = dirname(resolve(targetDataRoot)); parent=await safeDirectory(parent, "恢复目标父目录"); targetDataRoot=join(parent,basename(targetDataRoot)); rejectOpenClaw(targetDataRoot); if(overlaps(backupPath,targetDataRoot))throw new Error("备份与恢复目标不得重叠");
  const parentIdentity=await lstat(parent), stage = join(parent, `.${basename(targetDataRoot)}.${randomUUID()}.restore`), lockPath=join(parent,`.${basename(targetDataRoot)}.restore.lock`),lock=await open(lockPath,"wx",0o600);
  try { await mkdir(stage, { mode: 0o700 }); for(const directory of manifest.directories??[])await mkdir(join(stage,...safeRelative(directory).split("/")),{recursive:true,mode:0o700});
    for (const entry of manifest.files) { const rel = safeRelative(entry.path), destination = join(stage, ...rel.split("/")); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const bytes = await readRegular(join(backupPath, "data", ...rel.split("/"))); if(bytes.length!==entry.size||createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw new Error(`恢复前备份校验失败: ${rel}`);
      const handle = await open(destination, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
    if(!await sameDirectory(parent,parentIdentity))throw new Error("恢复目标父目录在操作期间发生变化");
    try{await lstat(targetDataRoot);throw new Error("恢复目标必须不存在");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    await syncTreeDirectories(stage); await rename(stage, targetDataRoot); await syncDirectory(parent);
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  finally{await lock.close().catch(()=>undefined);await rm(lockPath,{force:true});}
}
