# Technical-debt status — 2026-08-14

This is a dated local governance snapshot, not a GitHub issue mutation or a release claim.

- Audit baseline: ark-panel `319e933` on local `main`.
- Remote baseline observed during the audit: `origin/main` `190982f`; local `main` was 69
  commits ahead and had not been pushed.
- Live boundary: no OpenClaw runtime, Gateway probe, live session write, push, pull request,
  hosted Actions run, or issue close was performed for this snapshot.
- Evidence rule: “ready to close” below means the issue's repository-side acceptance is backed
  by an ancestor commit and current deterministic or Firefox evidence. It does not mean the
  remote issue has been closed or that unpublished commits are externally reviewable.

## Repository-side acceptance ready after publication

| Issue | Canonical implementation/evidence | Current conclusion |
| --- | --- | --- |
| #13 | `c880390`; current Firefox suite through `ada1548` | Quick-menu viewport placement, single-open ownership, outside pointer, Escape/focus, rerender, sidebar and history paths are covered on desktop and coarse mobile. |
| #19 / #20 | `1f97c0c` | Long-model geometry, responsive priority, context `k` values, unknown/stale states and `showStatus` persistence passed three desktop/mobile Firefox repetitions. #21 live compaction remains separate. |
| #26 | `3d68314`, Firefox evidence through `ada1548` | The coarse-mobile output-intent control is clickable, at least 44px, stateful, session scoped and reset only after acceptance. This is Firefox coarse-pointer evidence, not physical-device evidence. |
| #28 | `28b6ec9`, `7cbe328` | `sharp`/bundled libvips were upgraded past the affected tree; full decode covers raster format, metadata-readable truncation, animation and total-pixel limits. Current lockfile audit returned zero vulnerabilities. |
| #29 | `08f87b9`, `3674f46` | Panel records publish atomically, parent durability is explicit, and one corrupt record is isolated without hiding healthy records. |
| #30 | `b6e53d3`, `62ac227`, `312e052` | Rebuildable read indexes replace repeated full scans while direct lookup, invalidation and attachment lookup remain fail closed. |
| #32 | `f16893a` | Output collection binds file identity and rejects append, truncate, overwrite, replacement, link-count and special-file races. |
| #33 | `b910c7a`, `878682d`, `e3d36df` | The active-run index is rebuildable and no longer scans every terminal run on the hot path; write/rename failures rebuild safely. |
| #35 | `7d01df6` | One generation fingerprint covers record, message, revision, ordered attachments and output intent across create/generate/cache paths. |
| #36 | `3b4283e` | The unused `runBridge` boundary is gone and Gateway generation has one orchestration entry point. |
| #38 | `77dba60` | All first-party frontend JavaScript is included in strict `checkJs`; vendor code is excluded explicitly and CI invokes the check. |
| #39 | `cf3c1ea`, `44b8c27` | Coverage dynamically inventories core tests, rejects unloaded files, publishes LCOV/JSON and enforces 90/78/89 thresholds in an isolated job. |
| #40 | `3a29ee4`, `ac9677f`, `ada1548` | `npm run test:browser` drives real Firefox desktop/mobile interactions with fictional data, bounded ownership cleanup and in-memory success screenshots. |
| #41 | `758e3d9`, `3976394`; tested snapshot `9663899`; evidence `dc64435` | Temp fixtures self-clean and readiness uses deterministic synchronization; the four lifecycle suites passed 20 default and 20 serial repetitions with zero owned roots/process residuals. Browser-process ownership hardening is separately covered by #40. |
| #43 | implementation `cfe53d9`; Firefox execution snapshot `6574548`; evidence `45b6a59` | External Markdown images require explicit safe navigation; authenticated same-origin previews remain inline and Firefox loopback probes verify the network boundary. |
| #44 | `67093c8` | Public origin/trusted-host configuration, exact Host/Origin enforcement, proxy-aware cookies and deployment restart behavior are implemented and tested. |
| #45 | `d283dd0` | The selected issue option is the narrower product claim: both READMEs now promise full-text search within the selected agent, not a nonexistent source filter. |
| #46 | `37a4d9e` | Current product, architecture, implementation and decision documents were reconciled; archived construction notes are explicitly non-normative. |
| #47 | `61cc824`, `2e2e782`, `319e933` | The current matrix separates automated, historical, partial, unsupported and unknown evidence and anchors the gated schema probe to its real commit. |
| #49 | final split `f669327`; post-refactor Firefox snapshot `ada1548` | Generation/run/SSE/composer state is split into explicit same-origin ESM modules with direct state tests; the final desktop/mobile Firefox smoke passed 2/2. |
| #50 | `40cb3b8`, `ada1548`, `a8a003c` | Six ordered semantic CSS layers preserve the rule inventory, themes, accents, responsive cascade and interaction behavior; desktop/mobile success PNGs are validated in memory. |

These issues must remain open remotely until the commits are published and the issue close comment
can link the externally reachable commit and exact evidence. This file deliberately does not treat a
local commit as a hosted CI result.

## Explicit external acceptance still required

| Issue | Missing authority/evidence | Repository state |
| --- | --- | --- |
| #21 | An explicitly authorized, zero-binding OpenClaw compaction run must show pre/post revision and usage, including reload. | A default-off probe at `86c75db` covers the production path with fixed fictional data, one compact, zero sends and constrained cleanup, but it remains unexecuted. Follow the dedicated [compaction runbook](compaction-acceptance.md); deterministic tests do not close the live evidence gap. |
| #27 | Run the gated `35057f4` schema probe against an explicitly named, channel-free runtime only after confirming zero bindings, the fixed supported version and exact effective tools. Use only fictional input and retain no credential, message body or private path. | Ordered synthetic text/tool-args preview is implemented at `3db3d00`; upstream sequence/result shape is unknown and panel result/stdout rendering remains unsupported pending accepted schema. Follow the [schema-probe runbook](streaming-acceptance.md#当前-tool-result-schema-探针尚未实机执行). |
| #37 | Publish a branch/PR and retain a GitHub-hosted clean run plus controlled failure attribution. | Local workflow structure and fault propagation are covered at `a4a9a6e`; the workflow is absent from the current remote default branch. |
| #42 | Confirm the exact read/write/admin grant and allowlisted RPCs against an authorized real Gateway. | Code and normative documents use one exact three-scope control connection; fake protocol tests cannot prove a real grant. Follow the gated [stream-probe runbook](streaming-acceptance.md). |
| #48 | Re-run each minimally identified target only after explicit per-runtime authorization, fixed-version confirmation and an exact channel-free/zero-bindings preflight; use fictional nonces and do not retain credentials, message bodies or unnecessary private paths. | Historical runtime results are not promoted to current support. Follow the gated [runtime acceptance runbook](runtime-acceptance.md). |

No live command in this table may be inferred from ordinary test authorization. Follow the linked
runbook, the repository [README](../../README.md), and the repository `AGENTS.md` before execution.

## Human decisions required before implementation or issue closure

### #31 — failed fork staging policy

The fork/edit-and-fork atomicity defect is fixed at `613e2c1`: source attachment data is preflighted,
the target record is published once, failed targets are not enumerable, source data is unchanged,
and retry succeeds. One issue checkbox still conflicts with the binding storage decision.

Recommended decision: treat private `.panel-session-staging-*` entries as isolated failure evidence,
not leaked records or attachment owners. They remain `0700`/`0600`, are ignored by enumeration and
attachment GC, and are never automatically deleted. Update #31's “no staging leak” checkbox to say
that retry leaves no enumerable target or owner, while reserved failure evidence may remain.

This choice has a material privacy and capacity cost: depending on the failed step, staging can hold
complete or partial real metadata, transcript text and an attachment index. Repeated failures can
accumulate without a bound and the directories are included in whole-data-root backups. Selecting
the recommendation therefore means explicitly accepting that long-lived disk/backup retention and
tracking a separate operator/retention cleanup design. This local snapshot cannot close #31 by
itself; its remote AC4 must first be changed with explicit remote-write authorization.

The alternative—automatic cleanup—requires an independently reviewed deletion state machine with
dev/inode identity, an exact file allowlist, no recursive removal, parent-directory durability and
fail-closed retention whenever rollback or cleanup is uncertain. It still cannot honestly promise
zero residuals after cleanup I/O failure, and it expands the destructive/TOCTOU surface.

### #34 — terminal-run retention and durable tombstones

Implementation must not begin until these external promises are chosen:

1. Full terminal record TTL: recommended configurable 30 days, measured from a valid `finishedAt`;
   `0` keeps current infinite retention. Only terminal records with `cleanupPending !== true` are
   eligible; missing/invalid finish time or pending cleanup fails closed by retaining the full record.
2. Tombstone lifetime: recommended indefinite, otherwise an old idempotency key can execute again.
3. Same-fingerprint retry after compaction: recommended return the prior terminal snapshot with
   `newlyCreated:false`, rather than introduce a new `RUN_RETIRED`/410 API behavior.
4. Rollback: recommended first ship a dual reader with retention disabled, require a verified offline
   backup before enabling GC, and require either a downgrade export into a new data directory or
   restoration of the pre-GC backup before starting an old binary.

The minimal tombstone should retain only version/kind, runId, recordId, requestHash,
`fingerprintMatcherVersion`, terminal status, sequence, created/updated/finished/retired timestamps,
optional completed revision and optional stable failure code. Existing records have no fingerprint
version field and the current matcher deliberately accepts both current and legacy hashes, so the
migration must mark them with a compatibility matcher version rather than invent a single historical
fingerprint version. If the chosen API behavior returns a prior failed snapshot, its public error
message must be reconstructed from the stable code through the same fixed server mapping; raw error
text must not enter the tombstone. It must not retain messages, attachment IDs, staged entries,
output, runtime/session identifiers, temporary paths, error text or diagnostics.

## Tracker disposition

#51 remains the remote coordination issue. Its 2026-08-12 body is a historical audit baseline
(224 tests, one high dependency finding and 233 temporary entries), not the current implementation
state. After publication and only with fresh explicit remote-write authorization, add a comment that
links this dated snapshot instead of rewriting the original observations. The same authorization is
required before commenting on or closing any child issue. Keep #51 open while #21, #27, #31, #34,
#37, #42 or #48 remains unresolved; close it only after every child has externally reachable evidence
and its own disposition is recorded. Nothing in this document grants push, comment, label or close
authority.
