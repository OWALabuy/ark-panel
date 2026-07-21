# AGENTS.md

This file applies to the entire repository.

## Project overview

ark-panel is a self-hosted OpenClaw session panel. It runs on Node.js 22 as an
ESM project and uses strict TypeScript for the server, storage, gateway, and
domain layers. The browser UI is implemented with plain HTML, CSS, and
JavaScript. Do not introduce a framework or a new production dependency unless
the task requires it and the trade-off has been agreed explicitly.

Read the current product and engineering contracts before changing behavior:

- `README.md` and `README.zh-CN.md` describe the supported product surface.
- `docs/architecture.md` records the architecture and OpenClaw assumptions.
- `docs/implementation-spec.md` contains detailed behavioral and acceptance
  requirements.
- `docs/decisions/` contains binding design and security decisions.
- `docs/testing/` contains dated acceptance evidence, not timeless guarantees.
- `docs/archive/` is historical context and is not normative.

When documentation disagrees with the implementation, do not silently choose
one. Check the current product contract and Git history, then update stale
documentation as part of the same work item when appropriate.

## Repository layout

- `src/domain/`: framework-independent transcript, fork, identifier, context,
  and export logic.
- `src/storage/`: authoritative panel storage, scanning, metadata, attachments,
  and atomic file operations.
- `src/gateway/`: the version-gated OpenClaw adapter, generation bridge,
  streaming, materialization, and restricted cleanup.
- `src/server/`: configuration, authentication, HTTP APIs, SSE, commands, and
  generation lifecycle coordination.
- `src/frontend/`: same-origin browser UI and localization catalogs.
- `src/ops/`: backup, restore, deployment, and operational smoke checks.
- `test/`: deterministic `node:test` coverage and browser fixtures.

Keep dependency direction clear. Put pure rules in `domain`, filesystem
ownership in `storage`, OpenClaw-specific behavior in `gateway`, and transport
or orchestration in `server`. Avoid moving upstream-specific assumptions into
the panel's authoritative data model.

## Required invariants

- Panel transcripts and metadata are authoritative. Derived indexes must remain
  disposable and rebuildable.
- Existing OpenClaw active and reset transcripts are read-only sources. Never
  write to, rename, archive, or delete them.
- The panel and OpenClaw must not write the same authoritative file. Preserve
  the existing materialization and one-use runtime-session boundary.
- Complete runs and mutable metadata must use the established atomic-write and
  durability helpers. Do not replace them with multi-line append or ad hoc
  writes.
- Reject symlinks, hardlinks where required, special files, path traversal, and
  paths outside configured allowlisted roots. Browser input must never select a
  host filesystem path.
- Keep secrets, gateway credentials, message bodies, prompts, and full private
  paths out of logs, fixtures, errors, documentation, and commits.
- Preserve authentication, fixed-host/origin checks, CSRF protection, request
  limits, and same-origin asset boundaries on HTTP changes.
- Treat the completed and validated transcript as authoritative; streaming is
  an ephemeral preview and must not decide completion or persist partial text.
- Preserve stable API error codes and response envelopes. Do not expose raw
  upstream payloads when a normalized DTO exists.
- OpenClaw integration is version-gated. Do not raise the supported version or
  change RPC, transcript, cleanup, or runtime assumptions without the isolated
  acceptance work documented in `docs/decisions/engineering-decisions.md`.
- Storage format changes require a migration and rollback plan. Do not silently
  reinterpret existing authoritative data.

## Implementation practices

- Preserve strict TypeScript settings, including unchecked-index and exact
  optional-property checks. Validate untrusted data at runtime instead of
  relying on casts.
- Use Node built-ins and existing helpers before adding dependencies.
- Follow the style of the surrounding file. The repository intentionally has no
  mandatory formatter; avoid unrelated mechanical reformatting.
- Keep frontend content safe: use text nodes or established safe Markdown and
  KaTeX helpers for untrusted values. Do not introduce `innerHTML` paths for
  user-controlled content.
- Keep the Chinese and English localization catalogs structurally identical.
- Add or update focused regression tests with behavioral changes. Fixtures must
  be fictional, deterministic, and free of private data.
- Update the relevant README, specification, decision, operations, or acceptance
  document when supported behavior, configuration, architecture, or operational
  procedure changes.
- Preserve unrelated user changes in a dirty worktree. Never discard or rewrite
  them to make a task easier.

## Validation

Use the narrowest useful checks while iterating, then validate in proportion to
risk before committing:

```sh
npm run typecheck
npm run build
npm test
```

`npm test` builds the project and runs the complete compiled `node:test` suite.
Run it for cross-layer, storage, security, lifecycle, dependency, or release
changes. A documentation-only work item may be validated by reviewing rendered
Markdown, links, and the Git diff instead of running the test suite.

The integration and acceptance commands below can contact a real local
OpenClaw runtime or exercise operational state. Do not run them merely because
they exist; follow their documentation and require the task or user to place
the relevant environment in scope:

- `npm run test:paneltest`
- `npm run test:stream-probe`
- `npm run test:runtime-acceptance`
- `npm run test:app-paneltest`
- `npm run test:panel-claude-runtime`
- `scripts/live-session-write-smoke.sh`

Never run live-session write checks against a real agent without the explicit
targets and confirmation required by the script and its acceptance document.

## Work items and commits

A work item is a coherent, independently reviewable change that can be tested
and reverted on its own. Examples include one bug fix with its regression test,
one feature slice, one refactor that preserves behavior, or one documentation
update.

- Finish, validate, and commit each work item before starting the next one. Do
  not accumulate several completed work items into a single commit.
- Do not create placeholder commits or commit known-broken, incomplete, or
  unvalidated work merely to satisfy the one-item-one-commit rule.
- Keep each commit limited to the work item. Stage files or hunks explicitly,
  inspect the staged diff, and do not include unrelated changes made by the user
  or another agent.
- Use the repository's Conventional Commit style, such as `feat:`, `fix:`,
  `test:`, `docs:`, `refactor:`, `perf:`, or `chore:`. Write the subject as an
  imperative summary of the completed outcome.
- Do not amend, squash, rebase, force-push, or otherwise rewrite existing commits
  unless the user explicitly requests it.
- If committing is blocked by unrelated changes, a failing baseline, missing
  identity, or a required user decision, stop and report the exact blocker
  instead of bypassing it.

Every agent-authored commit must include a `Co-authored-by` trailer for each
agent that materially contributed to that commit. Use the contributor's own
identity; never copy another agent's marker. Known identities in this repository
are:

```text
Co-authored-by: Codex <codex@openai.com>
Co-authored-by: Claude Opus 4.8 <noreply@anthropic.com>
```

If another agent contributes, use its stable product/model name and official
commit email. Include multiple trailers only when those agents actually
contributed to the same work item. The human-configured Git author remains the
commit author; do not change repository or global Git identity to impersonate
an agent.

Before committing, inspect `git status --short` and `git diff --cached`. A
typical commit created by Codex is:

```sh
git commit -m "fix: describe the completed outcome" \
  -m "Co-authored-by: Codex <codex@openai.com>"
```

After committing, verify the commit and confirm that the remaining worktree
contains no accidental changes from the completed work item.
