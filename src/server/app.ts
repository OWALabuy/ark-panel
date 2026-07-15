import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { cookie, cookies, issueSession, newCsrf, verifyPassword, verifySession, type AuthConfig } from "./auth.js";
import { mockAgents, mockConversation, mockSessions } from "./mock-data.js";
import { ForkError } from "../domain/fork.js";
import type { PublicPanelRun } from "./run-store.js";
import { MAX_AVATAR_BYTES, validateSettingsPatch, type PanelSettings, type SettingsPatch, type StoredAvatar } from "./experience-store.js";

export interface GenerationApi {
  create(recordId: string, message: string, runId?: string, expectedRevision?: string): Promise<PublicPanelRun>;
  get(runId: string): Promise<PublicPanelRun | undefined>;
  subscribe(runId: string, listener: (run: PublicPanelRun) => void): Promise<(() => void) | undefined>;
  abortRun(runId: string): Promise<PublicPanelRun | undefined>;
  activeForRecord(recordId: string): Promise<PublicPanelRun | undefined>;
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
  search?(query: string, agentId?: string): Promise<unknown[]>;
  fork?(recordId: string, messageId: string): Promise<unknown>;
  editAndFork?(recordId: string, messageId: string, replacement: string): Promise<unknown>;
  createPanel?(agentId: string, title?: string): Promise<unknown>;
  updateSession?(recordId: string, patch: { title?: string; archived?: boolean; pinned?: boolean; project?: string | null }): Promise<unknown>;
  deleteSession?(recordId: string, confirmed: boolean): Promise<unknown>;
  exportMarkdown?(recordId: string): Promise<{ filename: string; markdown: string } | null>;
}
export interface AppOptions { auth: AuthConfig; publicDir: string; mock?: boolean; now?: () => number; generation?: GenerationApi; commands?: CommandApi; reads?: ReadApi; experience?: ExperienceApi; allowedHosts?: readonly string[]; publicOrigins?: readonly string[] }
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function send(res: ServerResponse, status: number, body: unknown, headers = {}): void { res.writeHead(status, { ...jsonHeaders, ...headers }); res.end(JSON.stringify(body)); }
function fail(res: ServerResponse, status: number, code: string, message: string, requestId: string): void { send(res, status, { error: { code, message, requestId } }); }
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new HttpError(413, "BODY_TOO_LARGE"); chunks.push(Buffer.from(chunk)); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
async function binaryBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new HttpError(413, "AVATAR_TOO_LARGE");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw new HttpError(413, "AVATAR_TOO_LARGE"); chunks.push(bytes); }
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
        if (req.method === "GET" && url.pathname === "/api/v1/agents") return send(res, 200, { data: options.mock ? mockAgents : await options.reads?.agents() ?? [] });
        if (req.method === "GET" && url.pathname === "/api/v1/sessions") { const agentId = url.searchParams.get("agentId") ?? undefined, archivedValue = url.searchParams.get("archived"); if (archivedValue !== null && !["true", "false"].includes(archivedValue)) return fail(res, 400, "ARCHIVED_FILTER_INVALID", "归档筛选格式无效", requestId); const archived = archivedValue === null ? false : archivedValue === "true"; return send(res, 200, { data: options.mock ? mockSessions.filter(s => !agentId || s.agentId === agentId) : await options.reads?.sessions(agentId, archived) ?? [] }); }
        if (req.method === "GET" && url.pathname === "/api/v1/revisions") { const agentId = url.searchParams.get("agentId") ?? undefined; const records = options.mock ? mockSessions : await options.reads?.sessions(agentId) ?? []; return send(res, 200, { data: (records as Array<Record<string, unknown>>).map(item => ({ recordId: item.recordId, revision: item.revision, updatedAt: item.updatedAt })) }); }
        if (req.method === "GET" && url.pathname === "/api/v1/search") { const query = url.searchParams.get("q") ?? "", agentId = url.searchParams.get("agentId") ?? undefined; return send(res, 200, { data: options.mock ? [] : await options.reads?.search?.(query, agentId) ?? [] }); }
        if (req.method === "POST" && url.pathname === "/api/v1/sessions") {
          if (!options.reads?.createPanel) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { agentId?: unknown; title?: unknown }; if (typeof value.agentId !== "string") return fail(res, 400, "AGENT_ID_REQUIRED", "缺少 agentId", requestId); if (value.title !== undefined && typeof value.title !== "string") return fail(res, 400, "TITLE_INVALID", "标题格式无效", requestId);
          return send(res, 201, { data: await options.reads.createPanel(value.agentId, value.title?.trim() || undefined) });
        }
        if (req.method === "PATCH" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
          if (!options.reads?.updateSession) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { title?: unknown; archived?: unknown; pinned?: unknown; project?: unknown };
          if (value.title === undefined && value.archived === undefined && value.pinned === undefined && value.project === undefined) return fail(res, 400, "SESSION_UPDATE_EMPTY", "没有需要修改的字段", requestId);
          if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.trim().length > 120)) return fail(res, 400, "SESSION_TITLE_INVALID", "标题格式无效", requestId);
          if (value.archived !== undefined && typeof value.archived !== "boolean") return fail(res, 400, "SESSION_ARCHIVED_INVALID", "归档状态格式无效", requestId);
          if (value.pinned !== undefined && typeof value.pinned !== "boolean") return fail(res, 400, "SESSION_PINNED_INVALID", "置顶状态格式无效", requestId);
          if (value.project !== undefined && value.project !== null && (typeof value.project !== "string" || !value.project.trim() || value.project.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(value.project))) return fail(res, 400, "SESSION_PROJECT_INVALID", "project 格式无效", requestId);
          const recordId = decodeURIComponent(url.pathname.slice("/api/v1/sessions/".length)); return send(res, 200, { data: await options.reads.updateSession(recordId, { ...(typeof value.title === "string" ? { title: value.title.trim() } : {}), ...(typeof value.archived === "boolean" ? { archived: value.archived } : {}), ...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}), ...(typeof value.project === "string" || value.project === null ? { project: value.project } : {}) }) });
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
          const value = await body(req) as { message?: unknown; revision?: unknown };
          if (typeof value.message !== "string" || !value.message.trim()) return fail(res, 400, "MESSAGE_REQUIRED", "消息不能为空", requestId);
          if (value.revision !== undefined && typeof value.revision !== "string") return fail(res, 400, "REVISION_INVALID", "revision 格式错误", requestId);
          const retryKey = req.headers["idempotency-key"];
          if (retryKey !== undefined && !validRunId(retryKey)) return fail(res, 400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 格式错误", requestId);
          const created = await options.generation.create(recordId, value.message, typeof retryKey === "string" ? retryKey : undefined, typeof value.revision === "string" ? value.revision : undefined) as PublicPanelRun & { newlyCreated?: boolean };
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
      try { const [root, resolved] = await Promise.all([realpath(options.publicDir), realpath(file)]); const fromRoot = relative(root, resolved); if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) throw new Error("STATIC_PATH_ESCAPE"); const data = await readFile(resolved); res.writeHead(200, { "content-type": types[extname(resolved)] ?? "application/octet-stream", "cache-control": pathname === "index.html" ? "no-store" : "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(data); }
      catch { fail(res, 404, "NOT_FOUND", "页面不存在", requestId); }
    } catch (error) {
      const known: Record<string, [number, string]> = { AGENT_NOT_ALLOWED: [403, "Agent 不在允许列表中"], SETTINGS_INVALID: [400, "设置格式无效"], SETTINGS_UPDATE_EMPTY: [400, "没有需要修改的设置"], SETTINGS_CORRUPT: [500, "设置存储已损坏"], PANEL_STORAGE_UNSAFE: [500, "设置存储暂不可用"], AVATAR_STORAGE_INVALID: [500, "头像存储异常，请重新上传头像"], AVATAR_TOO_LARGE: [413, "头像文件不能超过 5 MiB"], AVATAR_INVALID: [400, "头像必须是有效的 PNG、JPEG 或 WebP，且不超过 4096×4096"], SESSION_NOT_FOUND: [404, "会话不存在"], SESSION_UPDATE_EMPTY: [400, "没有需要修改的字段"], SESSION_TITLE_INVALID: [400, "标题格式无效"], SESSION_DELETE_CONFIRMATION_REQUIRED: [400, "删除需要明确确认"], SESSION_NOT_ARCHIVED: [409, "面板会话必须先归档才能彻底删除"], PANEL_SESSION_DELETE_UNSAFE: [409, "会话目录包含未知内容，已拒绝删除"], PANEL_SESSION_NOT_FOUND: [404, "面板会话不存在"], EDIT_TARGET_NOT_USER: [409, "只能编辑用户消息"], PANEL_SESSION_CREATE_FAILED: [500, "面板会话创建失败"], COMMAND_NOT_ALLOWED: [403, "该命令未获面板允许"], COMMAND_ARGS_INVALID: [400, "命令参数无效"], MODEL_NOT_AVAILABLE: [400, "模型不可用"], THINKING_LEVEL_INVALID: [400, "思考等级无效"], THINKING_LEVEL_UNSUPPORTED: [409, "当前模型不支持该思考等级"], REASONING_LEVEL_INVALID: [400, "推理显示模式无效"], IDEMPOTENCY_KEY_REUSED: [409, "重试标识已用于其他请求"], SESSION_BUSY: [409, "该会话正在生成"] };
      const code = error instanceof ForkError ? error.code : error instanceof Error ? error.message : "INVALID_REQUEST"; const mapped = known[code];
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : error instanceof ForkError ? 409 : mapped?.[0] ?? 500;
      fail(res, status, error instanceof HttpError ? error.code : error instanceof ForkError ? error.code : mapped ? code : "INVALID_REQUEST", error instanceof ForkError ? error.message : mapped?.[1] ?? "请求无法处理", requestId);
    }
  });
}
