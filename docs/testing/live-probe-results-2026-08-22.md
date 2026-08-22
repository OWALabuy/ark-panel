# Live probe results — 2026-08-22

This is dated evidence, not a timeless compatibility guarantee.

- ark-panel commits: initial isolated probes at `f9f20d461b775797c1f4fddd32e6bb97f6504ed2`;
  staged diagnostic reruns at `299e80a9efbfe13cddc555e7a1faf68aacccd0dc` and
  `a9285217468a5eebd3ea969735a0ed750e8d16bb`
- OpenClaw: `2026.6.11 (e085fa1)`
- Gateway: temporary loopback listener on an otherwise unused port, started with `umask 077`
- configuration: built from an empty file with an allowlist of model/provider, local Gateway,
  one temporary agent and `bindings: []`; no production agent, session or workspace was selected
- data: fixed fictional probe transcript and memory markers only

Provider access was authorized for these runs. The provider secret and Gateway token were injected
only through process environments and were not copied into evidence, command arguments or the
temporary config. The temporary agents and their entire private state roots were deleted after the
Gateway had stopped and the empty session registries had been verified.

## Exact three-scope Gateway authorization (#42)

Both live probes completed the production `gateway-client` / `backend` hello against the real
Gateway. That client rejects the connection before any business RPC unless the returned grant is
exactly `operator.read`, `operator.write` and `operator.admin`. The compaction run subsequently
reached version, session creation, effective-tools, context-usage, compact and session-delete RPCs;
the runtime run reached configured-tools, session creation, effective-tools, send, terminal
observation and session-delete RPCs. This is a live pass for the current exact three-scope grant and
the listed typed paths. Unknown/additional-method rejection remains deterministic-test evidence,
not something these live calls re-executed. The combined evidence supports the current control
connection contract, but not a different OpenClaw version, remote Gateway, additional RPC, or
reduced-scope connection.

## Compaction revision and usage (#21)

The final diagnostic commit `a9285217468a5eebd3ea969735a0ed750e8d16bb` recognizes the exact
reason string `NO_EFFECTIVE_REDUCTION`; missing and other reason values stay folded into the generic
rejection code. Another newly created isolated agent repeated the same one-compact, zero-send
scenario and returned:

```json
{"schemaVersion":1,"probe":"compaction","status":"failed","errorCode":"PROBE_NO_EFFECTIVE_REDUCTION","cleanupCode":null}
```

The real provider request and `sessions.compact` RPC each completed once, and the original panel
revision was kept. `PanelCompactionApi` returned the exact `NO_EFFECTIVE_REDUCTION` reason, but this
probe version does not preserve whether that reason originated in the upstream compact response or
in the panel's conservative candidate comparison. It therefore does not prove that a candidate was
accepted and verified by the bridge, and it does not satisfy #21: there is still no accepted
post-compaction revision or fresh reload to validate. The runtime session and probe-owned panel root
were cleaned; the Gateway was stopped; the exact temporary agent, known plugin-skill links and
private state root were removed after identity/content checks; and no listener or probe root
remained.

After the combined failure below, commit `299e80a9efbfe13cddc555e7a1faf68aacccd0dc`
split the fixed envelope into directly tested, privacy-safe validation stages. A new isolated agent,
`panel-probe-compaction-diagnostic`, then repeated the same one-compact, zero-send scenario. The
real provider request and `sessions.compact` RPC each completed once, but the production panel
compaction API did not accept the candidate as `compacted: true`:

```json
{"schemaVersion":1,"probe":"compaction","status":"failed","errorCode":"PROBE_COMPACTION_NOT_ACCEPTED","cleanupCode":null}
```

This code is specific to the compact result and precedes the call-count and usage checks; it does
not identify why the candidate was not accepted. The probe removed the temporary runtime session
and panel root. The Gateway was then stopped, the exact temporary agent was deleted, its private
state tree was validated and deleted, and no listener or probe root remained. Because no accepted
compaction revision or fresh reload was produced, #21 remains open.

The earlier final isolated attempt used `panel-probe-compaction-live`, zero bindings and an effective
tool set of exactly `[]`. It created one temporary session, sent no user/model turn through
`sessions.send`, and invoked the production compaction path exactly once. The probe reached the
post-compaction validation but returned:

```json
{"schemaVersion":1,"probe":"compaction","status":"failed","errorCode":"PROBE_USAGE_INVALID","cleanupCode":null}
```

`PROBE_USAGE_INVALID` is a combined compact/usage gate: it includes the compact result and call
counts as well as fresh/source/safe totals, context-window consistency and strict reduction. The
fixed failure envelope did not retain enough structure to identify which conjunct failed. The probe
removed its temporary session and panel root, and the operator then stopped the Gateway and deleted
the temporary agent/root. This is a real failure, not an unexecuted/unknown result; #21 remains open
until the validation failure is diagnosed and a later authorized run passes revision, usage and
fresh reload together.

Two earlier fail-closed attempts made no compaction call: the first rejected the workspace scaffold
created by `openclaw agents add`; the second showed that `tools.allow: []` means no allow gate in this
OpenClaw version and rejected the resulting nonempty effective tool set. The final config used an
explicit wildcard deny and passed the exact-empty effective-tools gate.

## Bootstrap and memory continuity (#48)

The isolated target `panel-runtime-probe-memory-live` had zero bindings, a single fixed fictional
memory canary and an effective tool set of exactly `["memory_search"]`. One real model run completed,
but the authoritative added transcript did not contain the required unique direct chain of one
assistant memory-search call, one matching `role: "toolResult"` child and one assistant summary.
The result was:

```json
{"schemaVersion":1,"probe":"runtime-acceptance","status":"failed","errorCode":"PROBE_MEMORY_RESULT_INVALID","cleanupCode":"PROBE_CLEANUP_FAILED"}
```

The cleanup diagnostic was caused by an owner-only `skills-prompts` cache that OpenClaw created
inside the otherwise empty sessions root; the session registry itself was empty and no transcript
remained. After the Gateway stopped, the operator verified the exact empty registry, deleted the
temporary agent, validated the remaining private tree without reading prompt contents, removed the
two known plugin-skill symlinks, and deleted the entire temporary root. This target was a disposable
probe, not one of the configured chat runtimes named by #48, so the issue remains open and no result
is extrapolated to those runtimes.

## Tool-result schema probe (#27)

The tool-result schema probe was not run. Its current `maxToolCalls` and argument checks observe an
event only after execution may have started. A dedicated zero-binding agent does not make an exact
shell command safe by itself. Live execution remains blocked until the supported OpenClaw version
can enforce the exact command before dispatch, or the whole temporary Gateway runs in a disposable
OS/container sandbox that cannot reach host data or arbitrary network targets.
