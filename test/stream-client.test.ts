import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayControlError, loadGatewayStreamAuth, normalizeGatewayStreamEvent, OpenClawStreamObserver,
  resolveGatewayControlTransport, type GatewayControlMethod, type GatewayStreamEvent } from "../src/gateway/stream-client.js";
import { createToolSchemaCollector } from "../src/gateway/stream-schema-observation.js";
import { deferred, tempFixture, withTimeout } from "./test-helpers.js";

test("stream parser accepts full text snapshots and tool lifecycle while rejecting malformed or oversized payloads", () => {
  assert.deepEqual(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", seq: 2, state: "delta",
    message: { content: [{ type: "text", text: "你好" }] }, deltaText: "好" }),
    { type: "assistant_text", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 2, text: "你好", deltaText: "好", replace: false });
  assert.deepEqual(normalizeGatewayStreamEvent("session.tool", { runId: "run", sessionKey: "agent:a:s", seq: 3, stream: "tool",
    data: { phase: "start", toolCallId: "call", name: "exec", args: { command: "true" } } }),
    { type: "tool", runId: "run", sessionKey: "agent:a:s", upstreamSeq: 3, callId: "call", name: "exec", phase: "started", args: { command: "true" } });
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", state: "delta", message: {} }), undefined);
  for (const seq of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(normalizeGatewayStreamEvent("chat", {
    runId: "run", sessionKey: "agent:a:s", ...(seq === undefined ? {} : { seq }), state: "delta", message: { content: "safe" }, deltaText: "safe"
  }), undefined);
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", seq: 4, state: "delta", message: { content: "x".repeat(2 * 1024 * 1024 + 1) } }), undefined);
  assert.equal(normalizeGatewayStreamEvent("chat", { runId: "run", sessionKey: "agent:a:s", seq: 4, state: "delta",
    message: { content: "safe" }, deltaText: "x".repeat(2 * 1024 * 1024 + 1) }), undefined);
});

test("disabling preview does not disable the server control credential", async t => {
  const root = await tempFixture(t, "gateway-preview-contract-"), configPath = join(root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "fixture-config-token" } } }));
  const env = {
    OPENCLAW_CONFIG_PATH: configPath,
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

async function assertUnavailableGatewayAuth(auth: Awaited<ReturnType<typeof loadGatewayStreamAuth>>): Promise<void> {
  let sockets = 0;
  const connection = auth ? new OpenClawStreamObserver({ ...auth,
    webSocketFactory: () => { sockets++; throw new Error("must not create an admin socket"); } }) : undefined;
  assert.equal(auth, undefined);
  await assert.rejects(resolveGatewayControlTransport(connection).request("status", {}), error =>
    error instanceof GatewayControlError && error.code === "GATEWAY_TRANSPORT_UNAVAILABLE" &&
    error.message === "GATEWAY_TRANSPORT_UNAVAILABLE" && !error.message.includes("fixture"));
  assert.equal(sockets, 0);
}

test("server control auth follows the pinned local mode resolver and never accepts auth-none", async t => {
  const root = await tempFixture(t, "gateway-auth-contract-"), configPath = join(root, "openclaw.json");
  const rejectedNoneConfigs = [
    { mode: "none" },
    { mode: "none", token: "fixture-stale-token" },
    { mode: "none", password: "fixture-stale-password" },
    { mode: "none", token: "fixture-stale-token", password: "fixture-stale-password" }
  ];
  for (const authConfig of rejectedNoneConfigs) {
    await writeFile(configPath, JSON.stringify({ gateway: { auth: authConfig } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }

  const configCases = [
    { auth: { mode: "token", token: " config-token ", password: "stale-password" }, expected: { token: "config-token" } },
    { auth: { mode: "password", token: "stale-token", password: " config-password " }, expected: { password: "config-password" } },
    { auth: { mode: "trusted-proxy", password: " proxy-password ", trustedProxy: { userHeader: "x-auth-user" } },
      gateway: { trustedProxies: ["127.0.0.1"] }, expected: { password: "proxy-password" } },
    { auth: { token: " inferred-token " }, expected: { token: "inferred-token" } },
    { auth: { password: " inferred-password " }, expected: { password: "inferred-password" } },
    { auth: { token: "ambiguous-token", password: "ambiguous-password" }, expected: undefined },
    { auth: { mode: "token", password: "wrong-mode-password" }, expected: undefined },
    { auth: { mode: "password", token: "wrong-mode-token" }, expected: undefined },
    { auth: { mode: "unknown", token: "unknown-mode-token" }, expected: undefined }
  ];
  for (const configCase of configCases) {
    await writeFile(configPath, JSON.stringify({ gateway: { ...configCase.gateway, auth: configCase.auth } }));
    const expected = configCase.expected ? { url: "ws://127.0.0.1:18789", ...configCase.expected } : undefined;
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), expected);
  }
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "unknown", auth: { mode: "token", token: "fixture-token" } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));

  await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token: "must-not-fallback" } } }));
  for (const blankOverride of [
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "  " },
    { PANEL_OPENCLAW_GATEWAY_PASSWORD: "\t" },
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "  ", PANEL_OPENCLAW_GATEWAY_PASSWORD: "\t" }
  ]) assert.equal(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, ...blankOverride }, true), undefined);
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: " explicit-local-token " }, true), {
    url: "ws://127.0.0.1:18789", token: "explicit-local-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: " explicit-local-token ", PANEL_OPENCLAW_GATEWAY_PASSWORD: "ignored-password" }, true), {
    url: "ws://127.0.0.1:18789", token: "explicit-local-token"
  });
  assert.equal(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: "wrong-mode-password" }, true), undefined);
  assert.equal(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid" }, true), undefined);

  for (const localOverrideCase of [
    { auth: { mode: "password", password: "old-password" }, expected: { password: "new-password" } },
    { auth: { password: "old-password" }, expected: { password: "new-password" } }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway: { auth: localOverrideCase.auth } }));
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
      PANEL_OPENCLAW_GATEWAY_TOKEN: "ignored-token", PANEL_OPENCLAW_GATEWAY_PASSWORD: " new-password " }, true), {
      url: "ws://127.0.0.1:18789", ...localOverrideCase.expected
    });
  }
  await writeFile(configPath, JSON.stringify({ gateway: { trustedProxies: ["127.0.0.1"], auth: {
    mode: "trusted-proxy", password: "old-password", trustedProxy: { userHeader: "x-auth-user" }
  } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: " new-password " }, true), {
    url: "ws://127.0.0.1:18789", password: "new-password"
  });
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: "ambiguous-token", password: "ambiguous-password" } } }));
  assert.equal(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: "cannot-resolve-ambiguity" }, true), undefined);

  await writeFile(configPath, JSON.stringify({ gateway: { auth: {
    mode: "none", token: "fixture-stale-token", password: "fixture-stale-password"
  } } }));
  for (const sameEndpointOverride of [
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" },
    { PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-env-password" },
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token", PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-env-password" },
    { PANEL_OPENCLAW_GATEWAY_URL: "ws://localhost:18789/alternate", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" },
    { PANEL_OPENCLAW_GATEWAY_URL: "ws://127.0.0.2:18789", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" },
    { PANEL_OPENCLAW_GATEWAY_URL: "ws://[::1]:18789", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" },
    { PANEL_OPENCLAW_GATEWAY_URL: "ws://[::ffff:127.0.0.1]:18789", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" }
  ]) await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, ...sameEndpointOverride }, true));

  await writeFile(configPath, JSON.stringify({ gateway: { port: 19998, auth: {
    mode: "none", token: "fixture-stale-token"
  } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "ws://localhost:19998/path", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19999", PANEL_OPENCLAW_GATEWAY_TOKEN: " explicit-token " }, true), {
    url: "ws://127.0.0.1:19999", token: "explicit-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:20000", PANEL_OPENCLAW_GATEWAY_PASSWORD: " explicit-password " }, true), {
    url: "ws://127.0.0.1:20000", password: "explicit-password"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid", PANEL_OPENCLAW_GATEWAY_TOKEN: "explicit-token",
    PANEL_OPENCLAW_GATEWAY_PASSWORD: "explicit-password" }, true), {
    url: "wss://independent.fixture.invalid", token: "explicit-token", password: "explicit-password"
  });

  await writeFile(configPath, "{not-json");
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-env-token" }, true));
});

test("Gateway resolver validates config location and local port before selecting credentials", async t => {
  const root = await tempFixture(t, "gateway-resolver-contract-");
  const configPath = join(root, "openclaw.json"), otherConfigPath = join(root, "other-openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { port: 19_001, auth: { mode: "token", token: "fixture-config-token" } } }));
  await writeFile(otherConfigPath, JSON.stringify({ gateway: { port: 19_002, auth: { mode: "token", token: "fixture-other-token" } } }));

  for (const [value, port] of [["19991", 19_991], ["localhost:19992", 19_992], ["[::1]:19993", 19_993]] as const) {
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_PORT: value }, true), {
      url: `ws://127.0.0.1:${port}`, token: "fixture-config-token"
    });
  }
  for (const value of ["", " ", "0", "65536", "1.5", "localhost", ":19991", "a:b:19991"]) {
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_PORT: value
    }, true));
  }
  assert.deepEqual(await loadGatewayStreamAuth({
    PANEL_OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_CONFIG_PATH: otherConfigPath
  }, true), { url: "ws://127.0.0.1:19001", token: "fixture-config-token" });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG: configPath }, true), {
    url: "ws://127.0.0.1:19001", token: "fixture-config-token"
  });

  const stateRoot = join(root, "state"), openClawHome = join(root, "openclaw-home");
  const osHome = join(root, "os-home");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(join(openClawHome, ".openclaw"), { recursive: true });
  await mkdir(join(osHome, ".openclaw"), { recursive: true });
  await writeFile(join(stateRoot, "openclaw.json"), JSON.stringify({ gateway: {
    auth: { mode: "token", token: "fixture-state-token" }
  } }));
  await writeFile(join(openClawHome, ".openclaw", "openclaw.json"), JSON.stringify({ gateway: {
    auth: { mode: "token", token: "fixture-openclaw-home-token" }
  } }));
  await writeFile(join(osHome, ".openclaw", "openclaw.json"), JSON.stringify({ gateway: {
    auth: { mode: "token", token: "fixture-os-home-token" }
  } }));
  assert.deepEqual(await loadGatewayStreamAuth({ HOME: osHome, OPENCLAW_HOME: openClawHome,
    OPENCLAW_STATE_DIR: stateRoot }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-state-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ HOME: osHome, OPENCLAW_HOME: openClawHome }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-openclaw-home-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ HOME: osHome }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-os-home-token"
  });
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ HOME: osHome, OPENCLAW_PROFILE: "dev" }, true));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ HOME: osHome, OPENCLAW_HOME: openClawHome,
    OPENCLAW_PROFILE: "fixture" }, true));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_PROFILE: "fixture" }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ PANEL_OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CONFIG_PATH: otherConfigPath, OPENCLAW_PROFILE: "fixture" }, true), {
    url: "ws://127.0.0.1:19001", token: "fixture-config-token"
  });

  const legacyStateRoot = join(root, "legacy-state"), legacyHome = join(root, "legacy-home");
  await mkdir(legacyStateRoot, { recursive: true });
  await mkdir(join(legacyHome, ".openclaw"), { recursive: true });
  await writeFile(join(legacyStateRoot, "clawdbot.json"), JSON.stringify({ gateway: {
    auth: { mode: "token", token: "fixture-legacy-state-token" }
  } }));
  await writeFile(join(legacyHome, ".openclaw", "clawdbot.json"), JSON.stringify({ gateway: {
    auth: { mode: "token", token: "fixture-legacy-home-token" }
  } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_STATE_DIR: legacyStateRoot }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-legacy-state-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_HOME: legacyHome }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-legacy-home-token"
  });

  for (const explicitPath of ["", " ", join(root, "missing.json")]) await assertUnavailableGatewayAuth(
    await loadGatewayStreamAuth({ PANEL_OPENCLAW_CONFIG_PATH: explicitPath, OPENCLAW_CONFIG_PATH: configPath }, true));
  const unreadablePath = join(root, "unreadable.json");
  await writeFile(unreadablePath, JSON.stringify({ gateway: { auth: { mode: "token", token: "fixture-must-not-send" } } }));
  await chmod(unreadablePath, 0);
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: unreadablePath }, true));
  await writeFile(otherConfigPath, "{ gateway: { auth: { mode: 'token' } } }");
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: otherConfigPath }, true));
  for (const unsupportedResolution of [
    { $include: "./base.json", gateway: { auth: { mode: "token", token: "fixture-must-not-send" } } },
    { gateway: { port: "${FIXTURE_GATEWAY_PORT}", auth: { mode: "token", token: "fixture-must-not-send" } } }
  ]) {
    await writeFile(otherConfigPath, JSON.stringify(unsupportedResolution));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: otherConfigPath,
      FIXTURE_GATEWAY_PORT: "19003" }, true));
  }
  await writeFile(otherConfigPath, JSON.stringify({ fixtureLiteral: "$${FIXTURE_GATEWAY_PORT}", gateway: {
    auth: { mode: "token", token: "fixture-literal-token" }
  } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: otherConfigPath }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-literal-token"
  });
});

test("remote control auth requires its configured URL or a self-contained explicit endpoint", async t => {
  const root = await tempFixture(t, "gateway-remote-auth-contract-"), configPath = join(root, "openclaw.json");
  const credentials = [{ token: "fixture-remote-token" }, { password: "fixture-remote-password" },
    { token: "fixture-remote-token", password: "fixture-remote-password" }];
  for (const url of [undefined, "", "  "]) for (const credential of credentials) {
    const remote = { ...(url === undefined ? {} : { url }), ...credential };
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote } }));
    for (const override of [{}, { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" },
      { PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-panel-password" },
      { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token", PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-panel-password" }]) {
      await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, ...override }, true));
    }
  }

  await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: { token: "fixture-must-not-leak" } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid" }, true));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "ws://public.fixture.invalid", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid", PANEL_OPENCLAW_GATEWAY_TOKEN: " fixture-panel-token " }, true), {
    url: "wss://independent.fixture.invalid", token: "fixture-panel-token"
  });

  for (const remoteCase of [
    { credentials: { token: " remote-token " }, expected: { token: "remote-token" } },
    { credentials: { password: " remote-password " }, expected: { password: "remote-password" } },
    { credentials: { token: " remote-token ", password: " remote-password " },
      expected: { token: "remote-token", password: "remote-password" } }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", auth: {
      mode: "none", token: "local-stale-token", password: "local-stale-password"
    }, remote: { url: "wss://gateway.fixture.invalid", transport: "direct", ...remoteCase.credentials } } }));
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), {
      url: "wss://gateway.fixture.invalid", ...remoteCase.expected
    });
  }
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: " explicit-remote-token " }, true), {
    url: "wss://gateway.fixture.invalid", token: "explicit-remote-token"
  });

  for (const unsupportedRemote of [
    { url: "wss://gateway.fixture.invalid", token: "fixture-must-not-send" },
    { url: "wss://gateway.fixture.invalid", transport: "ssh", token: "fixture-must-not-send" },
    { url: "wss://gateway.fixture.invalid", transport: "invalid", token: "fixture-must-not-send" },
    { url: "wss://gateway.fixture.invalid", transport: "direct", tlsFingerprint: "sha256:fixture-pin", token: "fixture-must-not-send" }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: unsupportedRemote } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
      PANEL_OPENCLAW_GATEWAY_URL: "wss://gateway.fixture.invalid/path",
      PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" }, true));
  }
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://independent.fixture.invalid", PANEL_OPENCLAW_GATEWAY_TOKEN: " fixture-panel-token " }, true), {
    url: "wss://independent.fixture.invalid", token: "fixture-panel-token"
  });

  await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: {
    url: "wss://gateway.fixture.invalid", transport: "direct", token: "fixture-remote-token"
  } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://gateway.fixture.invalid" }, true));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://other-gateway.fixture.invalid" }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://gateway.fixture.invalid/path",
    PANEL_OPENCLAW_GATEWAY_TOKEN: " explicit-token " }, true), {
    url: "wss://gateway.fixture.invalid/path", token: "explicit-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://other-gateway.fixture.invalid", PANEL_OPENCLAW_GATEWAY_PASSWORD: " explicit-password " }, true), {
    url: "wss://other-gateway.fixture.invalid", password: "explicit-password"
  });
});

test("gateway endpoint provenance follows local TLS and rejects public plaintext WebSockets", async t => {
  const root = await tempFixture(t, "gateway-endpoint-contract-"), configPath = join(root, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ gateway: { tls: { enabled: true }, auth: { mode: "token", token: "fixture-token" } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), {
    url: "wss://127.0.0.1:18789", token: "fixture-token"
  });
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://localhost:18789/path" }, true), {
    url: "wss://localhost:18789/path", token: "fixture-token"
  });
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://loopback:18789" }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_URL: "wss://loopback:18789", PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-independent-token" }, true), {
    url: "wss://loopback:18789", token: "fixture-independent-token"
  });
  await writeFile(configPath, JSON.stringify({ gateway: { tls: { enabled: "true" }, auth: { mode: "token", token: "fixture-token" } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  for (const port of ["18789", 0, -1, 18_789.5, 65_536]) {
    await writeFile(configPath, JSON.stringify({ gateway: { port, auth: { mode: "token", token: "fixture-token" } } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }

  for (const url of ["ws://localhost:18789", "ws://127.0.0.2:18789", "ws://10.2.3.4:18789",
    "ws://100.64.1.2:18789", "ws://169.254.1.2:18789", "ws://172.16.1.2:18789", "ws://192.168.1.2:18789",
    "ws://[fd00::1]:18789", "ws://[fe80::1]:18789", "ws://gateway.local:18789", "ws://node.fixture.ts.net:18789"]) {
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: { url, transport: "direct", token: "fixture-remote-token" } } }));
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), { url, token: "fixture-remote-token" });
  }
  for (const url of ["ws://loopback:18789", "ws://public.fixture.invalid:18789", "ws://8.8.8.8:18789",
    "ws://[2001:4860:4860::8888]:18789"]) {
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: { url, transport: "direct", token: "fixture-must-not-send" } } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote",
    remote: { url: "wss://public.fixture.invalid", transport: "direct", token: "fixture-remote-token" } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true), {
    url: "wss://public.fixture.invalid", token: "fixture-remote-token"
  });

  let unsafeSocketCount = 0;
  const unsafeObserver = new OpenClawStreamObserver({ url: "ws://public.fixture.invalid", token: "fixture-must-not-send",
    webSocketFactory: () => { unsafeSocketCount++; throw new Error("unsafe transport must not reach the socket factory"); } });
  await assert.rejects(unsafeObserver.request("status", {}), error =>
    error instanceof GatewayControlError && error.code === "GATEWAY_TRANSPORT_UNAVAILABLE" && !error.message.includes("fixture"));
  assert.equal(unsafeSocketCount, 0);
  unsafeObserver.stop();
});

test("Gateway SecretRef presence participates in mode and trusted-proxy fail-closed rules", async t => {
  const root = await tempFixture(t, "gateway-secretref-contract-"), configPath = join(root, "openclaw.json");
  const tokenRef = { source: "env", provider: "default", id: "FIXTURE_GATEWAY_TOKEN" };
  const passwordRef = { source: "file", provider: "default", id: "/gateway/password" };
  for (const auth of [{ mode: "token", token: tokenRef }, { mode: "password", password: passwordRef },
    { token: tokenRef, password: "fixture-password" }, { token: "fixture-token", password: passwordRef },
    { token: tokenRef, password: passwordRef }, { mode: "token", token: "${FIXTURE_GATEWAY_TOKEN}" },
    { mode: "token", token: { source: "invalid", id: "fixture" }, password: "fixture-password" }]) {
    await writeFile(configPath, JSON.stringify({ gateway: { auth } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }
  for (const token of [
    { source: "env", id: "FIXTURE_GATEWAY_TOKEN" },
    { source: "env", provider: "Invalid Provider", id: "FIXTURE_GATEWAY_TOKEN" },
    { source: "env", provider: "default", id: "lowercase" },
    { source: "file", provider: "default", id: "relative/path" },
    { source: "exec", provider: "default", id: "../fixture" },
    { source: "env", provider: "default", id: "FIXTURE_GATEWAY_TOKEN", extra: true }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "token", token } } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
      PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" }, true));
  }

  await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: tokenRef } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: " fixture-panel-token " }, true), {
    url: "ws://127.0.0.1:18789", token: "fixture-panel-token"
  });
  await writeFile(configPath, JSON.stringify({ gateway: { auth: { mode: "password", password: passwordRef } } }));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: " fixture-panel-password " }, true), {
    url: "ws://127.0.0.1:18789", password: "fixture-panel-password"
  });

  for (const remoteCase of [
    { credentials: { token: tokenRef }, override: { PANEL_OPENCLAW_GATEWAY_TOKEN: " fixture-panel-token " },
      expected: { token: "fixture-panel-token" } },
    { credentials: { password: passwordRef }, override: { PANEL_OPENCLAW_GATEWAY_PASSWORD: " fixture-panel-password " },
      expected: { password: "fixture-panel-password" } }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote",
      remote: { url: "wss://gateway.fixture.invalid", transport: "direct", ...remoteCase.credentials } } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
    assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, ...remoteCase.override }, true), {
      url: "wss://gateway.fixture.invalid", ...remoteCase.expected
    });
  }
  await writeFile(configPath, JSON.stringify({ gateway: { mode: "remote", remote: {
    url: "wss://gateway.fixture.invalid", transport: "direct", token: { source: "invalid", id: "fixture" }
  } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" }, true));

  const trustedProxyGateway = { trustedProxies: ["127.0.0.1"], auth: {
    mode: "trusted-proxy", password: "fixture-local-password", trustedProxy: { userHeader: "x-auth-user" }
  } };
  for (const token of ["fixture-mutually-exclusive-token", tokenRef]) {
    await writeFile(configPath, JSON.stringify({ gateway: { ...trustedProxyGateway, auth: {
      ...trustedProxyGateway.auth, token
    } } }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }
  for (const gateway of [
    { trustedProxies: ["127.0.0.1"], auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-auth-user" } } },
    { auth: { mode: "trusted-proxy", password: "fixture-local-password" } },
    { trustedProxies: ["127.0.0.1"], auth: { mode: "trusted-proxy", password: "fixture-local-password" } },
    { trustedProxies: [], auth: { mode: "trusted-proxy", password: "fixture-local-password",
      trustedProxy: { userHeader: "x-auth-user" } } },
    { trustedProxies: [" "], auth: { mode: "trusted-proxy", password: "fixture-local-password",
      trustedProxy: { userHeader: "x-auth-user" } } },
    { trustedProxies: ["127.0.0.1"], auth: { mode: "trusted-proxy", password: "fixture-local-password",
      trustedProxy: { userHeader: " " } } }
  ]) {
    await writeFile(configPath, JSON.stringify({ gateway }));
    await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  }
  await writeFile(configPath, JSON.stringify({ gateway: trustedProxyGateway }));
  for (const panelCredentials of [
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token" },
    { PANEL_OPENCLAW_GATEWAY_TOKEN: "fixture-panel-token", PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-panel-password" },
    { PANEL_OPENCLAW_GATEWAY_TOKEN: " ", PANEL_OPENCLAW_GATEWAY_PASSWORD: "fixture-panel-password" },
    { OPENCLAW_GATEWAY_TOKEN: "fixture-upstream-token" }
  ]) await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath, ...panelCredentials }, true));
  await writeFile(configPath, JSON.stringify({ gateway: { ...trustedProxyGateway, auth: {
    ...trustedProxyGateway.auth, password: passwordRef
  } } }));
  await assertUnavailableGatewayAuth(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath }, true));
  assert.deepEqual(await loadGatewayStreamAuth({ OPENCLAW_CONFIG_PATH: configPath,
    PANEL_OPENCLAW_GATEWAY_PASSWORD: " fixture-local-password " }, true), {
    url: "ws://127.0.0.1:18789", password: "fixture-local-password"
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
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
    seq: 1, state: "delta", message: { content: "accepted" }, deltaText: "accepted" } });
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "accepted"), true);
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "must-not-deliver"), false);
  unobserve(); observer.stop();
});

test("authenticated observer exposes only scoped tool-result shape while ordinary listeners stay normalized", async t => {
  const sockets: FakeSocket[] = [], events: GatewayStreamEvent[] = [];
  const collector = createToolSchemaCollector("agent:a:schema", "schema-run");
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
    toolSchemaCollector: collector, webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { subscribed: true } })));
      sockets.push(socket); return socket;
    } });
  t.after(() => observer.stop());
  const observing = observer.observe("agent:a:schema", event => events.push(event));
  const privateResult = { content: [{ text: "must never reach listener or report" }], details: { stdout: "private stdout" } };
  sockets[0]!.message({ type: "event", event: "agent", payload: { runId: "schema-run", sessionKey: "agent:a:schema", seq: 1,
    stream: "tool", data: { phase: "result", toolCallId: "private-call", name: "exec", result: privateResult } } });
  assert.equal(collector.report().eventCount, 0, "pre-hello frames must not enter schema observation");
  sockets[0]!.challenge(); const unobserve = await withTimeout(observing, "schema observer subscription");
  sockets[0]!.message({ type: "event", event: "agent", payload: { runId: "wrong-run", sessionKey: "agent:a:schema", seq: 1,
    stream: "tool", data: { phase: "start", toolCallId: "wrong", name: "exec" } } });
  sockets[0]!.message({ type: "event", event: "session.tool", payload: { runId: "schema-run", sessionKey: "agent:a:schema", seq: 2,
    stream: "tool", data: { phase: "start", toolCallId: "private-call", name: "exec", args: { command: "private command" } } } });
  sockets[0]!.message({ type: "event", event: "agent", payload: { runId: "schema-run", sessionKey: "agent:a:schema", seq: 3,
    stream: "tool", data: { phase: "update", toolCallId: "private-call", partialResult: { text: "private partial" } } } });
  sockets[0]!.message({ type: "event", event: "agent", payload: { runId: "schema-run", sessionKey: "agent:a:schema", seq: 4,
    stream: "tool", data: { phase: "result", toolCallId: "private-call", name: "exec", result: privateResult, isError: false } } });
  assert.deepEqual(events.filter(event => event.type === "tool" && event.runId === "schema-run")
    .map(event => event.type === "tool" && event.phase), ["started", "completed"]);
  const report = collector.report(); assert.equal(report.eventCount, 3); assert.equal(report.lifecycle.attributedTerminals, 1);
  const reportJson = JSON.stringify(report);
  for (const secret of ["private-call", "private command", "private partial", "private stdout", "must never reach listener or report"])
    assert.equal(reportJson.includes(secret), false, `schema report leaked ${secret}`);
  const normalizedJson = JSON.stringify(events.filter(event => event.type !== "tool" || event.runId === "schema-run"));
  assert.equal(normalizedJson.includes("private-call"), true, "ordinary normalized events preserve call identity");
  assert.equal(normalizedJson.includes("private command"), true, "ordinary normalized start events preserve bounded args");
  for (const secret of ["private partial", "private stdout", "must never reach listener or report"])
    assert.equal(normalizedJson.includes(secret), false, `ordinary listener leaked raw result value ${secret}`);
  unobserve(); observer.stop();
});

test("a closed schema collector cannot block ordinary authenticated events or leak its failure", async t => {
  const sockets: FakeSocket[] = [], events: GatewayStreamEvent[] = [], diagnostics: string[] = [];
  const collector = createToolSchemaCollector("agent:a:closed-schema", "schema-run"); collector.finish();
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
    toolSchemaCollector: collector, onDiagnostic: value => diagnostics.push(value), webSocketFactory: () => {
      const socket = new FakeSocket((current, frame) => queueMicrotask(() => current.message({ type: "res", id: frame.id, ok: true,
        payload: frame.method === "connect" ? { type: "hello-ok", server: { version: "2026.6.11" },
          auth: { role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"] } } : { subscribed: true } })));
      sockets.push(socket); queueMicrotask(() => socket.challenge()); return socket;
    } });
  t.after(() => observer.stop());
  const unobserve = await observer.observe("agent:a:closed-schema", event => events.push(event));
  sockets[0]!.message({ type: "event", event: "session.tool", payload: { runId: "schema-run", sessionKey: "agent:a:closed-schema", seq: 1,
    stream: "tool", data: { phase: "start", toolCallId: "private-call", name: "exec", args: { value: "private-value" } } } });
  assert.equal(events.some(event => event.type === "tool" && event.phase === "started"), true);
  assert.equal(diagnostics.includes("tool schema observation failed"), true);
  assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  unobserve(); observer.stop();
});

test("stale socket callbacks, challenge, hello, and data cannot mutate a replacement generation", async t => {
  const sockets: FakeSocket[] = [], reconnected = deferred();
  let staleConnectId: unknown;
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
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
    seq: 1, state: "delta", message: { content: "fresh" }, deltaText: "fresh" } });
  assert.equal(events.some(event => event.type === "assistant_text" && event.text === "fresh"), true);
  assert.deepEqual(await observer.request("status", {}), { ok: true });
  unobserve(); observer.stop();
});

test("send failures retire the owned socket and recover on one replacement generation", async t => {
  for (const failure of ["throw", "callback", "ready"] as const) {
    const sockets: FakeSocket[] = [], reconnected = deferred(), diagnostics: string[] = [];
    const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 300,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 500,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", requestTimeoutMs: 100,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", requestTimeoutMs: 20,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", requestTimeoutMs: 10,
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
    const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const denied = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const rpc = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const closed = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
  const observer = new OpenClawStreamObserver({ url: "ws://fixture.local", token: "fixture", requestTimeoutMs: 200,
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
