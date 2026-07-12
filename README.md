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

The server currently reports generation lifecycle events over SSE and refreshes the completed message group after the gateway finishes. It does not claim token-by-token streaming.

Message text is rendered as safe Markdown with raw HTML disabled. Whole messages and individual fenced code blocks can be copied from the conversation view.

Messages show local date/time. All session sources can be renamed and moved into or out of the archive; metadata for read-only OpenClaw sources is stored in panel-owned sidecars and never written back to source transcripts.

## Feature status

Legend: ✅ available · 🚧 scheduled · 💡 candidate (not scheduled) · ⛔ intentionally out of scope

| Area | Capability | Status | Notes |
| --- | --- | :---: | --- |
| Access | Local account login and logout | ✅ | Slow password hashing, secure session cookies, CSRF and Host/Origin checks, login rate limiting |
| Sessions | Browse active, reset-archive, and panel-owned sessions across agents | ✅ | OpenClaw source transcripts remain read-only |
| Sessions | Create and continue panel-owned sessions | ✅ | Generation uses a dedicated, channel-free runtime for each agent |
| Sessions | Full-text search and source/agent filtering | ✅ | Search includes archived sessions; the current view controls which results are shown |
| Sessions | Rename, archive, and restore any session source | ✅ | Read-only sources use panel-owned metadata sidecars |
| Sessions | Permanently delete panel sessions / hide read-only sessions | 🚧 | Panel sessions will require archive plus explicit confirmation; OpenClaw source files will never be deleted |
| Branching | Fork from a valid message boundary | ✅ | Preserves tool-call groups and never mutates the source transcript |
| Branching | Edit a user message and resend as a new branch | ✅ | The original branch remains available |
| Messages | Safe Markdown rendering | ✅ | Headings, lists, quotes, tables, links, inline code and fenced code; raw HTML is not executed |
| Messages | Copy a whole message or fenced code block | ✅ | Available directly in the conversation view |
| Messages | Local timestamps | ✅ | Displayed using the browser's local time zone |
| Messages | Thinking, tool calls, and tool results | ✅ | Structured, collapsible rendering including command output |
| Generation | Run lifecycle, stop, retry, and idempotent sending | ✅ | SSE reports lifecycle events; completed message groups refresh atomically |
| Generation | Token-by-token streaming | ⛔ | The current gateway integration does not promise incremental token output |
| Context | Configurable context-budget protection | ✅ | Rejects oversized requests before generation instead of silently truncating history |
| Context | Durable compaction and `/compact` | 🚧 | Planned together as the long-conversation strategy; summary boundaries and fork behavior still need design closure |
| Commands | `/model`, `/think`, `/reasoning`, `/new` | ✅ | Panel-native structured operations; command text is never forwarded as a normal prompt |
| Commands | `/commands`, `/help`, `/status`, `/models` | ✅ | Read-only structured command API with a default-deny allowlist |
| Commands | `/reset`, `/bash`, config/restart, and arbitrary passthrough | ⛔ | Deliberately excluded because of lifecycle, host, and gateway safety risks |
| Memory | Store per-session `scratch` / `eligible` disposition | ✅ | Defaults to `scratch`; the control is not exposed in the UI yet |
| Memory | Memory-disposition UI and scratch isolation during inference | 🚧 | Isolation behavior will be selected through `paneltest` runtime acceptance |
| Operations | Backup, integrity verification, restore, health check, and systemd example | ✅ | Includes deployment smoke and fixture-based browser acceptance coverage |
| Extras | Pin sessions, export Markdown, attachments/multimodal input, local drafts | 💡 | Recorded for future evaluation; not currently scheduled |

The near-term order is session deletion/hiding, memory disposition and isolation, then the long-context strategy with `/compact`. OpenClaw compatibility remains ongoing maintenance. Detailed constraints and acceptance criteria live in the [implementation specification](docs/implementation-spec.md).

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
