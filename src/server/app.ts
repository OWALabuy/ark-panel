import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { cookie, cookies, issueSession, newCsrf, verifyPassword, verifySession, type AuthConfig } from "./auth.js";
import { mockAgents, mockConversation, mockSessions } from "./mock-data.js";
import { ForkError } from "../domain/fork.js";
import type { PublicPanelRun } from "./run-store.js";
import { MAX_AVATAR_BYTES, validateSettingsPatch, type PanelSettings, type SettingsPatch, type StoredAvatar } from "./experience-store.js";
import { MAX_ATTACHMENT_BYTES } from "../storage/attachments.js";

export interface GenerationApi {
  create(recordId: string, message: string, runId?: string, expectedRevision?: string, attachmentIds?: readonly string[]): Promise<PublicPanelRun>;
  get(runId: string): Promise<PublicPanelRun | undefined>;
  subscribe(runId: string, listener: (run: PublicPanelRun) => void): Promise<(() => void) | undefined>;
  abortRun(runId: string): Promise<PublicPanelRun | undefined>;
  activeForRecord(recordId: string): Promise<PublicPanelRun | undefined>;
}
export interface AttachmentApi {
  upload(recordId: string, input: { fileName: string; mimeType: string; bytes: Uint8Array }): Promise<unknown>;
  download(attachmentId: string): Promise<{ fileName: string; mimeType: string; bytes: Buffer } | undefined>;
  preview?(attachmentId: string): Promise<{ mimeType: string; bytes: Buffer } | undefined>;
}
export interface CommandApi { dispatch(recordId: string, request: { command: string; args: string[] }): Promise<unknown> }
export interface ExperienceApi {
  assertAgent(agentId: string): void;
  settings(): Promise<PanelSettings>;
  patchSettings(patch: SettingsPatch): Promise<PanelSettings>;
  avatar(agentId: string): Promise<StoredAvatar | undefined>;
  putAvatar(agentId: string, input: Buffer): Promise<StoredAvatar>;
  deleteAvatar(agentId: string): Promise<boolean>;
}
export interface ReadApi {
  agents(): Promise<unknown[]>; sessions(agentId?: string, archived?: boolean): Promise<unknown[]>; conversation(recordId: string): Promise<unknown | null>;
  projects?(agentId: string): Promise<string[]>;
  search?(query: string, agentId?: string): Promise<unknown[]>;
  fork?(recordId: string, messageId: string): Promise<unknown>;
  editAndFork?(recordId: string, messageId: string, replacement: string): Promise<unknown>;
  createPanel?(agentId: string, title?: string): Promise<unknown>;
  updateSession?(recordId: string, patch: { title?: string; archived?: boolean; pinned?: boolean; project?: string | null; memoryDisposition?: "eligible" | "scratch" }): Promise<unknown>;
  deleteSession?(recordId: string, confirmed: boolean): Promise<unknown>;
  exportMarkdown?(recordId: string): Promise<{ filename: string; markdown: string } | null>;
}
export interface MemoryApi { list(agentId: string): Promise<unknown[]>; read(agentId: string, path: string): Promise<unknown> }
export interface MemoryConsolidationApi { agents(): string[]; candidate(recordId: string): Promise<unknown>; getCandidate(batchId: string): Promise<unknown>; confirm(batchId: string, contentHash: string): Promise<unknown> }
export interface AppOptions { auth: AuthConfig; publicDir: string; mock?: boolean; now?: () => number; generation?: GenerationApi; commands?: CommandApi; reads?: ReadApi; experience?: ExperienceApi; attachments?: AttachmentApi; memory?: MemoryApi; memoryConsolidation?: MemoryConsolidationApi; allowedHosts?: readonly string[]; publicOrigins?: readonly string[] }
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function send(res: ServerResponse, status: number, body: unknown, headers = {}): void { res.writeHead(status, { ...jsonHeaders, ...headers }); res.end(JSON.stringify(body)); }
function fail(res: ServerResponse, status: number, code: string, message: string, requestId: string): void { send(res, status, { error: { code, message, requestId } }); }
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new HttpError(413, "BODY_TOO_LARGE"); chunks.push(Buffer.from(chunk)); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
async function binaryBody(req: IncomingMessage, maximum: number, code = "AVATAR_TOO_LARGE"): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new HttpError(413, code);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw new HttpError(413, code); chunks.push(bytes); }
  return Buffer.concat(chunks, size);
}
function sameOrigin(req: IncomingMessage, options: AppOptions): boolean { const origin = req.headers.origin; if (!origin) return false; return options.publicOrigins?.includes(origin) ?? origin === `http://${req.headers.host}`; }
function allowedHost(req: IncomingMessage, options: AppOptions): boolean { return !options.allowedHosts || (!!req.headers.host && options.allowedHosts.includes(req.headers.host)); }
function validRunId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function createPanelServer(options: AppOptions) {
  const attempts = new Map<string, number[]>();
  return createServer(async (req, res) => {
    const requestId = crypto.randomUUID(); const url = new URL(req.url ?? "/", "http://panel.local");
    try {
      if (!allowedHost(req, options)) return fail(res, 421, "HOST_REJECTED", "请求主机不受信任", requestId);
      if (req.method === "GET" && url.pathname === "/api/v1/health") return send(res, 200, { data: { status: "ok" } });
      if (req.method === "POST" && url.pathname === "/api/v1/auth/login") {
        if (!sameOrigin(req, options)) return fail(res, 403, "ORIGIN_REJECTED", "请求来源不受信任", requestId);
        const ip = req.socket.remoteAddress ?? "unknown", now = (options.now ?? Date.now)(); const recent = (attempts.get(ip) ?? []).filter(t => now - t < 60_000);
        if (recent.length >= 5) return fail(res, 429, "LOGIN_RATE_LIMITED", "尝试次数过多，请稍后再试", requestId);
        recent.push(now); attempts.set(ip, recent);
        const value = await body(req) as { username?: unknown; password?: unknown };
        const valid = value.username === options.auth.username && typeof value.password === "string" && verifyPassword(value.password, options.auth.passwordHash);
        if (!valid) return fail(res, 401, "LOGIN_FAILED", "用户名或密码不正确", requestId);
        attempts.delete(ip); const csrf = newCsrf();
        return send(res, 200, { data: { username: options.auth.username, csrfToken: csrf } }, { "set-cookie": [cookie("panel_session", issueSession(options.auth.username, options.auth.sessionSecret, now), { httpOnly: true, secure: options.auth.secureCookie ?? false, maxAge: 604800 }), cookie("panel_csrf", csrf, { secure: options.auth.secureCookie ?? false, maxAge: 604800 })] });
      }
      if (url.pathname.startsWith("/api/v1/")) {
        const jar = cookies(req.headers.cookie); if (!verifySession(jar.panel_session, options.auth, (options.now ?? Date.now)())) return fail(res, 401, "AUTH_REQUIRED", "请先登录", requestId);
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") && (!sameOrigin(req, options) || !jar.panel_csrf || req.headers["x-csrf-token"] !== jar.panel_csrf)) return fail(res, 403, "CSRF_REJECTED", "安全校验失败，请刷新后重试", requestId);
        if (req.method === "GET" && url.pathname === "/api/v1/auth/session") return send(res, 200, { data: { username: options.auth.username, csrfToken: jar.panel_csrf } });
        if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") return send(res, 200, { data: null }, { "set-cookie": [cookie("panel_session", "", { httpOnly: true, secure: options.auth.secureCookie ?? false, maxAge: 0 }), cookie("panel_csrf", "", { secure: options.auth.secureCookie ?? false, maxAge: 0 })] });
        if (req.method === "GET" && url.pathname === "/api/v1/settings") {
          if (!options.experience) return fail(res, 501, "SETTINGS_NOT_CONNECTED", "设置存储尚未接入", requestId);
          return send(res, 200, { data: await options.experience.settings() });
        }
        if (req.method === "PATCH" && url.pathname === "/api/v1/settings") {
          if (!options.experience) return fail(res, 501, "SETTINGS_NOT_CONNECTED", "设置存储尚未接入", requestId);
          return send(res, 200, { data: await options.experience.patchSettings(validateSettingsPatch(await body(req))) });
        }
        const avatarMatch = /^\/api\/v1\/agents\/([^/]+)\/avatar$/.exec(url.pathname);
        if (avatarMatch && req.method === "GET") {
          if (!options.experience) return fail(res, 501, "SETTINGS_NOT_CONNECTED", "设置存储尚未接入", requestId);
          const avatar = await options.experience.avatar(decodeURIComponent(avatarMatch[1]!));
          if (!avatar) return fail(res, 404, "AVATAR_NOT_FOUND", "尚未设置自定义头像", requestId);
          if (req.headers["if-none-match"] === avatar.etag) { res.writeHead(304, { etag: avatar.etag, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" }); res.end(); return; }
          res.writeHead(200, { "content-type": "image/webp", "content-length": avatar.bytes.length, etag: avatar.etag, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" }); res.end(avatar.bytes); return;
        }
        if (avatarMatch && req.method === "PUT") {
          if (!options.experience) return fail(res, 501, "SETTINGS_NOT_CONNECTED", "设置存储尚未接入", requestId);
          const agentId = decodeURIComponent(avatarMatch[1]!); options.experience.assertAgent(agentId);
          const avatar = await options.experience.putAvatar(agentId, await binaryBody(req, MAX_AVATAR_BYTES));
          return send(res, 200, { data: { etag: avatar.etag } });
        }
        if (avatarMatch && req.method === "DELETE") {
          if (!options.experience) return fail(res, 501, "SETTINGS_NOT_CONNECTED", "设置存储尚未接入", requestId);
          await options.experience.deleteAvatar(decodeURIComponent(avatarMatch[1]!)); return send(res, 200, { data: null });
        }
        const attachmentUploadMatch = /^\/api\/v1\/sessions\/([^/]+)\/attachments$/.exec(url.pathname);
        if (attachmentUploadMatch && req.method === "POST") {
          if (!options.attachments) return fail(res, 501, "ATTACHMENTS_NOT_CONNECTED", "附件存储尚未接入", requestId);
          const encodedName = req.headers["x-file-name"];
          if (typeof encodedName !== "string") return fail(res, 400, "ATTACHMENT_NAME_REQUIRED", "缺少附件文件名", requestId);
          let fileName: string; try { fileName = decodeURIComponent(encodedName); }
          catch { return fail(res, 400, "ATTACHMENT_NAME_INVALID", "附件文件名格式无效", requestId); }
          const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase() || "application/octet-stream";
          const recordId = decodeURIComponent(attachmentUploadMatch[1]!);
          return send(res, 201, { data: await options.attachments.upload(recordId, { fileName, mimeType,
            bytes: await binaryBody(req, MAX_ATTACHMENT_BYTES, "ATTACHMENT_TOO_LARGE") }) });
        }
        const attachmentDownloadMatch = /^\/api\/v1\/files\/([^/]+)\/download$/.exec(url.pathname);
        if (attachmentDownloadMatch && req.method === "GET") {
          if (!options.attachments) return fail(res, 501, "ATTACHMENTS_NOT_CONNECTED", "附件存储尚未接入", requestId);
          const file = await options.attachments.download(decodeURIComponent(attachmentDownloadMatch[1]!));
          if (!file) return fail(res, 404, "ATTACHMENT_NOT_FOUND", "附件不存在", requestId);
          const ascii = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
          res.writeHead(200, { "content-type": file.mimeType, "content-length": file.bytes.length,
            "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            "cache-control": "no-store", "x-content-type-options": "nosniff" });
          res.end(file.bytes); return;
        }
        const attachmentPreviewMatch = /^\/api\/v1\/files\/([^/]+)\/preview$/.exec(url.pathname);
        if (attachmentPreviewMatch && req.method === "GET") {
          if (!options.attachments?.preview) return fail(res, 501, "ATTACHMENT_PREVIEW_NOT_CONNECTED", "图片预览尚未接入", requestId);
          const file = await options.attachments.preview(decodeURIComponent(attachmentPreviewMatch[1]!));
          if (!file) return fail(res, 404, "ATTACHMENT_NOT_FOUND", "附件不存在", requestId);
          res.writeHead(200, { "content-type": file.mimeType, "content-length": file.bytes.length,
            "content-disposition": "inline", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox" });
          res.end(file.bytes); return;
        }
        if (req.method === "GET" && url.pathname === "/api/v1/agents") return send(res, 200, { data: options.mock ? mockAgents : await options.reads?.agents() ?? [] });
        if (req.method === "GET" && url.pathname === "/api/v1/memory") {
          if (!options.memory) return fail(res, 501, "MEMORY_NOT_CONNECTED", "记忆中心尚未接入", requestId);
          const agentId = url.searchParams.get("agentId"); if (!agentId) return fail(res, 400, "AGENT_REQUIRED", "需要指定 Agent", requestId);
          return send(res, 200, { data: await options.memory.list(agentId) });
        }
        if (req.method === "GET" && url.pathname === "/api/v1/memory/file") {
          if (!options.memory) return fail(res, 501, "MEMORY_NOT_CONNECTED", "记忆中心尚未接入", requestId);
          const agentId = url.searchParams.get("agentId"), path = url.searchParams.get("path");
          if (!agentId) return fail(res, 400, "AGENT_REQUIRED", "需要指定 Agent", requestId);
          if (!path) return fail(res, 400, "MEMORY_PATH_REQUIRED", "需要指定记忆文件", requestId);
          return send(res, 200, { data: await options.memory.read(agentId, path) });
        }
        if (req.method === "GET" && url.pathname === "/api/v1/memory/consolidation") {
          return send(res, 200, { data: { agents: options.memoryConsolidation?.agents() ?? [] } });
        }
        if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/memory\/candidates$/.test(url.pathname)) {
          if (!options.memoryConsolidation) return fail(res, 501, "MEMORY_CONSOLIDATION_NOT_CONNECTED", "记忆整理尚未接入", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/memory/candidates".length));
          return send(res, 201, { data: await options.memoryConsolidation.candidate(recordId) });
        }
        if (req.method === "GET" && /^\/api\/v1\/memory\/candidates\/[^/]+$/.test(url.pathname)) {
          if (!options.memoryConsolidation) return fail(res, 501, "MEMORY_CONSOLIDATION_NOT_CONNECTED", "记忆整理尚未接入", requestId);
          return send(res, 200, { data: await options.memoryConsolidation.getCandidate(decodeURIComponent(url.pathname.slice("/api/v1/memory/candidates/".length))) });
        }
        if (req.method === "POST" && /^\/api\/v1\/memory\/candidates\/[^/]+\/confirm$/.test(url.pathname)) {
          if (!options.memoryConsolidation) return fail(res, 501, "MEMORY_CONSOLIDATION_NOT_CONNECTED", "记忆整理尚未接入", requestId);
          const value = await body(req) as { contentHash?: unknown }; if (typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.contentHash)) return fail(res, 400, "MEMORY_CANDIDATE_HASH_INVALID", "候选校验值格式无效", requestId);
          const batchId = decodeURIComponent(url.pathname.slice("/api/v1/memory/candidates/".length, -"/confirm".length));
          return send(res, 200, { data: await options.memoryConsolidation.confirm(batchId, value.contentHash) });
        }
        if (req.method === "GET" && url.pathname === "/api/v1/sessions") { const agentId = url.searchParams.get("agentId") ?? undefined, archivedValue = url.searchParams.get("archived"); if (archivedValue !== null && !["true", "false"].includes(archivedValue)) return fail(res, 400, "ARCHIVED_FILTER_INVALID", "归档筛选格式无效", requestId); const archived = archivedValue === null ? false : archivedValue === "true"; return send(res, 200, { data: options.mock ? mockSessions.filter(s => !agentId || s.agentId === agentId) : await options.reads?.sessions(agentId, archived) ?? [] }); }
        if (req.method === "GET" && url.pathname === "/api/v1/projects") { const agentId = url.searchParams.get("agentId"); if (!agentId) return fail(res, 400, "AGENT_REQUIRED", "需要指定 Agent", requestId); return send(res, 200, { data: options.mock ? [] : await options.reads?.projects?.(agentId) ?? [] }); }
        if (req.method === "GET" && url.pathname === "/api/v1/revisions") { const agentId = url.searchParams.get("agentId") ?? undefined; const records = options.mock ? mockSessions : await options.reads?.sessions(agentId) ?? []; return send(res, 200, { data: (records as Array<Record<string, unknown>>).map(item => ({ recordId: item.recordId, revision: item.revision, updatedAt: item.updatedAt })) }); }
        if (req.method === "GET" && url.pathname === "/api/v1/search") { const query = url.searchParams.get("q") ?? "", agentId = url.searchParams.get("agentId") ?? undefined; return send(res, 200, { data: options.mock ? [] : await options.reads?.search?.(query, agentId) ?? [] }); }
        if (req.method === "POST" && url.pathname === "/api/v1/sessions") {
          if (!options.reads?.createPanel) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { agentId?: unknown; title?: unknown }; if (typeof value.agentId !== "string") return fail(res, 400, "AGENT_ID_REQUIRED", "缺少 agentId", requestId); if (value.title !== undefined && typeof value.title !== "string") return fail(res, 400, "TITLE_INVALID", "标题格式无效", requestId);
          return send(res, 201, { data: await options.reads.createPanel(value.agentId, value.title?.trim() || undefined) });
        }
        if (req.method === "PATCH" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
          if (!options.reads?.updateSession) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { title?: unknown; archived?: unknown; pinned?: unknown; project?: unknown; memoryDisposition?: unknown };
          if (value.title === undefined && value.archived === undefined && value.pinned === undefined && value.project === undefined && value.memoryDisposition === undefined) return fail(res, 400, "SESSION_UPDATE_EMPTY", "没有需要修改的字段", requestId);
          if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.trim().length > 120)) return fail(res, 400, "SESSION_TITLE_INVALID", "标题格式无效", requestId);
          if (value.archived !== undefined && typeof value.archived !== "boolean") return fail(res, 400, "SESSION_ARCHIVED_INVALID", "归档状态格式无效", requestId);
          if (value.pinned !== undefined && typeof value.pinned !== "boolean") return fail(res, 400, "SESSION_PINNED_INVALID", "置顶状态格式无效", requestId);
          if (value.project !== undefined && value.project !== null && (typeof value.project !== "string" || !value.project.trim() || value.project.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(value.project))) return fail(res, 400, "SESSION_PROJECT_INVALID", "project 格式无效", requestId);
          if (value.memoryDisposition !== undefined && !["eligible", "scratch"].includes(String(value.memoryDisposition))) return fail(res, 400, "MEMORY_DISPOSITION_INVALID", "记忆处置状态格式无效", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length)); return send(res, 200, { data: await options.reads.updateSession(recordId, { ...(typeof value.title === "string" ? { title: value.title.trim() } : {}), ...(typeof value.archived === "boolean" ? { archived: value.archived } : {}), ...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}), ...(typeof value.project === "string" || value.project === null ? { project: value.project } : {}), ...(value.memoryDisposition === "eligible" || value.memoryDisposition === "scratch" ? { memoryDisposition: value.memoryDisposition } : {}) }) });
        }
        if (req.method === "DELETE" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
          if (!options.reads?.deleteSession) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { confirm?: unknown };
          if (value.confirm !== true) return fail(res, 400, "SESSION_DELETE_CONFIRMATION_REQUIRED", "删除需要明确确认", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length));
          if (await options.generation?.activeForRecord(recordId)) return fail(res, 409, "SESSION_BUSY", "该会话正在生成，不能删除", requestId);
          return send(res, 200, { data: await options.reads.deleteSession(recordId, true) });
        }
        if (req.method === "GET" && /^\/api\/v1\/sessions\/[^/]+\/export\.md$/.test(url.pathname)) {
          if (!options.reads?.exportMarkdown) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/export.md".length)); const exported = await options.reads.exportMarkdown(recordId);
          if (!exported) return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在", requestId);
          const ascii = exported.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(exported.markdown); return;
        }
        if (req.method === "GET" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) { const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length)); return send(res, 200, { data: options.mock ? mockConversation : await options.reads?.conversation(recordId) ?? null }); }
        if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/fork$/.test(url.pathname)) {
          if (!options.reads?.fork) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { messageId?: unknown }; if (typeof value.messageId !== "string") return fail(res, 400, "MESSAGE_ID_REQUIRED", "缺少分叉消息", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/fork".length)); return send(res, 201, { data: await options.reads.fork(recordId, value.messageId) });
        }
        if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/command$/.test(url.pathname)) {
          if (!options.commands) return fail(res, 501, "COMMANDS_NOT_CONNECTED", "命令派发器尚未接入", requestId);
          const value = await body(req) as { command?: unknown; args?: unknown };
          if (typeof value.command !== "string" || !value.command || !Array.isArray(value.args) || value.args.some(item => typeof item !== "string")) return fail(res, 400, "COMMAND_REQUEST_INVALID", "命令请求格式无效", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/command".length));
          return send(res, 200, { data: await options.commands.dispatch(recordId, { command: value.command, args: value.args as string[] }) });
        }
        if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/messages\/[^/]+\/resend$/.test(url.pathname)) {
          if (!options.reads?.editAndFork) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const match = /^\/api\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/resend$/.exec(url.pathname)!;
          const value = await body(req) as { message?: unknown }; if (typeof value.message !== "string" || !value.message.trim()) return fail(res, 400, "MESSAGE_REQUIRED", "消息不能为空", requestId);
          return send(res, 201, { data: await options.reads.editAndFork(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), value.message) });
        }
        if (req.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/runs$/.test(url.pathname)) {
          if (!options.generation) return fail(res, 501, "GATEWAY_NOT_CONNECTED", "后台任务适配器尚未接入", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/runs".length));
          if (options.reads) { const target = await options.reads.conversation(recordId) as { sourceKind?: unknown } | null; if (!target) return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在", requestId); if (target.sourceKind !== "panel") return fail(res, 409, "SOURCE_READ_ONLY", "真实活会话和归档只读，请先 fork 为面板会话", requestId); }
          const value = await body(req) as { message?: unknown; revision?: unknown; attachmentIds?: unknown };
          if (typeof value.message !== "string") return fail(res, 400, "MESSAGE_REQUIRED", "消息格式错误", requestId);
          if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 10 || value.attachmentIds.some(item => typeof item !== "string"))) return fail(res, 400, "ATTACHMENTS_INVALID", "附件列表格式错误", requestId);
          const attachmentIds = (value.attachmentIds ?? []) as string[];
          if (!value.message.trim() && attachmentIds.length === 0) return fail(res, 400, "MESSAGE_REQUIRED", "消息和附件不能同时为空", requestId);
          if (value.revision !== undefined && typeof value.revision !== "string") return fail(res, 400, "REVISION_INVALID", "revision 格式错误", requestId);
          const retryKey = req.headers["idempotency-key"];
          if (retryKey !== undefined && !validRunId(retryKey)) return fail(res, 400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 格式错误", requestId);
          const created = await options.generation.create(recordId, value.message, typeof retryKey === "string" ? retryKey : undefined, typeof value.revision === "string" ? value.revision : undefined, attachmentIds) as PublicPanelRun & { newlyCreated?: boolean };
          const { newlyCreated, ...snapshot } = created; return send(res, newlyCreated === false ? 200 : 202, { data: snapshot });
        }
        if (req.method === "GET" && /^\/api\/v1\/sessions\/[^/]+\/runs\/active$/.test(url.pathname)) {
          if (!options.generation) return fail(res, 501, "GATEWAY_NOT_CONNECTED", "后台任务适配器尚未接入", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length, -"/runs/active".length));
          return send(res, 200, { data: await options.generation.activeForRecord(recordId) ?? null });
        }
        if (req.method === "GET" && /^\/api\/v1\/runs\/[^/]+$/.test(url.pathname)) {
          if (!options.generation) return fail(res, 501, "GATEWAY_NOT_CONNECTED", "后台任务适配器尚未接入", requestId);
          const runId = decodeURIComponent(url.pathname.slice("/api/v1/runs/".length));
          if (!validRunId(runId)) return fail(res, 400, "RUN_ID_INVALID", "runId 格式错误", requestId);
          const run = await options.generation.get(runId); return run ? send(res, 200, { data: run }) : fail(res, 404, "RUN_NOT_FOUND", "任务不存在", requestId);
        }
        if (req.method === "GET" && /^\/api\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
          if (!options.generation) return fail(res, 501, "GATEWAY_NOT_CONNECTED", "后台任务适配器尚未接入", requestId);
          const runId = decodeURIComponent(url.pathname.slice("/api/v1/runs/".length, -"/events".length));
          if (!validRunId(runId)) return fail(res, 400, "RUN_ID_INVALID", "runId 格式错误", requestId);
          if (!await options.generation.get(runId)) return fail(res, 404, "RUN_NOT_FOUND", "任务不存在", requestId);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
          let first = true, terminal = false;
          const write = (name: string, data: PublicPanelRun) => { if (!res.writableEnded && !res.destroyed) res.write(`id: ${data.sequence}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
          const unsubscribe = await options.generation.subscribe(runId, run => {
            write(first ? "run.snapshot" : "run.updated", run); first = false;
            if (["completed", "failed", "aborted"].includes(run.status)) { terminal = true; write(`run.${run.status}`, run); res.end(); }
          });
          if (!unsubscribe) { if (!res.writableEnded) res.end(); return; }
          if (!terminal) {
            const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
            res.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
          }
          return;
        }
        if (req.method === "POST" && /^\/api\/v1\/runs\/[^/]+\/abort$/.test(url.pathname)) {
          if (!options.generation) return fail(res, 501, "GATEWAY_NOT_CONNECTED", "推理适配器尚未接入", requestId);
          const runId = decodeURIComponent(url.pathname.slice("/api/v1/runs/".length, -"/abort".length));
          if (!validRunId(runId)) return fail(res, 400, "RUN_ID_INVALID", "runId 格式错误", requestId);
          const run = await options.generation.abortRun(runId); return run ? send(res, 200, { data: run }) : fail(res, 404, "RUN_NOT_FOUND", "任务不存在", requestId);
        }
        return fail(res, 404, "NOT_FOUND", "接口不存在", requestId);
      }
      const pathname = url.pathname === "/" ? "index.html" : url.pathname.slice(1); const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, ""); const file = join(options.publicDir, safe);
      const types: Record<string,string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
      try { const [root, resolved] = await Promise.all([realpath(options.publicDir), realpath(file)]); const fromRoot = relative(root, resolved); if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) throw new Error("STATIC_PATH_ESCAPE"); const data = await readFile(resolved); res.writeHead(200, { "content-type": types[extname(resolved)] ?? "application/octet-stream", "cache-control": pathname === "index.html" ? "no-store" : "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob: https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(data); }
      catch { fail(res, 404, "NOT_FOUND", "页面不存在", requestId); }
    } catch (error) {
      const known: Record<string, [number, string]> = { AGENT_NOT_ALLOWED: [403, "Agent 不在允许列表中"], SETTINGS_INVALID: [400, "设置格式无效"], SETTINGS_UPDATE_EMPTY: [400, "没有需要修改的设置"], SETTINGS_CORRUPT: [500, "设置存储已损坏"], PANEL_STORAGE_UNSAFE: [500, "设置存储暂不可用"], AVATAR_STORAGE_INVALID: [500, "头像存储异常，请重新上传头像"], AVATAR_TOO_LARGE: [413, "头像文件不能超过 5 MiB"], AVATAR_INVALID: [400, "头像必须是有效的 PNG、JPEG 或 WebP，且不超过 4096×4096"], ATTACHMENT_PREVIEW_UNSUPPORTED: [415, "该附件不是可安全预览的 PNG、JPEG 或 WebP 图片"], SESSION_NOT_FOUND: [404, "会话不存在"], SESSION_UPDATE_EMPTY: [400, "没有需要修改的字段"], SESSION_TITLE_INVALID: [400, "标题格式无效"], SESSION_DELETE_CONFIRMATION_REQUIRED: [400, "删除需要明确确认"], SESSION_NOT_ARCHIVED: [409, "面板会话必须先归档才能彻底删除"], PANEL_SESSION_DELETE_UNSAFE: [409, "会话目录包含未知内容，已拒绝删除"], PANEL_SESSION_NOT_FOUND: [404, "面板会话不存在"], EDIT_TARGET_NOT_USER: [409, "只能编辑用户消息"], PANEL_SESSION_CREATE_FAILED: [500, "面板会话创建失败"], COMMAND_NOT_ALLOWED: [403, "该命令未获面板允许"], COMMAND_ARGS_INVALID: [400, "命令参数无效"], MODEL_NOT_AVAILABLE: [400, "模型不可用"], THINKING_LEVEL_INVALID: [400, "思考等级无效"], THINKING_LEVEL_UNSUPPORTED: [409, "当前模型不支持该思考等级"], REASONING_LEVEL_INVALID: [400, "推理显示模式无效"], IDEMPOTENCY_KEY_REUSED: [409, "重试标识已用于其他请求"], SESSION_BUSY: [409, "该会话正在生成"], MEMORY_AGENT_NOT_CONFIGURED: [404, "该 Agent 未配置可读取的 workspace"], MEMORY_PATH_NOT_ALLOWED: [403, "记忆文件不在允许范围内"], MEMORY_FILE_NOT_FOUND: [404, "记忆文件不存在"], MEMORY_FILE_TOO_LARGE: [413, "记忆文件超过读取上限"], MEMORY_FILE_LIMIT_EXCEEDED: [413, "记忆文件数量超过读取上限"], MEMORY_FILE_UNSAFE: [409, "记忆文件不安全，已拒绝读取"], MEMORY_WORKSPACE_UNSAFE: [409, "记忆 workspace 不安全，已拒绝读取"] };
      Object.assign(known, { MEMORY_CONSOLIDATION_NOT_CONFIGURED: [501, "该 Agent 未配置独立记忆整理 runtime"], MEMORY_RUNTIME_NOT_RESTRICTED: [409, "记忆整理 runtime 含有非只读工具，已拒绝运行"], MEMORY_SOURCE_NOT_ELIGIBLE: [409, "该会话未允许整理进记忆"], MEMORY_NOTHING_TO_CONSOLIDATE: [409, "没有尚未整理的新内容"], MEMORY_CHECKPOINT_INVALID: [409, "记忆检查点已失效"], MEMORY_CANDIDATE_EMPTY: [502, "模型没有生成可用的记忆候选"], MEMORY_WORKSPACE_CHANGED_DURING_PREVIEW: [409, "候选生成期间 workspace 发生变化，已拒绝保存候选"], MEMORY_SOURCE_CHANGED_DURING_PREVIEW: [409, "候选生成期间会话分支发生变化，请重新整理"], MEMORY_CANDIDATE_NOT_FOUND: [404, "记忆候选不存在"], MEMORY_CANDIDATE_HASH_MISMATCH: [409, "记忆候选校验失败"], MEMORY_CANDIDATE_STALE: [409, "记忆候选已过期，请重新生成"], MEMORY_CANDIDATE_INVALID: [400, "记忆候选为空或超过大小上限"], MEMORY_CANDIDATE_CORRUPT: [500, "记忆候选存储已损坏"], MEMORY_TARGET_CONFLICT: [409, "目标记忆文件已存在且内容不同"], MEMORY_STORAGE_UNSAFE: [500, "记忆整理存储不安全"], MEMORY_INDEX_REFRESH_FAILED: [502, "记忆已安全写入，但 OpenClaw 索引刷新失败；请重试确认"] });
      const code = error instanceof ForkError ? error.code : error instanceof Error ? error.message : "INVALID_REQUEST"; const mapped = known[code];
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : error instanceof ForkError ? 409 : mapped?.[0] ?? 500;
      fail(res, status, error instanceof HttpError ? error.code : error instanceof ForkError ? error.code : mapped ? code : "INVALID_REQUEST", error instanceof ForkError ? error.message : mapped?.[1] ?? "请求无法处理", requestId);
    }
  });
}
