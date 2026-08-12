import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayControlError, loadGatewayStreamAuth, normalizeGatewayStreamEvent, OpenClawStreamObserver,
  resolveGatewayControlTransport, type GatewayControlMethod, type GatewayStreamEvent } from "../src/gateway/stream-client.js";
import { deferred, tempFixture, withTimeout } from "./test-helpers.js";

test("stream parser accepts full text snapshots and tool lifecycle while rejecting malformed or oversized payloads", () => {
  assert.deepEqual(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", seq: 2, state: "delta",
    message: { content: [{ type: "text", text: "你好" }] }, deltaText: "好" }),
    { type: "assistant_text", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 2, text: "你好", deltaText: "好", replace: false });
  assert.deepEqual(normalizeGatewayStreamEvent("session.tool", { runId: "run", sessionKey: "agent:a:s", seq: 3, stream: "tool",
    data: { phase: "start", toolCallId: "call", name: "exec", args: { command: "true" } } }),
    { type: "tool", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 3, callId: "call", name: "exec", phase: "started", args: { command: "true" } });
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", state: "delta", message: {} }), undefined);
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", state: "delta", message: { content: "x".repeat(2 * 1024 * 1024 + 1) } }), undefined);
});

test("disabling preview does not disable the server control credential", async () => {
  const env = {
    PANEL_OPENCLAW_STREAMING: "0",
    PANEL_OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-control-token"
  };
  assert.equal(await loadGatewayStreamAuth(env), undefined);
  assert.deepEqual(await loadGatewayStreamAuth(env, true), {
    url: "ws://127.0.0.1:18789",
    token: "fixture-control-token"
  });
});

test("server control auth requires an explicit non-blank secret and never accepts auth-none", async t => {
  const root = await tempFixture(t, "gateway-auth-contract-"), configPath = join(root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "none" } } }));
  const authNone = await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true);
  let sockets = 0;
  const connection = authNone ? new OpenClawStreamObserver({ ...authNone, webSocketFactory: () => { sockets++; throw new Error("must not create an admin socket"); } }) : undefined;
  assert.equal(authNone, undefined);
  await assert.rejects(resolveGatewayControlTransport(connection).request("status", {}), error =>
    error instanceof GatewayControlError && error.code === "GATEWAY_TRANSPORT_UNAVAILABLE");
  assert.equal(sockets, 0);

  await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token", password: "config-password" } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), {
    url: "ws://127.0.0.1:18789", token: "config-token", password: "config-password"
  });
  assert.equal(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: "  ", PANEL_OPENCLAW_GATEWAY_PASSWORD: "\t" }, true), undefined);
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19999", PANEL_OPENCLAW_GATEWAY_PASSWORD: "explicit-password" }, true), {
    url: "ws://127.0.0.1:19999", password: "explicit-password"
  });
});

test("missing server control credentials select a stable fail-closed transport", async () => {
  const transport = resolveGatewayControlTransport();
  await assert.rejects(transport.request("status", { privatePath: "/private/fixture", secret: "fixture-secret" }), error =>
    error instanceof GatewayControlError && error.code === "GATEWAY_TRANSPORT_UNAVAILABLE" &&
    error.message === "GATEWAY_TRANSPORT_UNAVAILABLE" && !error.message.includes("fixture"));
});

class FakeSocket {
  readyState = 1; sent: Record<string, unknown>[] = []; private listeners = new Map<string, Set<(event: never) => void>>();
  private sendFailure: "throw" | "callback" | "ready" | "deferred-callback" | undefined;
  private deferredSendCallback: ((error?: unknown) => void) | undefined;
  constructor(private readonly onRequest: (socket: FakeSocket, frame: Record<string, unknown>) => void) {}
  addEventListener(type: string, listener: (event: never) => void): void { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  send(data: string, callback?: (error?: unknown) => void): void {
    const frame = JSON.parse(data) as Record<string, unknown>; this.sent.push(frame);
    const failure = this.sendFailure; this.sendFailure = undefined;
    if (failure === "throw") throw new Error("fixture-private-send-error");
    if (failure === "callback") { queueMicrotask(() => callback?.(new Error("fixture-private-callback-error"))); return; }
    if (failure === "deferred-callback") { this.deferredSendCallback = callback; return; }
    if (failure === "ready") { this.readyState = 2; return; }
    this.onRequest(this, frame);
  }
  failNextSend(failure: "throw" | "callback" | "ready" | "deferred-callback"): void { this.sendFailure = failure; }
  releaseDeferredSendFailure(): void { const callback = this.deferredSendCallback; this.deferredSendCallback = undefined; callback?.(new Error("fixture-private-stale-send-error")); }
  close(code = 1000, reason = ""): void { this.readyState = 3; this.emit("close", { code, reason }); }
  open(): void { this.emit("open", {}); }
  error(): void { this.emit("error", {}); }
  message(frame: unknown): void { this.emit("message", { data: JSON.stringify(frame) }); }
  challenge(): void { this.message({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } }); }
  private emit(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event as never); }
}

test("observer ignores business events until the exact hello and subscriptions complete", async t => {
  const sockets: FakeSocket[] = [], events: GatewayStreamEvent[] = [];
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 300,
    webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { subscribed: true } })));
      sockets.push(socket); return socket;
    } });
  t.after(() => observer.stop());
  const observed = observer.observe("agent:a:pre-hello", event => events.push(event));
  sockets[0]!.message({ type: "event", event: "chat", payload: { runId: "stale-run", sessionKey: "agent:a:pre-hello",
    state: "delta", message: { content: "must-not-deliver" } } });
  sockets[0]!.message({ type: "event", event: "session.tool", payload: { runId: "stale-run", sessionKey: "agent:a:pre-hello",
    stream: "tool", data: { phase: "start", callId: "pre-hello", name: "exec" } } });
  assert.equal(events.some(event => event.type === "assistant_text" || event.type === "tool"), false);
  sockets[0]!.challenge();
  const unobserve = await withTimeout(observed, "exact hello after ignored pre-hello events");
  sockets[0]!.message({ type: "event", event: "chat", payload: { runId: "accepted-run", sessionKey: "agent:a:pre-hello",
    state: "delta", message: { content: "accepted" } } });
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "accepted"), true);
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "must-not-deliver"), false);
  unobserve(); observer.stop();
});

test("stale socket callbacks, challenge, hello, and data cannot mutate a replacement generation", async t => {
  const sockets: FakeSocket[] = [], reconnected = deferred();
  let staleConnectId: unknown;
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 300,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: () => {
      const index = sockets.length;
      const socket = new FakeSocket((current, frame) => {
        if (index === 0 && frame.method === "connect") { staleConnectId = frame.id; return; }
        queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
          payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
            auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } }));
      });
      sockets.push(socket); if (index === 1) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  const firstRequest = observer.request("status", {});
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(staleConnectId); sockets[0]!.error();
  await withTimeout(reconnected.promise, "replacement socket creation");
  assert.deepEqual(await firstRequest, { ok: true });
  const events: GatewayStreamEvent[] = [], unobserve = await observer.observe("agent:a:generation", event => events.push(event));
  const staleSentCount = sockets[0]!.sent.length;
  sockets[0]!.message({ type: "res", id: staleConnectId, ok: true, payload: { type: "hello-ok", server: { version: "2026.6.11" },
    auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } });
  sockets[0]!.message({ type: "event", event: "chat", payload: { runId: "stale-run", sessionKey: "agent:a:generation",
    state: "delta", message: { content: "stale" } } });
  sockets[0]!.message({ type: "event", event: "session.tool", payload: { runId: "stale-run", sessionKey: "agent:a:generation",
    stream: "tool", data: { phase: "start", callId: "stale", name: "exec" } } });
  sockets[0]!.challenge(); sockets[0]!.open(); sockets[0]!.error(); sockets[0]!.close(1008, "fixture-private-stale-close");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sockets[0]!.sent.length, staleSentCount);
  assert.equal(sockets.length, 2); assert.equal(sockets[1]!.readyState, 1);
  assert.equal(events.some(event => event.type === "assistant_text" || event.type === "tool"), false);
  sockets[1]!.message({ type: "event", event: "chat", payload: { runId: "fresh-run", sessionKey: "agent:a:generation",
    state: "delta", message: { content: "fresh" } } });
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "fresh"), true);
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  unobserve(); observer.stop();
});

test("send failures retire the owned socket and recover on one replacement generation", async t => {
  for (const failure of ["throw", "callback", "ready"] as const) {
    const sockets: FakeSocket[] = [], reconnected = deferred(), diagnostics: string[] = [];
    const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 300,
      reconnectMinMs: 1, reconnectMaxMs: 2, onDiagnostic: message => diagnostics.push(message), webSocketFactory: () => {
        const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
          payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
            auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } })));
        sockets.push(socket); if (sockets.length === 2) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
      } });
    t.after(() => observer.stop());
    assert.deepEqual(await observer.request("status", {}), { ok: true });
    sockets[0]!.failNextSend(failure);
    await assert.rejects(observer.request("status", {}), error => error instanceof GatewayControlError &&
      error.code === "GATEWAY_TRANSPORT_UNAVAILABLE" && !error.message.includes("fixture-private"));
    await withTimeout(reconnected.promise, `${failure} send failure replacement`);
    assert.equal(sockets[0]!.readyState, 3); assert.equal(sockets.length, 2);
    assert.deepEqual(await observer.request("status", {}), { ok: true });
    assert.equal(diagnostics.some(message => message.includes("fixture-private")), false);
    observer.stop();
  }
});

test("a stale send callback cannot invalidate the current generation", async t => {
  const sockets: FakeSocket[] = [], reconnected = deferred();
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 300,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } })));
      sockets.push(socket); if (sockets.length === 2) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  sockets[0]!.failNextSend("deferred-callback");
  const staleRequest = observer.request("status", {});
  await new Promise<void>(resolve => setImmediate(resolve));
  sockets[0]!.error();
  await assert.rejects(staleRequest, /GATEWAY_TRANSPORT_UNAVAILABLE/);
  await withTimeout(reconnected.promise, "replacement before stale send callback");
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  sockets[0]!.releaseDeferredSendFailure();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 2); assert.equal(sockets[1]!.readyState, 1);
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  observer.stop();
});

test("observer uses backend identity, routes sessions independently, and resubscribes after reconnect", async t => {
  const sockets: FakeSocket[] = [], methods: string[] = [];
  const reconnected = deferred(), resubscribed = deferred();
  const factory = () => {
    const socket = new FakeSocket((current, frame) => {
      const method = String(frame.method), id = String(frame.id); methods.push(method);
      if (method === "sessions.messages.subscribe" && methods.filter(value => value === method).length === 4) resubscribed.resolve();
      if (method === "sessions.send") {
        const params = frame.params as Record<string, unknown>;
        const allowed = new Set(["key", "agentId", "message", "thinking", "attachments", "timeoutMs", "idempotencyKey"]);
        const unexpected = Object.keys(params).filter(key => !allowed.has(key));
        if (unexpected.length) {
          queueMicrotask(() => current.message({ type: "res", id, ok: false,
            error: { message: `invalid sessions.send params: unexpected property '${unexpected[0]}'` } }));
          return;
        }
      }
      const payload = method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
        auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } :
        method === "sessions.send" ? { runId: "attachment-run" } : { subscribed: true };
      queueMicrotask(() => current.message({ type: "res", id, ok: true, payload }));
    });
    sockets.push(socket); if (sockets.length === 2) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 500,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  t.after(() => observer.stop());
  const first: GatewayStreamEvent[] = [], second: GatewayStreamEvent[] = [];
  const unobserveFirst = await observer.observe("agent:a:first", event => first.push(event));
  const unobserveSecond = await observer.observe("agent:a:second", event => second.push(event));
  const connect = sockets[0]!.sent.find(frame => frame.method === "connect")!.params as { client: { id: string; mode: string }; role: string; scopes: string[] };
  assert.equal(connect.client.id, "gateway-client"); assert.equal(connect.client.mode, "backend");
  assert.equal(connect.role, "operator");
  assert.deepEqual(connect.scopes, ["operator.read", "operator.write", "operator.admin"]);
  assert.deepEqual(await observer.send("agent:a:first", "附件", "11111111-1111-4111-8111-111111111111",
    [{ fileName: "input.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: "UEs=" }]), { runId: "attachment-run" });
  const sent = sockets[0]!.sent.find(frame => frame.method === "sessions.send")!.params as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["agentId", "attachments", "idempotencyKey", "key", "message"]);
  assert.equal((sent.attachments as unknown[]).length, 1);
  sockets[0]!.message({ type: "event", event: "chat", payload: { runId: "r1", sessionKey: "agent:a:first", seq: 1, state: "delta", message: { content: "one" } } });
  assert.equal(first.some(event => event.type === "assistant_text" && event.text === "one"), true);
  assert.equal(second.some(event => event.type === "assistant_text"), false);
  sockets[0]!.close(1006, "dropped");
  await withTimeout(Promise.all([reconnected.promise, resubscribed.promise]), "observer reconnect and resubscription");
  assert.equal(sockets.length, 2); assert.equal(methods.filter(value => value === "sessions.subscribe").length, 2);
  assert.equal(methods.filter(value => value === "sessions.messages.subscribe").length, 4);
  assert.equal(first.some(event => event.type === "connection" && event.state === "disconnected"), true);
  unobserveFirst(); unobserveSecond(); observer.stop();
});

test("observer replaces a socket that emits error without close", async t => {
  const sockets: FakeSocket[] = [];
  const reconnected = deferred();
  const factory = () => {
    const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
      payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
        auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { subscribed: true } })));
    sockets.push(socket); if (sockets.length === 2) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", requestTimeoutMs: 100,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  t.after(() => observer.stop());
  await observer.request("sessions.list", {});
  sockets[0]!.error();
  await withTimeout(reconnected.promise, "observer reconnect after socket error");
  assert.equal(sockets.length, 2);
  assert.deepEqual(await observer.request("sessions.list", {}), { subscribed: true });
  observer.stop();
});

test("observer replaces a socket after an RPC timeout", async t => {
  const sockets: FakeSocket[] = [];
  const reconnected = deferred();
  const factory = () => {
    const socketIndex = sockets.length;
    const socket = new FakeSocket((current, frame) => {
      if (frame.method === "sessions.create" && socketIndex === 0) return;
      queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { key: "agent:a:new" } }));
    });
    sockets.push(socket); if (sockets.length === 2) reconnected.resolve(); queueMicrotask(() => socket.challenge()); return socket;
  };
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", requestTimeoutMs: 20,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: factory });
  t.after(() => observer.stop());
  await withTimeout(assert.rejects(observer.request("sessions.create", {}), /GATEWAY_REQUEST_TIMEOUT: sessions\.create/), "intentional RPC timeout");
  await withTimeout(reconnected.promise, "observer reconnect after RPC timeout");
  assert.equal(sockets.length, 2);
  assert.deepEqual(await observer.request("sessions.create", {}), { key: "agent:a:new" });
  observer.stop();
});

test("observer honors a longer per-request timeout for model-backed RPCs", async t => {
  const sockets: FakeSocket[] = [];
  const responseTimers = new Set<NodeJS.Timeout>();
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", requestTimeoutMs: 10,
    webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => {
        // This timer is the subject of the test: compact must outlive the default request timeout.
        const delay = frame.method === "sessions.compact" ? 30 : 0;
        const timer = setTimeout(() => {
          responseTimers.delete(timer);
          current.message({ type: "res", id: frame.id, ok: true,
            payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
              auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } });
        }, delay);
        responseTimers.add(timer);
      });
      sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => { observer.stop(); for (const timer of responseTimers) clearTimeout(timer); });
  assert.deepEqual(await observer.request("sessions.compact", {}, 60), { ok: true });
  observer.stop();
});

test("observer rejects every non-exact role and scope grant before enabling control RPCs", async t => {
  const invalidAuth = [
    { label: "missing", auth: { role: "operator", scopes: ["operator.read", "operator.write"] } },
    { label: "extra", auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin", "operator.pairing"] } },
    { label: "unknown", auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin", "operator.future"] } },
    { label: "duplicate", auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin", "operator.admin"] } },
    { label: "role", auth: { role: "node", scopes: ["operator.read", "operator.write", "operator.admin"] } }
  ] as const;
  for (const fixture of invalidAuth) {
    const diagnostics: string[] = [], sockets: FakeSocket[] = [];
    const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
      reconnectMinMs: 60_000, reconnectMaxMs: 60_000, onDiagnostic: message => diagnostics.push(message),
      webSocketFactory: () => {
        const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
          payload: { type: "hello-ok", server: { version: "2026.6.11" }, auth: fixture.auth } })));
        sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
      } });
    t.after(() => observer.stop());
    await withTimeout(assert.rejects(observer.request("status", {}), /GATEWAY_SCOPE_CONTRACT_VIOLATION/), `invalid ${fixture.label} grant`);
    assert.deepEqual(sockets[0]!.sent.map(frame => frame.method), ["connect"]);
    assert.equal(sockets[0]!.readyState, 3);
    assert.equal(diagnostics.some(message => message.includes("GATEWAY_SCOPE_CONTRACT_VIOLATION")), true);
    observer.stop();
  }
});

test("observer rejects a different pinned Gateway version before any business RPC", async t => {
  const sockets: FakeSocket[] = [];
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    reconnectMinMs: 60_000, reconnectMaxMs: 60_000, webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: { type: "hello-ok", server: { version: "2026.6.12" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } })));
      sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  await assert.rejects(observer.request("status", {}), error => error instanceof GatewayControlError &&
    error.code === "OPENCLAW_VERSION_UNSUPPORTED" && error.message === "OPENCLAW_VERSION_UNSUPPORTED");
  assert.deepEqual(sockets[0]!.sent.map(frame => frame.method), ["connect"]);
  observer.stop();
});

test("observer normalizes denied handshakes and upstream RPC errors without exposing payloads", async t => {
  const secret = "fixture-token-and-private-message-/private/example";
  const deniedDiagnostics: string[] = [];
  const denied = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    reconnectMinMs: 60_000, reconnectMaxMs: 60_000, onDiagnostic: message => deniedDiagnostics.push(message),
    webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: false,
        error: { code: "INVALID_REQUEST", message: `missing scope ${secret}`, details: { raw: secret } } })));
      queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => denied.stop());
  await assert.rejects(denied.request("status", {}), error => error instanceof GatewayControlError &&
    error.code === "GATEWAY_HANDSHAKE_DENIED" && error.message === "GATEWAY_HANDSHAKE_DENIED" && !error.message.includes(secret));
  assert.equal(deniedDiagnostics.some(message => message.includes(secret)), false);
  denied.stop();

  const rpcDiagnostics: string[] = [];
  const rpc = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    onDiagnostic: message => rpcDiagnostics.push(message), webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message(frame.method === "status" ?
        { type: "res", id: frame.id, ok: false, error: { message: secret, payload: { secret } } } :
        { type: "res", id: frame.id, ok: true, payload: frame.method === "connect" ? { type: "hello-ok",
          server: { version: "2026.6.11" }, auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } })));
      queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => rpc.stop());
  await assert.rejects(rpc.request("status", {}), error => error instanceof GatewayControlError &&
    error.code === "GATEWAY_REQUEST_DENIED" && error.message === "GATEWAY_REQUEST_DENIED" && !error.message.includes(secret));
  assert.equal(rpcDiagnostics.some(message => message.includes(secret)), false);
  rpc.stop();

  const closedDiagnostics: string[] = [];
  const closed = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    reconnectMinMs: 60_000, reconnectMaxMs: 60_000, onDiagnostic: message => closedDiagnostics.push(message), webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => frame.method === "status" ? current.close(1008, secret) :
        current.message({ type: "res", id: frame.id, ok: true, payload: frame.method === "connect" ? { type: "hello-ok",
          server: { version: "2026.6.11" }, auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { ok: true } })));
      queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => closed.stop());
  await assert.rejects(closed.request("status", {}), error => error instanceof GatewayControlError &&
    error.code === "GATEWAY_CONNECTION_CLOSED" && error.message === "GATEWAY_CONNECTION_CLOSED" && !error.message.includes(secret));
  assert.equal(closedDiagnostics.some(message => message.includes(secret)), false);
  closed.stop();
});

test("observer enforces the reviewed read, write, and admin RPC map and sends nothing else", async t => {
  const sockets: FakeSocket[] = [];
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"] } } : { ok: true } })));
      sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  await assert.rejects(observer.request("config.set" as GatewayControlMethod, { secret: "must-not-send" }), /GATEWAY_RPC_METHOD_NOT_ALLOWED/);
  assert.equal(sockets.length, 0);
  const reviewedByScope = {
    "operator.read": ["artifacts.download", "artifacts.list", "commands.list", "sessions.list", "sessions.messages.subscribe",
      "sessions.messages.unsubscribe", "sessions.subscribe", "status", "tools.catalog", "tools.effective"],
    "operator.write": ["sessions.abort", "sessions.create", "sessions.send"],
    "operator.admin": ["sessions.compact", "sessions.delete", "sessions.patch"]
  } as const;
  await observer.request("status", {});
  const internal = observer as unknown as { grantedScopes: ReadonlySet<string> };
  for (const [scope, methods] of Object.entries(reviewedByScope)) {
    internal.grantedScopes = new Set([scope]);
    for (const method of methods) await observer.request(method, {});
    const rejected = scope === "operator.read" ? "sessions.send" : scope === "operator.write" ? "sessions.delete" : "status";
    const sentBefore = sockets[0]!.sent.length;
    await assert.rejects(observer.request(rejected, {}), /GATEWAY_SCOPE_CONTRACT_VIOLATION/);
    assert.equal(sockets[0]!.sent.length, sentBefore);
  }
  const reviewed = Object.values(reviewedByScope).flat();
  assert.deepEqual([...new Set(sockets[0]!.sent.map(frame => String(frame.method)).filter(method => method !== "connect"))].sort(), reviewed.sort());
  assert.equal(sockets[0]!.sent.some(frame => frame.method === "config.set"), false);
  observer.stop();
});

test("observer discards the previous grant and fails closed when a reconnect hello is narrower", async t => {
  const sockets: FakeSocket[] = [], secondHandshake = deferred();
  const observer = new OpenClawStreamObserver({ url: "ws://fixture", token: "fixture", requestTimeoutMs: 200,
    reconnectMinMs: 1, reconnectMaxMs: 2, webSocketFactory: () => {
      const index = sockets.length;
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => {
        current.message({ type: "res", id: frame.id, ok: true, payload: frame.method === "connect" ? { type: "hello-ok",
          server: { version: "2026.6.11" }, auth: { role: "operator", scopes: index === 0 ?
            ["operator.read", "operator.write", "operator.admin"] : ["operator.read", "operator.write"] } } : { ok: true } });
        if (index === 1 && frame.method === "connect") queueMicrotask(() => secondHandshake.resolve());
      }));
      sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  sockets[0]!.close(1006, "fixture reconnect");
  await withTimeout(secondHandshake.promise, "narrow reconnect handshake");
  await assert.rejects(observer.request("status", {}), /GATEWAY_SCOPE_CONTRACT_VIOLATION/);
  assert.deepEqual(sockets[1]!.sent.map(frame => frame.method), ["connect"]);
  observer.stop();
});
