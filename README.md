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

Panel-owned sessions support `/model`, `/think`, `/reasoning`, `/new`, `/commands`, `/help`, `/status`, and `/models` through a separate structured command API. Inputs beginning with `/` are still rejected by the ordinary message API and never forwarded to the gateway's in-band command dispatcher. See [the slash-command decision](docs/decisions/slash-commands.md) for the boundary.

Generation runs are server-owned resources rather than properties of one browser request. The panel persists their lifecycle and idempotency state, lets browsers query or re-subscribe after a dropped SSE connection, and only clears a draft after a confirmed completed run. While OpenClaw is running, the panel also relays its coalesced assistant-text updates and tool start/completion events as an ephemeral live preview. This is upstream event streaming, not a promise of one event per token.

Message text is rendered as safe Markdown with raw HTML disabled. Inline and display LaTeX math is rendered locally with KaTeX; no CDN is required. Whole messages and individual fenced code blocks can be copied from the conversation view.

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
| Sessions | Full-text search and source/agent filtering | ✅ | Search includes archived sessions; the current view controls which results are shown |
| Sessions | Rename, archive, and restore any session source | ✅ | Read-only sources use panel-owned metadata sidecars |
| Sessions | Permanently delete panel sessions / hide read-only sessions | ✅ | Panel sessions require archive plus explicit confirmation; OpenClaw source files are never deleted |
| Sessions | Pin and group sessions by project | ✅ | Accessible quick menu assigns existing groups or creates one inline; active and archived sessions share the catalog, groups remain locally collapsible |
| Branching | Fork from a valid message boundary | ✅ | Preserves tool-call groups and never mutates the source transcript |
| Branching | Edit a user message and resend as a new branch | ✅ | The original branch remains available |
| Messages | Safe Markdown rendering | ✅ | Headings, lists, quotes, tables, links, inline code and fenced code; raw HTML is not executed |
| Messages | LaTeX math rendering | ✅ | KaTeX renders `$...$`, `\(...\)`, `$$...$$`, and `\[...\]` from same-origin assets with safe fallback |
| Messages | Fenced-code syntax highlighting | ✅ | Uses explicit language tags, displays the language, and safely falls back to plain text |
| Messages | Copy a whole message or fenced code block | ✅ | Available directly in the conversation view |
| Messages | Local timestamps | ✅ | Displayed using the browser's local time zone |
| Messages | Export the current branch as Markdown | ✅ | Includes timestamps, thinking, tool calls and tool results without internal paths or metadata |
| Messages | Thinking, tool calls, and tool results | ✅ | Structured, collapsible rendering including command output |
| Composer | Per-session local drafts and generation state | ✅ | Browser-local drafts survive refresh and failure; a run only locks its own conversation, so other drafts remain editable |
| Composer | Attachments and multimodal input | ✅ | Select, paste, or drop up to 10 supported files; safe raster images have draft thumbnails and authenticated in-message previews, while all files are stored server-side and sent as original bytes |
| Messages | Download model-produced files | ✅ | Collects OpenClaw artifacts and files written to the current run's isolated output directory; downloads require panel authentication |
| Conversation | Long-thread scroll following | ✅ | Preserves the reading position and shows a new-message control when the user has scrolled up |
| Generation | Durable run lifecycle, reconnect, stop, retry, and idempotent sending | ✅ | Server-owned run state survives browser disconnects; SSE can be re-subscribed and completed message groups commit atomically |
| Generation | Live assistant text and tool status | ✅ | Relays OpenClaw's coalesced updates (currently about every 150 ms), not one event per token; tool stdout and reasoning are not streamed |
| Context | Configurable context-budget protection | ✅ | Rejects oversized requests before generation instead of silently truncating history |
| Context | Durable compaction and `/compact` | 🚧 | Planned together as the long-conversation strategy; summary boundaries and fork behavior still need design closure |
| Commands | `/model`, `/think`, `/reasoning`, `/new` | ✅ | Panel-native structured operations; command text is never forwarded as a normal prompt |
| Commands | `/commands`, `/help`, `/status`, `/models`, `/tools`, `/usage` | ✅ | Read-only structured command API with a default-deny allowlist; tools are the configured runtime catalog, while usage is model-reported data for the current transcript branch |
| Commands | `/reset`, `/bash`, config/restart, and arbitrary passthrough | ⛔ | Deliberately excluded because of lifecycle, host, and gateway safety risks |
| Memory | Store per-session `scratch` / `eligible` disposition | ✅ | Defaults to `scratch`; both states read the target agent's existing memory, while only eligible conversations may enter panel-managed consolidation; the control is not exposed yet |
| Memory | Disposition UI and read-only memory center | 🚧 | Cross-device “do not consolidate / allow consolidation” control plus safe viewing of `MEMORY.md`, `DREAMS.md`, and daily notes; no arbitrary paths or inline editing |
| Memory | Incremental consolidation for eligible conversations | 🚧 | Uses the same effective model in a separate side-effect-free session whose internal trace never enters chat context; after whole-draft review, writes a separate short-term note |
| Appearance | Switchable themes with named accent colors | ✅ | System/light/dark plus Gruvbox hard/medium/soft in light and dark variants; account-level and cross-device; all shipped accent pairs meet WCAG AA |
| Appearance | Settings drawer | ✅ | Gear opens Appearance / Reading directly; logout stays in the footer; account preferences persist server-side |
| Appearance | Custom per-agent avatars | ✅ | Previewed 1:1 crop, capped raster upload, server validation/re-encoding, reset-to-default, and account-level sharing |
| Appearance | Adjustable reading font size | ✅ | Device-local 85%–130% slider for messages, Markdown, code, tools, and math without scaling navigation/layout |
| Appearance | Conversation status (model overrides, context safety budget, last-active) | ✅ | Compact header summary; account-level server setting can hide it across devices; context is explicitly a conservative panel estimate |
| Sessions | Collapsible sidebar rail | ✅ | Collapses both desktop sidebars; keeps new-session, search, 10 recent sessions, settings, and the agent switcher; mobile flow remains full-screen |
| Generation | Background-completion notification | ✅ | Per-session device-local unread state, cross-agent/list markers and title count across concurrent runs; failures notify, user aborts do not |
| Conversation | Document title reflects session and agent | ✅ | Format `session - agent`; also carries the background-completion marker |
| Navigation | Keyboard shortcuts and command palette | 💡 | Candidate, not scheduled; a future version must be configurable and disableable for Vimium compatibility |
| Localization | Simplified Chinese and English UI | ✅ | Lightweight semantic-key catalogs; account-level language setting follows the user across devices, with Chinese fallback for legacy settings |
| Access | In-UI password change | ⛔ | Kept CLI-only (`npm run password-hash`); logout remains at the bottom of the settings drawer |
| Operations | Backup, integrity verification, restore, health check, and systemd example | ✅ | Includes deployment smoke and fixture-based browser acceptance coverage |

The appearance, sidebar, avatar, title, conversation-status, background-completion, and bilingual-UI batches are complete. The near-term order is the memory-disposition UI, a read-only memory center, and reviewed incremental consolidation for eligible conversations, followed by the durable long-context strategy with `/compact`. Scratch conversations still read existing memory; they simply do not enter the panel-managed consolidation path. The detailed boundary lives in [the memory-module decision](docs/decisions/panel-memory.md). OpenClaw compatibility remains ongoing maintenance. The experience-feature rationale lives in [the UX features decision](docs/decisions/ux-features.md); detailed constraints and acceptance criteria live in the [implementation specification](docs/implementation-spec.md).

## Install and test

```sh
npm ci
npm test
```

Generate a password hash:

```sh
npm run password-hash -- 'replace-with-your-password'
```

## Configuration

Secrets belong in environment variables, never in the repository:

```sh
export PANEL_USERNAME='owl'
export PANEL_PASSWORD_HASH='scrypt:...'
export PANEL_SESSION_SECRET='a-random-secret-with-at-least-32-characters'
export PANEL_DATA_DIR="$HOME/.local/share/ark-panel"
export PANEL_PORT='8790'
export PANEL_CONTEXT_HISTORY_BUDGET_TOKENS='100000'
export PANEL_GATEWAY_RUN_TIMEOUT_MS='1800000'
export PANEL_RUN_WATCHER_GRACE_MS='30000'
# Optional: disable live preview while retaining durable generation and SSE lifecycle events.
export PANEL_OPENCLAW_STREAMING='1'

export PANEL_READ_AGENTS='{
  "claude":{"label":"Claude","sessionsRoot":"/home/USER/.openclaw/agents/claude/sessions"},
  "main":{"label":"Main","sessionsRoot":"/home/USER/.openclaw/agents/main/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "claude":{"runtimeAgentId":"panel-runtime-claude","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-claude/sessions","workspaceRoot":"/home/USER/claude"},
  "main":{"runtimeAgentId":"panel-runtime-main","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-main/sessions","workspaceRoot":"/home/USER/clawd"}
}'
```

`PANEL_READ_AGENTS` is the allowlist of real agents that may be browsed. `PANEL_AGENT_RUNTIMES` maps each browsable agent to a dedicated runtime with no channel bindings; never use a real, channel-bound agent as the panel runtime. Set each trusted `workspaceRoot` to enable downloadable model outputs. The browser cannot choose this path.

Uploaded files live under `PANEL_DATA_DIR/files` in content-addressed private storage and are included in normal backups. Office files are deliberately not converted: OpenClaw receives the original file and the model may inspect it with its own Python/skill tooling. Model outputs are accepted only from OpenClaw's run artifacts or `.openclaw/tmp/ark-panel/<run-id>/outputs` below the configured workspace, then copied into panel storage before that temporary directory is removed. Symlinks, hardlinks, special files, path escapes, excessive file counts, and excessive sizes are rejected.

Long-running agent work defaults to a 30-minute OpenClaw execution limit (`PANEL_GATEWAY_RUN_TIMEOUT_MS`). The panel then waits an additional 30 seconds (`PANEL_RUN_WATCHER_GRACE_MS`) for the terminal trajectory event, so an upstream timeout or abort is reported accurately instead of being hidden by a simultaneous panel timeout.

Live preview uses a separate server-side WebSocket connection to the local OpenClaw Gateway and keeps the browser on the panel's authenticated SSE endpoint; the Gateway credential is never sent to the browser. By default the panel reads the local URL and token/password from `~/.openclaw/openclaw.json`. `PANEL_OPENCLAW_GATEWAY_URL`, `PANEL_OPENCLAW_GATEWAY_TOKEN`, and `PANEL_OPENCLAW_GATEWAY_PASSWORD` override those values, while `PANEL_OPENCLAW_STREAMING=0` disables preview. The connection requests `operator.read` for observation and `operator.write` for structured attachment sends; Base64 files are sent over WebSocket rather than a size-limited CLI argument. If observation disconnects, ordinary text generation continues through the existing CLI/trajectory path and the UI falls back to a non-streaming waiting state; attachment sends require the authenticated WebSocket transport. The completed, verified transcript remains authoritative and replaces the preview atomically.

Build and start:

```sh
npm run build
npm start
```

Check the unauthenticated health endpoint:

```sh
npm run healthcheck
```

When serving through an HTTPS reverse proxy, set `PANEL_SECURE_COOKIE=1`. The first version is pinned to OpenClaw `2026.6.11`; rerun integration acceptance before upgrading OpenClaw.

## Documentation

- [Architecture](docs/architecture.md)
- [Implementation specification](docs/implementation-spec.md)
- [Engineering decisions](docs/decisions/engineering-decisions.md)
- [Version 1 completion status](docs/v1-completion.md)
- [Runtime acceptance procedure](docs/testing/runtime-acceptance.md)
- [Streaming protocol acceptance](docs/testing/streaming-acceptance.md)
- [Browser acceptance results](docs/testing/browser-acceptance.md)
- [Development archive](docs/archive/development-notes/)

Operational and acceptance documents are still being consolidated as the first production deployment is completed.

## License

ark-panel is available under the [MIT License](LICENSE).
