import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { assertNotSymlink, assertWithin, atomicWrite } from "../storage/atomic.js";

export const THEMES = ["system", "light", "dark", "gruvbox-dark-medium", "gruvbox-light-medium"] as const;
export const ACCENTS = ["default", "blue", "green", "red", "yellow", "magenta", "cyan"] as const;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const MAX_STORED_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_AVATAR_PIXELS = 4096 * 4096;

export type Theme = typeof THEMES[number];
export type Accent = typeof ACCENTS[number];
export interface PanelSettings { version: 1; appearance: { theme: Theme; accent: Accent } }
export interface SettingsPatch { version?: 1; appearance?: { theme?: Theme; accent?: Accent } }
export interface StoredAvatar { bytes: Buffer; etag: string }

const DEFAULT_SETTINGS: PanelSettings = { version: 1, appearance: { theme: "system", accent: "default" } };

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function copySettings(value: PanelSettings): PanelSettings { return { version: 1, appearance: { ...value.appearance } }; }

export function validateSettingsPatch(value: unknown): SettingsPatch {
  if (!object(value) || !exactKeys(value, ["version", "appearance"]) || Object.keys(value).length === 0) throw new Error("SETTINGS_INVALID");
  if (value.version !== undefined && value.version !== 1) throw new Error("SETTINGS_INVALID");
  if (value.appearance !== undefined) {
    if (!object(value.appearance) || !exactKeys(value.appearance, ["theme", "accent"]) || Object.keys(value.appearance).length === 0) throw new Error("SETTINGS_INVALID");
    if (value.appearance.theme !== undefined && !THEMES.includes(value.appearance.theme as Theme)) throw new Error("SETTINGS_INVALID");
    if (value.appearance.accent !== undefined && !ACCENTS.includes(value.appearance.accent as Accent)) throw new Error("SETTINGS_INVALID");
  }
  if (value.appearance === undefined && value.version === 1) throw new Error("SETTINGS_UPDATE_EMPTY");
  return value as SettingsPatch;
}

function validateStoredSettings(value: unknown): PanelSettings {
  if (!object(value) || !exactKeys(value, ["version", "appearance"]) || value.version !== 1 || !object(value.appearance) ||
      !exactKeys(value.appearance, ["theme", "accent"]) || !THEMES.includes(value.appearance.theme as Theme) || !ACCENTS.includes(value.appearance.accent as Accent)) throw new Error("SETTINGS_CORRUPT");
  return value as unknown as PanelSettings;
}

async function ensurePrivateDirectory(root: string, path: string): Promise<void> {
  try {
    assertWithin(root, path); await mkdir(path, { recursive: true, mode: 0o700 }); await assertNotSymlink(path);
    const stat = await lstat(path); if (!stat.isDirectory()) throw new Error("PANEL_STORAGE_UNSAFE"); await chmod(path, 0o700);
  } catch { throw new Error("PANEL_STORAGE_UNSAFE"); }
}

async function atomicWriteBinary(path: string, data: Buffer): Promise<void> {
  try { await assertNotSymlink(path); } catch { throw new Error("PANEL_STORAGE_UNSAFE"); }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}

export class ExperienceStore {
  private readonly root: string;
  private readonly settingsPath: string;
  private readonly avatarRoot: string;
  private readonly allowedAgents: ReadonlySet<string>;
  private settingsQueue: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, allowedAgentIds: readonly string[]) {
    this.root = dataRoot;
    this.settingsPath = assertWithin(dataRoot, join(dataRoot, "settings.json"));
    this.avatarRoot = assertWithin(dataRoot, join(dataRoot, "avatars"));
    this.allowedAgents = new Set(allowedAgentIds);
  }

  assertAgent(agentId: string): void { if (!this.allowedAgents.has(agentId)) throw new Error("AGENT_NOT_ALLOWED"); }
  private avatarPath(agentId: string): string {
    this.assertAgent(agentId);
    const name = createHash("sha256").update(agentId).digest("hex") + ".webp";
    return assertWithin(this.avatarRoot, join(this.avatarRoot, name));
  }

  async settings(): Promise<PanelSettings> {
    try { await assertNotSymlink(this.settingsPath); } catch { throw new Error("PANEL_STORAGE_UNSAFE"); }
    let bytes: Buffer;
    try { bytes = await readFile(this.settingsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return copySettings(DEFAULT_SETTINGS); throw error; }
    if (bytes.length > 16_384) throw new Error("SETTINGS_CORRUPT");
    let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("SETTINGS_CORRUPT"); }
    await chmod(this.settingsPath, 0o600);
    return copySettings(validateStoredSettings(parsed));
  }

  async patchSettings(patch: SettingsPatch): Promise<PanelSettings> {
    const operation = this.settingsQueue.then(async () => {
      const current = await this.settings();
      const next: PanelSettings = { version: 1, appearance: { theme: patch.appearance?.theme ?? current.appearance.theme, accent: patch.appearance?.accent ?? current.appearance.accent } };
      await atomicWrite(this.settingsPath, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
    this.settingsQueue = operation.catch(() => undefined);
    return await operation;
  }

  async avatar(agentId: string): Promise<StoredAvatar | undefined> {
    const path = this.avatarPath(agentId); await ensurePrivateDirectory(this.root, this.avatarRoot);
    let stat; try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("AVATAR_STORAGE_INVALID"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_STORED_AVATAR_BYTES) throw new Error("AVATAR_STORAGE_INVALID");
    let bytes: Buffer; try { bytes = await readFile(path); } catch { throw new Error("AVATAR_STORAGE_INVALID"); }
    await chmod(path, 0o600);
    return { bytes, etag: `"${createHash("sha256").update(bytes).digest("base64url")}"` };
  }

  async putAvatar(agentId: string, input: Buffer): Promise<StoredAvatar> {
    const path = this.avatarPath(agentId);
    if (!input.length || input.length > MAX_AVATAR_BYTES) throw new Error("AVATAR_INVALID");
    let metadata: sharp.Metadata;
    try { metadata = await sharp(input, { animated: false, limitInputPixels: MAX_AVATAR_PIXELS }).metadata(); }
    catch { throw new Error("AVATAR_INVALID"); }
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) throw new Error("AVATAR_INVALID");
    let bytes: Buffer;
    try { bytes = await sharp(input, { animated: false, limitInputPixels: MAX_AVATAR_PIXELS }).rotate().resize(256, 256, { fit: "cover", position: "centre" }).webp({ quality: 86 }).toBuffer(); }
    catch { throw new Error("AVATAR_INVALID"); }
    await ensurePrivateDirectory(this.root, this.avatarRoot); await atomicWriteBinary(path, bytes);
    return { bytes, etag: `"${createHash("sha256").update(bytes).digest("base64url")}"` };
  }

  async deleteAvatar(agentId: string): Promise<boolean> {
    const path = this.avatarPath(agentId); await ensurePrivateDirectory(this.root, this.avatarRoot); try { await assertNotSymlink(path); } catch { throw new Error("PANEL_STORAGE_UNSAFE"); }
    try { await rm(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
}
