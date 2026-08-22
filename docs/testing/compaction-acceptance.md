# Live compaction acceptance

> **Runbook only — not an execution result**
>
> - Date reviewed: `2026-08-14`
> - OpenClaw target: exactly `2026.6.11`
> - Current status: `unknown`

This default-off probe exists solely to close the live evidence gap in #21. It creates a temporary
panel data root containing a fixed fictional transcript, creates exactly one temporary OpenClaw
session, calls the production compaction path once, and reloads the committed panel transcript
through fresh read objects. It never selects an existing panel record and never calls
`sessions.send`.

Do not run this command until a human has explicitly authorized the exact agent, config, sessions
root, empty workspace, and empty private panel-root parent. The target agent must be dedicated to
this probe, have zero channel bindings, and expose an effective tool inventory of exactly `[]`.
All four path inputs must be absolute, canonical, privately owned, non-overlapping paths. Start the
temporary Gateway under `umask 077`. The sessions root must contain no session or artifact; OpenClaw
may retain one owner-only, single-link regular `sessions.json` whose JSON value is exactly an empty
object, which the probe normalizes as empty. Any nonempty registry, extra key, permissive mode, or
other file fails closed. The workspace must be empty before the run. The strict config must contain
exactly one matching agent entry whose workspace is that exact path; the newly created transcript must be
empty and belong to the returned session before the probe replaces it with fictional history.
The agent must use the pinned OpenClaw `2026.6.11` compaction defaults: the config must not override
`agents.defaults.compaction` (the reviewed defaults retain about 20,000 recent tokens and reserve
16,384 tokens). Any compaction override fails before session creation.

This probe makes one billed provider summarization request. Its fixed fictional input contains
about 35,875 OpenClaw heuristic tokens in the old prefix plus about 24,000 in the retained tail;
the reviewed default permits up to about 13,107 output tokens. The provider's actual tokenizer,
context use, latency, and charge may differ. Authorization must therefore explicitly cover a target
model with enough context and the cost of this one fixed-size request.

```sh
PANEL_ALLOW_COMPACTION_LIVE_PROBE=1 \
PANEL_COMPACTION_PROBE_CONFIG_PATH=/explicit/openclaw/openclaw.json \
PANEL_COMPACTION_PROBE_SESSIONS_ROOT=/explicit/openclaw/agents/panel-probe-example/sessions \
PANEL_COMPACTION_PROBE_WORKSPACE_ROOT=/explicit/empty-private-workspace \
PANEL_COMPACTION_PROBE_PANEL_ROOT_PARENT=/explicit/empty-private-panel-parent \
npm run --silent test:compaction-live-probe -- \
  --agent panel-probe-example \
  --expected-version 2026.6.11 \
  --scenario panel-compaction-v1 \
  --max-compactions 1 \
  --cleanup delete-created-session-v1 \
  --confirm compaction:panel-probe-example:2026.6.11
```

The paths above are placeholders, not authorized targets. The npm script deliberately does not
set the gate. `--silent` is required so npm does not echo the path-bearing environment. Unknown or
duplicate arguments, endpoint overrides, a non-local config, missing or non-empty bindings, an
unsafe/occupied root, a workspace mismatch, another effective tool, a version mismatch, or any
cleanup uncertainty fails closed.

A pass requires all of the following from one created session and one compact call:

- fresh safe-integer pre/post usage from `openclaw-session`, with the same context window and a
  strictly smaller post total;
- the original transcript prefix unchanged, exactly one verified compaction entry at the current
  branch tip, and a changed authoritative revision;
- a fresh `SessionReadIndex` / `SessionReadData` reload whose revision and current-tip usage match
  the committed result;
- zero send calls, one create/compact/delete, an unchanged empty workspace, an unchanged runtime
  root snapshot after constrained cleanup (with only the canonical empty registry normalized away),
  and identity-checked removal of the probe-owned panel root.

Stdout contains only the fixed report schema, booleans and fictional token counts. Stderr contains
only fixed error and cleanup codes from the CLI; neither output includes paths, credentials,
agent/session/record/entry identifiers, transcript text, model output, summaries, hashes or tool
names. If the compact RPC outcome is unknown and abort cannot be confirmed, runtime artifacts are
retained and the probe reports cleanup failure instead of retrying or claiming success.

The deterministic tests exercise this orchestration with a fake transport. They do not change the
status above. Only an explicitly authorized real execution, followed by dated evidence tied to an
exact ark-panel commit and OpenClaw version, can move #21 from `unknown`.
