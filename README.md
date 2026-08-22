# ark-panel

[English](README.md) · [简体中文](README.zh-CN.md)

> A self-hosted web panel for OpenClaw. Carry every conversation on your own ship.

When the flood comes, an ark is not about escape — it is about what you refuse to leave behind.
ark-panel keeps every conversation on your own machine: browse them, return to any of them, fork from any moment, and carry them wherever you go.

Accounts expire. Servers go dark. Years of conversation can vanish into a JSON export no one can read again.
ark-panel is a self-hosted session panel for OpenClaw — a claude.ai-like home for your agents, where the transcripts live on your own machine, in a format you own, ready to travel. Every session survives. Every session can be boarded again.

> ark-panel is under active development and is not yet ready for production use.

## Current scope

ark-panel runs locally on Node.js 22 and listens on `127.0.0.1` by default. Existing OpenClaw agent session directories are read-only data sources. New sessions, forks, edited branches, and generated replies are stored under `PANEL_DATA_DIR`.

Panel-owned sessions support `/model`, `/think`, `/reasoning`, `/new`, `/compact`, `/commands`,
`/help`, `/status`, `/models`, `/tools`, and `/usage` through a separate structured command API.
`/tools` reports the configured runtime catalog, not a guarantee that every listed tool is available to
the current run. `/usage` summarizes model-reported usage on the current authoritative transcript
branch; it is not billing data or a tokenizer estimate. Inputs beginning with `/` are still rejected by
the ordinary message API and never forwarded to the gateway's in-band command dispatcher. See
[the slash-command decision](docs/decisions/slash-commands.md) for the boundary.

Generation runs are server-owned resources rather than properties of one browser request. The panel persists their lifecycle and idempotency state, lets browsers query or re-subscribe after a dropped SSE connection, and only clears a draft after a confirmed completed run. While OpenClaw is running, the panel also relays its coalesced assistant-text updates and tool start/completion events as an ephemeral live preview. Text and tool cards are projected into their upstream sequence instead of being grouped by type; completion updates the original tool card without moving it. This is upstream event streaming, not a promise of one event per token. Live tool-result content is not exposed until the pinned runtime's result shape and redaction limits have passed isolated acceptance.

Message text is rendered as safe Markdown with raw HTML disabled. External HTTP(S) Markdown images are never fetched automatically: the panel shows their alt text and normalized origin, and offers an explicit no-referrer new-tab link only when the hostname differs from the panel. A URL on the panel hostname but a different origin is not navigable because browser cookies are not isolated by port. Only the existing exact-same-origin authenticated attachment preview route may remain inline; relative and other unsafe image targets stay inert. Inline and display LaTeX math is rendered locally with KaTeX; no CDN is required. Whole messages and individual fenced code blocks can be copied from the conversation view.

Messages show local date/time. All session sources can be renamed and moved into or out of the archive; metadata for read-only OpenClaw sources is stored in panel-owned sidecars and never written back to source transcripts.

### Markdown math

Use `$...$` or `\(...\)` for inline math:

```markdown
The identity $e^{i\pi}+1=0$ and the fraction \(\frac{a}{b}\) are inline.
```

Use `$$...$$` or `\[...\]` for display math. The delimiters may be on one line, or the opening and closing delimiters may occupy their own lines:

```markdown
$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$
```

Inline code and fenced code take precedence over math delimiters, so `` `$not_math$` `` stays code. Dollar signs in ordinary currency text are not treated as a formula when they do not form a valid math pair. Invalid LaTeX falls back to the original source instead of breaking the message. Copying a message or exporting it as Markdown preserves the original delimiters and LaTeX source.

## Feature status

Legend: ✅ available · 🚧 scheduled · 💡 candidate (not scheduled) · ⛔ intentionally out of scope

| Area | Capability | Status | Notes |
| --- | --- | :---: | --- |
| Access | Local account login and logout | ✅ | Slow password hashing, secure session cookies, CSRF and Host/Origin checks, login rate limiting |
| Sessions | Browse active, reset-archive, and panel-owned sessions across agents | ✅ | OpenClaw source transcripts remain read-only |
| Sessions | Create and continue panel-owned sessions | ✅ | Generation uses a dedicated, channel-free runtime for each agent |
| Sessions | Full-text search within the selected agent | ✅ | Search covers both the regular and archive views; the current view determines which results are shown |
| Sessions | Rename, archive, and restore any session source | ✅ | Read-only sources use panel-owned metadata sidecars |
| Sessions | Permanently delete panel sessions / hide read-only sessions | ✅ | Panel sessions require archive plus explicit confirmation; OpenClaw source files are never deleted |
| Sessions | Pin and group sessions by project | ✅ | Accessible quick menu assigns existing groups or creates one inline; active and archived sessions share the catalog, groups remain locally collapsible |
| Branching | Fork from a valid message boundary | ✅ | Preserves tool-call groups and never mutates the source transcript |
| Branching | Edit a user message and resend as a new branch | ✅ | The original branch remains available |
| Messages | Safe Markdown rendering | ✅ | Headings, lists, quotes, tables, links, inline and fenced code; raw HTML is inert. Cross-host HTTP(S) images require an explicit no-referrer navigation, same-host cross-origin and unsafe targets stay inert, and only the exact authenticated same-origin attachment preview may render inline |
| Messages | LaTeX math rendering | ✅ | KaTeX renders `$...$`, `\(...\)`, `$$...$$`, and `\[...\]` from same-origin assets with safe fallback |
| Messages | Fenced-code syntax highlighting | ✅ | Uses explicit language tags, displays the language, and safely falls back to plain text |
| Messages | Copy a whole message or fenced code block | ✅ | Available directly in the conversation view |
| Messages | Local timestamps | ✅ | Displayed using the browser's local time zone |
| Messages | Export the current branch as Markdown | ✅ | Includes timestamps, thinking, tool calls and tool results without internal paths or metadata |
| Messages | Thinking, tool calls, and tool results | ✅ | Structured, collapsible rendering including command output |
| Composer | Per-session local drafts and generation state | ✅ | Browser-local drafts survive refresh and failure; a run only locks its own conversation, so other drafts remain editable |
| Composer | Attachments and multimodal input | ✅ | Select, paste, or drop up to 10 supported files; safe raster images have draft thumbnails and authenticated in-message previews, while all files are stored server-side and sent as original bytes |
| Composer | Per-turn file output intent | ✅ | “Need files” is isolated with each conversation/new-agent draft, applies to the next send only, and is retained when submission fails |
| Messages | Download model-produced files | ✅ | Always collects OpenClaw artifacts; the isolated output-directory fallback is enabled only when “Need files” is selected for that turn; downloads require panel authentication |
| Conversation | Long-thread scroll following | ✅ | Preserves the reading position and shows a new-message control when the user has scrolled up |
| Generation | Durable run lifecycle, reconnect, stop, retry, and idempotent sending | ✅ | Server-owned run state survives browser disconnects; SSE can be re-subscribed and completed message groups commit atomically |
| Generation | Ordered live assistant text and tool status | ✅ | Interleaves coalesced text and tool cards by upstream sequence; duplicate/replayed events are idempotent, while tool stdout/result content and reasoning are not streamed |
| Context | Configurable context-budget protection | ✅ | Rejects oversized requests before generation instead of silently truncating history |
| Context | Durable compaction and `/compact` | ✅ | Manual `/compact` and UI actions persist verified OpenClaw summaries without deleting history; effective-context budgeting, markers, fork/export behavior, and optional memory-first review are complete |
| Commands | `/model`, `/think`, `/reasoning`, `/new` | ✅ | Panel-native structured operations; command text is never forwarded as a normal prompt |
| Commands | `/commands`, `/help`, `/status`, `/models`, `/tools`, `/usage` | ✅ | Read-only structured command API with a default-deny allowlist; tools are the configured runtime catalog, while usage is model-reported data for the current transcript branch |
| Commands | `/reset`, `/bash`, config/restart, and arbitrary passthrough | ⛔ | Deliberately excluded because of lifecycle, host, and gateway safety risks |
| Memory | Store per-session `scratch` / `eligible` disposition | ✅ | Defaults to `scratch`; both states have the same configured chat-runtime memory contract, while only eligible conversations may enter panel-managed consolidation; actual recall is runtime-specific and currently unknown |
| Memory | Disposition UI and read-only memory center | ✅ | Dedicated agent-aware tree and Markdown reader, entered directly above Settings; safely views allowed memory files with source-conversation links |
| Memory | Panel-managed consolidation workflow | ✅ | Candidate, confirmation, rolling-file, and recovery transactions are implemented for eligible conversations; live model execution, effective tools, and three-index refresh remain unknown pending #48 |
| Appearance | Switchable themes with named accent colors | ✅ | System/light/dark plus Gruvbox hard/medium/soft in light and dark variants; account-level and cross-device; all shipped accent pairs meet WCAG AA |
| Appearance | Settings drawer | ✅ | Gear opens Appearance / Reading directly; logout stays in the footer; account preferences persist server-side |
| Appearance | Custom per-agent avatars | ✅ | Previewed 1:1 crop, capped raster upload, server validation/re-encoding, reset-to-default, and account-level sharing |
| Appearance | Adjustable reading font size | ✅ | Device-local 85%–130% slider for messages, Markdown, code, tools, and math without scaling navigation/layout |
| Appearance | Conversation status (model overrides, context usage, last-active) | ✅ | Compact header summary; account-level server setting can hide it across devices; context uses fresh model-reported OpenClaw usage and is unknown otherwise, while the conservative estimate only guards sends |
| Sessions | Collapsible sidebar rail | ✅ | Collapses both desktop sidebars; keeps new-session, search, 10 recent sessions, settings, and the agent switcher; mobile flow remains full-screen |
| Generation | Background-completion notification | ✅ | Per-session device-local unread state, cross-agent/list markers and title count across concurrent runs; failures notify, user aborts do not |
| Conversation | Document title reflects session and agent | ✅ | Format `session - agent`; also carries the background-completion marker |
| Navigation | Keyboard shortcuts and command palette | 💡 | Candidate, not scheduled; a future version must be configurable and disableable for Vimium compatibility |
| Localization | Simplified Chinese and English UI | ✅ | Lightweight semantic-key catalogs; account-level language setting follows the user across devices, with Chinese fallback for legacy settings |
| Access | In-UI password change | ⛔ | Kept CLI-only (`npm run password-hash`); logout remains at the bottom of the settings drawer |
| Operations | Backup, integrity verification, restore, health check, and systemd example | ✅ | Includes deployment smoke and fixture-based browser acceptance coverage |

The appearance, sidebar, avatar, title, conversation-status, background-completion, bilingual UI,
reviewed panel-owned memory workflow, and manual durable long-context strategy are available. The
configuration contract gives scratch and eligible chats the same workspace/bootstrap/tool policy,
while only eligible chats enter panel-managed consolidation; whether a particular runtime actually
injects and recalls memory remains unknown pending #48. Compaction never deletes the full panel
transcript and is not automatic. Full terminal run records are retained for 30 days by default, then
retired into one of 256 fixed idempotency-tombstone shards. Those minimal tombstones are retained
indefinitely, so an old key can never execute again without retaining one file per run. The detailed
boundary lives in the [implementation specification](docs/implementation-spec.md).
OpenClaw compatibility remains version-gated maintenance. Real runtime, bootstrap, memory, proxy/TLS,
and deployed SSE status remains unknown pending the controlled #48 acceptance recorded in the current
matrix; dated evidence is not a timeless guarantee. The experience-feature rationale lives in
[the UX features decision](docs/decisions/ux-features.md); detailed constraints and acceptance criteria
live in the [implementation specification](docs/implementation-spec.md).

## Install and test

```sh
npm ci
npm run check:frontend
npm test
npm run test:coverage
```

The executable coverage scope, thresholds, exclusions, and browser boundary are documented in the [coverage baseline](docs/coverage.md).

Generate a password hash:

```sh
npm run password-hash -- 'replace-with-your-password'
```

## Configuration

Secrets belong in environment variables, never in the repository:

```sh
export PANEL_USERNAME='panel-user'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='a-random-secret-with-at-least-32-characters'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
# Required together for one HTTPS reverse-proxy entry point:
# export PANEL_PUBLIC_ORIGIN='https://panel.example.com'
# export PANEL_SECURE_COOKIE='1'
# Optional exact additional Host values if the proxy rewrites Host (JSON array):
# export PANEL_TRUSTED_HOSTS='["panel-internal.example.com"]'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'
export PANEL_RUN_RETENTION_DAYS='30'
# Optional: disable live preview while retaining durable generation and SSE lifecycle events.
export PANEL_OPENCLAW_STREAMING='1'

export PANEL_READ_AGENTS='{
  "assistant":{"label":"Assistant","sessionsRoot":"/srv/openclaw/agents/assistant/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "assistant":{"runtimeAgentId":"panel-runtime-assistant","sessionsRoot":"/srv/openclaw/agents/panel-runtime-assistant/sessions","workspaceRoot":"/srv/openclaw/workspaces/assistant"}
}'
export PANEL_MEMORY_RUNTIMES='{
  "assistant":{"runtimeAgentId":"panel-memory-assistant","sessionsRoot":"/srv/openclaw/agents/panel-memory-assistant/sessions"}
}'
```

`PANEL_READ_AGENTS` is the allowlist of real agents that may be browsed. `PANEL_AGENT_RUNTIMES` maps each browsable agent to a dedicated runtime with no channel bindings; never use a real, channel-bound agent as the panel runtime. Set each trusted `workspaceRoot` to enable the on-demand output-directory fallback and the read-only memory center. The browser can request files for one turn but cannot choose this path.

`PANEL_MEMORY_RUNTIMES` is optional and enables reviewed memory consolidation. Each entry must name a separate, channel-free `panel-memory-*` OpenClaw agent whose workspace is the corresponding `workspaceRoot`. Configure that agent with no tools, or only `memory_search` and `memory_get`; after creating each internal session, ark-panel checks its effective per-session tool inventory and refuses any inventory that exposes another tool. Do not reuse the ordinary chat runtime. Configuration and this fail-closed gate do not prove that a particular runtime's bootstrap, memory recall, model execution, or index refresh works; those remain unknown until #48 records a controlled result.

Uploaded files live under `PANEL_DATA_DIR/files` in content-addressed private storage and are included in normal backups. Office files are deliberately not converted: OpenClaw receives the original file and the model may inspect it with its own Python/skill tooling. OpenClaw's run artifacts are always collected without changing the user message. Only when the composer’s per-turn “Need files” toggle is enabled does the server create `.openclaw/tmp/ark-panel/<run-id>/outputs` below the configured workspace and append its output instruction to that turn sent to the runtime. Collected files are copied into panel storage before the temporary directory is removed. Symlinks, hardlinks, special files, path escapes, excessive file counts, and excessive sizes are rejected.

Long-running agent work defaults to a 30-minute OpenClaw execution limit (`PANEL_GATEWAY_RUN_TIMEOUT_MS`). The panel then waits an additional 30 seconds (`PANEL_RUN_WATCHER_GRACE_MS`) for the terminal trajectory event, so an upstream timeout or abort is reported accurately instead of being hidden by a simultaneous panel timeout.

`PANEL_RUN_RETENTION_DAYS` is an integer from `0` to `36500`, defaulting to `30`. After that many days, a full terminal run is replaced by a minimal entry in one of 256 fixed tombstone shards; tombstones remain indefinitely to preserve idempotency. Set the value to `0` to stop future retirement. This does not restore records already retired. A completed and verified offline backup of `PANEL_DATA_DIR` must exist before the first full run is replaced and deleted. For the first controlled start with retention enabled, set `PANEL_RUN_RETENTION_MIGRATION_CONFIRM=verified-offline-pre-gc-backup-v1`; the panel records a durable migration barrier, after which remove this one-time variable. Any other declared value is rejected. An older binary can be recovered only by restoring that pre-GC backup, not by pointing it at a data directory that already contains tombstone shards.

The panel reuses one server-side control WebSocket to the local OpenClaw Gateway while keeping browsers on the panel's authenticated SSE endpoint; the Gateway credential is never sent to a browser. For the pinned OpenClaw `2026.6.11`, the connection uses `gateway-client/backend`, role `operator`, and requests exactly `operator.read`, `operator.write`, and `operator.admin`; it rejects a `hello` grant that is missing, duplicates, or adds a scope. Read covers status/catalog/session observation and artifact collection, write covers temporary-session creation, send (including Base64 attachments), and abort, and admin covers session overrides, compaction, and deletion. An explicit, versioned RPC allowlist rejects every unreviewed method locally before a frame is sent.

The control resolver loads one strict-JSON OpenClaw config. `PANEL_OPENCLAW_CONFIG_PATH` is the only selector that can explicitly identify a config while `OPENCLAW_PROFILE` is declared; without it, any declared profile fails closed before `OPENCLAW_CONFIG_PATH`, state, home, or legacy selectors are considered. Otherwise the order is official `OPENCLAW_CONFIG_PATH`, the `openclaw.json` then `clawdbot.json` candidates under `OPENCLAW_STATE_DIR`, the four default/legacy candidates under `OPENCLAW_HOME`, then legacy `OPENCLAW_CONFIG`. A blank explicit path fails closed. A directory selector advances only when a candidate is absent and never falls through to a lower selector; an unreadable or invalid found file fails closed. With no selector, the same four candidates are tried under the OS home: `~/.openclaw/openclaw.json`, `~/.openclaw/clawdbot.json`, `~/.clawdbot/openclaw.json`, then `~/.clawdbot/clawdbot.json`. The current compatibility layer rejects JSON5 and also rejects any strict-JSON tree containing `$include` or an unescaped `${VAR}` substitution instead of partially interpreting it; `$${VAR}` remains a literal. A parse/resolution failure only makes Gateway control unavailable and never exposes config contents or paths.

The local endpoint scheme comes from `gateway.tls.enabled`. Its port precedence is a declared, non-blank, valid `OPENCLAW_GATEWAY_PORT`, then a valid `gateway.port`, then `18789`; a declared blank or invalid environment value fails closed instead of falling back. On that same endpoint, explicit `mode=none` always disables this connection even if stale fields or panel environment credentials remain; `token` and `password` use only their matching field; and an omitted mode is inferred only when exactly one credential kind is configured. `trusted-proxy` is accepted only for its same-host password fallback when `gateway.auth.trustedProxy.userHeader` is non-blank, `gateway.trustedProxies` is a non-empty list of non-blank entries, no config token is configured, no `PANEL_OPENCLAW_GATEWAY_TOKEN` variable is declared, and a non-blank password is selected; the connection sends password only. A declared `PANEL_OPENCLAW_GATEWAY_TOKEN` / `PASSWORD` group overrides only the credential selected by that known mode; an all-blank group fails closed without falling back. SecretRef strings and objects count as configured for mode, ambiguity, and mutual-exclusion checks, but the panel deliberately does not execute env/file/exec secret providers. A selected SecretRef therefore needs the matching non-blank `PANEL_*` plaintext override or control stays unavailable; no reference details enter errors or logs. Full provider-backed resolution requires a separately reviewed integration.

Remote mode is independent of local `gateway.auth` and never falls back to the local default. A configured remote endpoint requires a non-blank, safe `gateway.remote.url`, explicit `transport: "direct"`, and no configured `tlsFingerprint`; without a panel credential override it uses only `gateway.remote` credentials. A declared non-blank panel credential group may override those credential values, but does not change endpoint provenance or bypass transport checks. A declared `PANEL_OPENCLAW_GATEWAY_URL` with the same tagged origin additionally requires that panel credential group and remains configured-remote provenance, so the `direct` and no-fingerprint checks still apply. The panel does not create an SSH tunnel or implement fingerprint pinning; direct TLS uses normal host certificate verification. Only a panel URL with a different origin, or one supplied when the configured remote URL is absent, can be a self-contained independent endpoint; it requires a non-blank panel credential group and inherits no disk secret, transport, or pin assumption. In local mode, a panel URL that changes the tagged WebSocket origin (scheme, normalized host kind, or port) has the same independent-credential requirement; loopback aliases compare equal, while an ordinary DNS hostname such as `loopback` is never treated as the loopback sentinel. Public endpoints require `wss://`; plaintext `ws://` is accepted only for loopback, private/link-local/CGNAT/ULA literals, `.local`, and `.ts.net`, matching the pinned default transport policy. TLS certificate verification remains enabled, so a self-signed or private-CA endpoint must be trusted by the host before use. An endpoint assertion does not change the target Gateway's server-side auth mode: deploy it only with matching enforced token/password settings and validate it under #48.

Treat the selected shared secret as an owner-level credential for one trusted operator, not as multi-tenant isolation, and keep the default loopback route. Rotate the secret in the Gateway and panel together, restart both sides, and roll both back together if needed; enabling the current exact-scope handshake does not by itself require a credential reissue. If the server cannot resolve a valid config, endpoint, transport, or credential, read-only panel access remains available while every Gateway control operation fails with stable `GATEWAY_TRANSPORT_UNAVAILABLE`; errors and logs do not expose credentials, SecretRef details, config contents, or the selected private path, and production never falls back to a per-request Gateway CLI connection. `PANEL_OPENCLAW_STREAMING=0` disables only the ephemeral text/tool preview: the same control WebSocket and all three scopes remain necessary for generation, typed commands, attachments, and temporary-session lifecycle. A preview failure cannot decide run completion, but an unavailable control connection fails operations that need a Gateway RPC. The completed, verified transcript remains authoritative and replaces any preview atomically.

Build and start:

```sh
npm run build
npm start
```

Check the unauthenticated health endpoint:

```sh
npm run healthcheck
```

Run the deterministic Firefox/WebDriver acceptance suite (requires Firefox and
geckodriver on `PATH`):

```sh
npm run test:browser
```

### HTTPS reverse proxy

The application still listens only on `127.0.0.1`; a reverse proxy is the TLS
boundary. Configure exactly one browser-visible origin and secure cookies:

```sh
export PANEL_PUBLIC_ORIGIN='https://panel.example.com'
export PANEL_SECURE_COOKIE='1'
```

`PANEL_PUBLIC_ORIGIN` is exactly `http(s)://host[:port]`, with no trailing
slash, userinfo, path, query, fragment, or wildcard. Its normalized Host is
trusted automatically. `PANEL_TRUSTED_HOSTS` is an optional JSON array of at
most 16 additional exact Host values for a proxy that deliberately rewrites
`Host`; normally it should be omitted. Normalized duplicates, IDN/punycode
names, alternate numeric-IP spellings, and non-canonical IPv6 forms are
rejected at startup. Only one external origin is supported.

For example, place this in an nginx TLS-enabled server configuration (using
the real certificate paths for the deployment):

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/ssl/ark-panel/fullchain.pem;
    ssl_certificate_key /etc/ssl/ark-panel/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

The panel validates the actual `Host` and browser `Origin` independently. It
does not read `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`, or any other
proxy header, so those headers cannot expand the trust boundary. Missing or
`null` Origin values still fail login and mutations, and the existing CSRF
token remains required. Without these variables, localhost and SSH-forwarded
HTTP keep their existing defaults.

Current support is pinned to OpenClaw `2026.6.11`; rerun integration acceptance before upgrading OpenClaw.

## Documentation

- [Architecture](docs/architecture.md)
- [Implementation specification](docs/implementation-spec.md)
- [Engineering decisions](docs/decisions/engineering-decisions.md)
- [Documentation roles and index](docs/README.md)
- [Superseded version 1 launch checklist](docs/v1-completion.md)
- [Current support and acceptance matrix](docs/testing/README.md)
- [Runtime acceptance runbook](docs/testing/runtime-acceptance.md)
- [Dated streaming acceptance evidence](docs/testing/streaming-acceptance.md)
- [Dated browser acceptance evidence](docs/testing/browser-acceptance.md)
- [Development archive](docs/archive/development-notes/)

## License

ark-panel is available under the [MIT License](LICENSE).
