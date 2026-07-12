import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { cookie, cookies, issueSession, newCsrf, verifyPassword, verifySession, type AuthConfig } from "./auth.js";
import { mockAgents, mockConversation, mockSessions } from "./mock-data.js";
import { ContextBudgetExceededError } from "../domain/context-budget.js";
import { ForkError } from "../domain/fork.js";

export interface GenerationApi { generate(recordId: string, message: string, signal: AbortSignal, runId: string, expectedRevision?: string): Promise<{ runId: string; entries: unknown[]; revision?: string }> }
export interface CommandApi { dispatch(recordId: string, request: { command: string; args: string[] }): Promise<unknown> }
export interface ReadApi {
  agents(): Promise<unknown[]>; sessions(agentId?: string): Promise<unknown[]>; conversation(recordId: string): Promise<unknown | null>;
  search?(query: string, agentId?: string): Promise<unknown[]>;
  fork?(recordId: string, messageId: string): Promise<unknown>;
  editAndFork?(recordId: string, messageId: string, replacement: string): Promise<unknown>;
  createPanel?(agentId: string, title?: string): Promise<unknown>;
}
export interface AppOptions { auth: AuthConfig; publicDir: string; mock?: boolean; now?: () => number; generation?: GenerationApi; commands?: CommandApi; reads?: ReadApi; allowedHosts?: readonly string[]; publicOrigins?: readonly string[] }
const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function send(res: ServerResponse, status: number, body: unknown, headers = {}): void { res.writeHead(status, { ...jsonHeaders, ...headers }); res.end(JSON.stringify(body)); }
function fail(res: ServerResponse, status: number, code: string, message: string, requestId: string): void { send(res, status, { error: { code, message, requestId } }); }
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new HttpError(413, "BODY_TOO_LARGE"); chunks.push(Buffer.from(chunk)); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function sameOrigin(req: IncomingMessage, options: AppOptions): boolean { const origin = req.headers.origin; if (!origin) return false; return options.publicOrigins?.includes(origin) ?? origin === `http://${req.headers.host}`; }
function allowedHost(req: IncomingMessage, options: AppOptions): boolean { return !options.allowedHosts || (!!req.headers.host && options.allowedHosts.includes(req.headers.host)); }

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
        if (req.method === "GET" && url.pathname === "/api/v1/agents") return send(res, 200, { data: options.mock ? mockAgents : await options.reads?.agents() ?? [] });
        if (req.method === "GET" && url.pathname === "/api/v1/sessions") { const agentId = url.searchParams.get("agentId") ?? undefined; return send(res, 200, { data: options.mock ? mockSessions.filter(s => !agentId || s.agentId === agentId) : await options.reads?.sessions(agentId) ?? [] }); }
        if (req.method === "GET" && url.pathname === "/api/v1/revisions") { const agentId = url.searchParams.get("agentId") ?? undefined; const records = options.mock ? mockSessions : await options.reads?.sessions(agentId) ?? []; return send(res, 200, { data: (records as Array<Record<string, unknown>>).map(item => ({ recordId: item.recordId, revision: item.revision, updatedAt: item.updatedAt })) }); }
        if (req.method === "GET" && url.pathname === "/api/v1/search") { const query = url.searchParams.get("q") ?? "", agentId = url.searchParams.get("agentId") ?? undefined; return send(res, 200, { data: options.mock ? [] : await options.reads?.search?.(query, agentId) ?? [] }); }
        if (req.method === "POST" && url.pathname === "/api/v1/sessions") {
          if (!options.reads?.createPanel) return fail(res, 501, "DATA_NOT_CONNECTED", "数据层尚未接入", requestId);
          const value = await body(req) as { agentId?: unknown; title?: unknown }; if (typeof value.agentId !== "string") return fail(res, 400, "AGENT_ID_REQUIRED", "缺少 agentId", requestId); if (value.title !== undefined && typeof value.title !== "string") return fail(res, 400, "TITLE_INVALID", "标题格式无效", requestId);
          return send(res, 201, { data: await options.reads.createPanel(value.agentId, value.title?.trim() || undefined) });
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
        if (req.method === "POST" && url.pathname.endsWith("/messages")) {
          if (!options.generation) return send(res, 501, { error: { code: "GATEWAY_NOT_CONNECTED", message: "推理适配器尚未接入", requestId } });
          const match = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname); if (!match) return fail(res, 404, "NOT_FOUND", "接口不存在", requestId);
          const targetRecordId = decodeURIComponent(match[1]!);
          if (options.reads) { const target = await options.reads.conversation(targetRecordId) as { sourceKind?: unknown } | null; if (!target) return fail(res, 404, "SESSION_NOT_FOUND", "会话不存在", requestId); if (target.sourceKind !== "panel") return fail(res, 409, "SOURCE_READ_ONLY", "真实活会话和归档在首版中只读，请先 fork 为面板会话", requestId); }
          const value = await body(req) as { message?: unknown; revision?: unknown }; if (typeof value.message !== "string" || !value.message.trim()) return fail(res, 400, "MESSAGE_REQUIRED", "消息不能为空", requestId);
          if (value.revision !== undefined && typeof value.revision !== "string") return fail(res, 400, "REVISION_INVALID", "revision 格式错误", requestId);
          const retryKey = req.headers["idempotency-key"];
          if (retryKey !== undefined && (typeof retryKey !== "string" || !/^[0-9a-f-]{36}$/i.test(retryKey))) return fail(res, 400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 格式错误", requestId);
          const controller = new AbortController(); req.once("aborted", () => controller.abort()); res.once("close", () => { if (!res.writableEnded) controller.abort(); });
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
          const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
          const runId = typeof retryKey === "string" ? retryKey : crypto.randomUUID(); event("run.started", { runId });
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref(); res.once("close", () => clearInterval(heartbeat));
          try {
            const result = await options.generation.generate(targetRecordId, value.message, controller.signal, runId, typeof value.revision === "string" ? value.revision : undefined);
            if (result.runId !== runId) throw new Error("RUN_ID_MISMATCH");
            event("run.completed", { runId, entries: result.entries, revision: result.revision });
          } catch (error) {
            const aborted = controller.signal.aborted || (error instanceof Error && error.message === "BRIDGE_ABORTED");
            const known = error instanceof Error && ["SESSION_BUSY", "REVISION_CONFLICT", "PANEL_SESSION_NOT_FOUND", "RUNTIME_NOT_CONFIGURED", "IDEMPOTENCY_KEY_REUSED", "SLASH_COMMANDS_UNSUPPORTED"].includes(error.message) ? error.message : error instanceof ContextBudgetExceededError ? error.code : "RUN_FAILED";
            if (!aborted && known === "RUN_FAILED") {
              const detail = error instanceof Error ? error.stack ?? error.message : String(error);
              process.stderr.write(`[ark-panel] generation failed requestId=${requestId} recordId=${targetRecordId}: ${detail}\n`);
            }
            const userMessages: Record<string, string> = { SESSION_BUSY: "该会话正在生成，请稍后重试。", REVISION_CONFLICT: "会话已在其他窗口更新，请刷新后重试。", PANEL_SESSION_NOT_FOUND: "只有面板自建会话可以在这里继续。", RUNTIME_NOT_CONFIGURED: "该 Agent 尚未配置专用推理 runtime。", IDEMPOTENCY_KEY_REUSED: "重试标识已用于其他消息，请重新发送。", RUN_FAILED: "生成失败，请稍后重试。" };
            event(aborted ? "run.aborted" : "run.failed", { runId, code: aborted ? "RUN_ABORTED" : known,
              ...(error instanceof ContextBudgetExceededError ? { message: error.message, estimate: error.estimate } : {}),
              ...(known === "SLASH_COMMANDS_UNSUPPORTED" ? { message: "首版面板暂不支持 OpenClaw 斜杠命令，请在原有 OpenClaw 渠道中执行。" } : userMessages[known] ? { message: userMessages[known] } : {}) });
          } finally {
            clearInterval(heartbeat);
          }
          res.end(); return;
        }
        return fail(res, 404, "NOT_FOUND", "接口不存在", requestId);
      }
      const pathname = url.pathname === "/" ? "index.html" : url.pathname.slice(1); const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, ""); const file = join(options.publicDir, safe);
      const types: Record<string,string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
      try { const [root, resolved] = await Promise.all([realpath(options.publicDir), realpath(file)]); const fromRoot = relative(root, resolved); if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) throw new Error("STATIC_PATH_ESCAPE"); const data = await readFile(resolved); res.writeHead(200, { "content-type": types[extname(resolved)] ?? "application/octet-stream", "cache-control": pathname === "index.html" ? "no-store" : "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(data); }
      catch { fail(res, 404, "NOT_FOUND", "页面不存在", requestId); }
    } catch (error) {
      const known: Record<string, [number, string]> = { AGENT_NOT_ALLOWED: [403, "Agent 不在允许列表中"], SESSION_NOT_FOUND: [404, "会话不存在"], PANEL_SESSION_NOT_FOUND: [404, "面板会话不存在"], EDIT_TARGET_NOT_USER: [409, "只能编辑用户消息"], PANEL_SESSION_CREATE_FAILED: [500, "面板会话创建失败"], COMMAND_NOT_ALLOWED: [403, "该命令未获面板允许"], COMMAND_ARGS_INVALID: [400, "命令参数无效"], MODEL_NOT_AVAILABLE: [400, "模型不可用"], THINKING_LEVEL_INVALID: [400, "思考等级无效"], THINKING_LEVEL_UNSUPPORTED: [409, "当前模型不支持该思考等级"], REASONING_LEVEL_INVALID: [400, "推理显示模式无效"] };
      const code = error instanceof ForkError ? error.code : error instanceof Error ? error.message : "INVALID_REQUEST"; const mapped = known[code];
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : error instanceof ForkError ? 409 : mapped?.[0] ?? 500;
      fail(res, status, error instanceof HttpError ? error.code : error instanceof ForkError ? error.code : mapped ? code : "INVALID_REQUEST", error instanceof ForkError ? error.message : mapped?.[1] ?? "请求无法处理", requestId);
    }
  });
}
