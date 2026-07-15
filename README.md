# ark-panel

> A self-hosted web panel for OpenClaw. Carry every conversation on your own ship.

When the flood comes, an ark is not about escape — it is about what you refuse to leave behind.
ark-panel keeps every conversation on your own machine: browse them, return to any of them, fork from any moment, and carry them wherever you go.

Accounts expire. Servers go dark. Years of conversation can vanish into a JSON export no one can read again.
ark-panel is a self-hosted session panel for OpenClaw — a claude.ai-like home for your agents, where the transcripts live on your own machine, in a format you own, ready to travel. Every session survives. Every session can be boarded again.

> ark-panel is under active development and is not yet ready for production use.

## Current scope

ark-panel runs locally on Node.js 22 and listens on `127.0.0.1` by default. Existing OpenClaw agent session directories are read-only data sources. New sessions, forks, edited branches, and generated replies are stored under `PANEL_DATA_DIR`.

Panel-owned sessions support `/model`, `/think`, `/reasoning`, `/new`, `/commands`, `/help`, `/status`, and `/models` through a separate structured command API. Inputs beginning with `/` are still rejected by the ordinary message API and never forwarded to the gateway's in-band command dispatcher. See [the slash-command decision](docs/decisions/slash-commands.md) for the boundary.

Generation runs are server-owned resources rather than properties of one browser request. The panel persists their lifecycle and idempotency state, lets browsers query or re-subscribe after a dropped SSE connection, and only clears a draft after a confirmed completed run. It does not claim token-by-token streaming.

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
| Sessions | Pin and group sessions by project | ✅ | Project groups can be collapsed locally; list items expose quick pin, archive, and export actions |
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
| Conversation | Long-thread scroll following | ✅ | Preserves the reading position and shows a new-message control when the user has scrolled up |
| Generation | Durable run lifecycle, reconnect, stop, retry, and idempotent sending | ✅ | Server-owned run state survives browser disconnects; SSE can be re-subscribed and completed message groups commit atomically |
| Generation | Token-by-token streaming | ⛔ | The current gateway integration does not promise incremental token output |
| Context | Configurable context-budget protection | ✅ | Rejects oversized requests before generation instead of silently truncating history |
| Context | Durable compaction and `/compact` | 🚧 | Planned together as the long-conversation strategy; summary boundaries and fork behavior still need design closure |
| Commands | `/model`, `/think`, `/reasoning`, `/new` | ✅ | Panel-native structured operations; command text is never forwarded as a normal prompt |
| Commands | `/commands`, `/help`, `/status`, `/models` | ✅ | Read-only structured command API with a default-deny allowlist |
| Commands | `/reset`, `/bash`, config/restart, and arbitrary passthrough | ⛔ | Deliberately excluded because of lifecycle, host, and gateway safety risks |
| Memory | Store per-session `scratch` / `eligible` disposition | ✅ | Defaults to `scratch`; the control is not exposed in the UI yet |
| Memory | Memory-disposition UI and scratch isolation during inference | 🚧 | Isolation behavior will be selected through `paneltest` runtime acceptance |
| Appearance | Switchable themes with named accent colors | 🚧 | Built-in light/dark plus gruvbox presets; account-level, cross-device; open color picker deferred |
| Appearance | Settings drawer | 🚧 | Gear-icon entry; Appearance / Reading / Account sections; account preferences persist server-side |
| Appearance | Custom per-agent avatars | 🚧 | Uploaded, cropped to 1:1 on the client; account-level and shared; doubles as the agent switcher |
| Appearance | Adjustable font size | 🚧 | Slider scaling text and line height together; device-local |
| Appearance | Status display (model badge, context gauge, last-active) | 💡 | Recorded as a candidate; not scheduled |
| Sessions | Collapsible sidebar rail | 🚧 | Keeps new-session, search, recent-sessions, settings, and the agent switcher when collapsed |
| Generation | Background-completion notification | 🚧 | Builds on run/connection decoupling; title marker when backgrounded, list dot when focused; no browser Notifications |
| Conversation | Document title reflects session and agent | 🚧 | Format `session - agent`; also carries the background-completion marker |
| Navigation | Keyboard shortcuts and command palette | ⛔ | Excluded to avoid conflicting with browser Vimium usage |
| Access | In-UI password change | ⛔ | Kept CLI-only (`npm run password-hash`); the settings account section only exposes logout |
| Operations | Backup, integrity verification, restore, health check, and systemd example | ✅ | Includes deployment smoke and fixture-based browser acceptance coverage |
| Extras | Attachments/multimodal input | 💡 | Recorded for future evaluation; not currently scheduled |

The near-term order is the appearance work led by a dark theme (the most-requested comfort fix), then the background-completion notification, then memory disposition and isolation, and the long-context strategy with `/compact`. OpenClaw compatibility remains ongoing maintenance. The experience-feature rationale lives in [the UX features decision](docs/decisions/ux-features.md); detailed constraints and acceptance criteria live in the [implementation specification](docs/implementation-spec.md).

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

export PANEL_READ_AGENTS='{
  "claude":{"label":"Claude","sessionsRoot":"/home/USER/.openclaw/agents/claude/sessions"},
  "main":{"label":"Main","sessionsRoot":"/home/USER/.openclaw/agents/main/sessions"}
}'

export PANEL_AGENT_RUNTIMES='{
  "claude":{"runtimeAgentId":"panel-runtime-claude","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-claude/sessions"},
  "main":{"runtimeAgentId":"panel-runtime-main","sessionsRoot":"/home/USER/.openclaw/agents/panel-runtime-main/sessions"}
}'
```

`PANEL_READ_AGENTS` is the allowlist of real agents that may be browsed. `PANEL_AGENT_RUNTIMES` maps each browsable agent to a dedicated runtime with no channel bindings; never use a real, channel-bound agent as the panel runtime.

Long-running agent work defaults to a 30-minute OpenClaw execution limit (`PANEL_GATEWAY_RUN_TIMEOUT_MS`). The panel then waits an additional 30 seconds (`PANEL_RUN_WATCHER_GRACE_MS`) for the terminal trajectory event, so an upstream timeout or abort is reported accurately instead of being hidden by a simultaneous panel timeout.

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
- [Browser acceptance results](docs/testing/browser-acceptance.md)
- [Development archive](docs/archive/development-notes/)

Operational and acceptance documents are still being consolidated as the first production deployment is completed.

## License

ark-panel is available under the [MIT License](LICENSE).
