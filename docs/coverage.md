# Coverage baseline

`npm run test:coverage` builds the TypeScript project and runs the complete compiled `node:test` suite under the Node 22 built-in coverage collector. It prints the test and coverage summary for people and writes two machine-readable reports:

- `coverage/lcov.info`
- `coverage/summary.json`

The `coverage/` directory is ignored by Git. Each run recreates it and removes the generated inventory test before exiting.

## Coverage execution isolation

The coverage runner alone uses Node 22's
`--experimental-test-isolation=none` mode. That keeps the compiled test files
serial and in one test-runner context. Without it, the process-isolated runner
can emit several V8 profiles for the same compiled URL; Node 22's built-in LCOV
merge was observed to add 95 zero-hit branch ranges to that URL intermittently,
making the branch denominator depend on process-profile ordering rather than
executed behavior.

This measurement setting does not change the ordinary test gate. `npm test`
still uses Node's default per-file process isolation, and CI runs it in a
separate baseline job. The baseline and coverage jobs are independently
scheduled and may run in parallel; neither establishes an execution-order
guarantee. The single-context coverage run shares the module cache and process
globals across test files, so it complements rather than replaces the normally
isolated suite. V8 may still vary by a small number of reported branch ranges
between otherwise identical runs; every run must nevertheless satisfy the
unchanged line, branch, and function gates below.

## Scope and thresholds

The baseline includes every executable `src/**/*.ts` module (type-only `.d.ts` declarations are not runtime code) unless it appears in the explicit exclusion table below. The runner verifies the one-to-one `src/**/*.ts` to `dist/src/**/*.js` inventory and compares that inventory with the coverage produced by the real test suite. If a core module was never loaded, a separate temporary inventory process discovers its executable lines, branches, and functions; the final LCOV and JSON reports add that entire module with zero covered points. Consequently, a new core module cannot disappear merely because no existing test imports it, and the inventory import itself does not grant artificial coverage.

The initial Node 22 measurement on 2026-08-12, after adding focused `PanelMemoryApi` coverage, was:

| Metric | Covered / total | Measured | Gate |
| --- | ---: | ---: | ---: |
| Lines | 5,999 / 6,536 | 91.78% | 90% |
| Branches | 2,557 / 3,234 | 79.07% | 78% |
| Functions | 620 / 687 | 90.25% | 89% |

The roughly one-to-two-percentage-point margin accommodates small coverage-accounting variations while rejecting a clear project-wide regression. Raising the thresholds needs only a normal reviewed change. Lowering one requires the review to record a new clean measurement and explain which supported behavior or test boundary changed.

## Explicit exclusions

The executable source of truth is the `exclusions` object in `scripts/test-coverage.mjs`. The runner fails if an exclusion names a source file that no longer exists.

| Source | Reason |
| --- | --- |
| `src/gateway/paneltest-smoke.ts` | Requires a real OpenClaw test agent and gateway. |
| `src/gateway/runtime-acceptance-cli.ts` | Live runtime acceptance command entry point. |
| `src/gateway/stream-probe.ts` | Requires a real authenticated OpenClaw gateway. |
| `src/ops/backup-cli.ts` | Manual operations command entry point; `backup.ts` remains included. |
| `src/ops/deployment-smoke.ts` | Entry point exercised by the isolated deployment fixture CI job. |
| `src/server/main.ts` | Production startup and dependency-composition entry point. |
| `src/server/panel-claude-runtime-smoke.ts` | Requires an explicitly authorized live runtime. |
| `src/server/paneltest-app-smoke.ts` | Requires an explicitly configured OpenClaw test runtime. |

The positive `dist/src/**/*.js` inclusion boundary excludes compiled tests, fixtures, dependencies, vendored assets, generated declarations/source maps, and operational shell scripts without per-line ignore directives. Pure implementation behind an excluded entry point remains included when it lives in another module.

## Known boundaries

Node 22 reports the executed compiled JavaScript paths rather than remapping coverage to TypeScript source paths. The runner therefore validates the build inventory and records the explicit mapping in `summary.json`; reviewers should read an LCOV path such as `dist/src/storage/index.js` as the result for `src/storage/index.ts`.

The browser JavaScript under `src/frontend/` is not part of this server-side dynamic coverage number. It remains guarded by `npm run check:frontend` and the frontend static/fixture tests that run in the full suite. Browser dynamic coverage is a separate acceptance boundary and must not be represented as covered here.
