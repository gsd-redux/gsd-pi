---
id: T024
title: Unblock gates at clean HEAD — redirect @opengsd/contracts to source in both test tiers, then re-run the T001 baseline
wave: 2
deps: []
status: blocked
agent: build_T024
commit: null
base: 219c3ad52bdc46b0753da1c57e5943dd03954a0a
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/tests/dist-redirect.mjs
  - scripts/dist-test-resolve.mjs
  - .project/plan/wave1-gate-baseline.md
---

# T024 — Gate unblock: @opengsd/contracts source redirect + baseline re-run

## Context

T001's baseline re-run (`.project/plan/wave1-gate-baseline.md`, VERDICT:
BASELINE RED) found that `baseline:refactor:gate`, `baseline:refactor:phase0`,
and `gate:semantic-shadow-no-cutover` all fail at clean HEAD with
`ERR_MODULE_NOT_FOUND: @opengsd/contracts/dist/index.js` (imported from
`src/resources/extensions/gsd/workflow-tool-surface.ts`). Root cause:
`packages/contracts` is NOT redirected to source by
`src/resources/extensions/gsd/tests/dist-redirect.mjs` (the strip-types tier,
which covers `@gsd/*` and `@earendil-works/*` packages), its `dist/` is not
gitignored so it is never present at clean HEAD, and nothing in the gate
procedure builds it. The compiled test tier has the same gap:
`scripts/dist-test-resolve.mjs` maps workspace packages into `dist-test/` via
`WORKSPACE_ENTRIES` + `WORKSPACE_SCOPES = ['@gsd', '@earendil-works',
'@mariozechner']` — neither covers `@opengsd/contracts`.
`scripts/compile-tests.mjs` already compiles `packages/*/src/` into
`dist-test/`, so no build-step change is needed — only the two resolve hooks.
Whether the baseline is otherwise green is UNDETERMINED: 13 of 15 behavioral
witnesses and all four phase-0 files never executed. This task makes the gates
runnable at clean HEAD and re-runs the T001 baseline BEFORE any wave-2 cutover
code lands, because T005/T006/T007/T009 acceptance and Verify commands depend
on these gates.

## Steps

1. In `src/resources/extensions/gsd/tests/dist-redirect.mjs`, add a redirect
   branch for `@opengsd/contracts` following the exact existing `@gsd/*`
   convention (see the `@gsd/pi-ai` exact + `dist/index.js` forms at lines
   27-36): map `@opengsd/contracts` and `@opengsd/contracts/dist/index.js` to
   `new URL("packages/contracts/src/index.ts", ROOT).href`, and
   `@opengsd/contracts/<subpath>` to
   `packages/contracts/src/<subpath-with-.ts>`. The package's only export is
   `.` (`packages/contracts/package.json` — `src/index.ts` re-exporting
   `rpc.ts` / `workflow.ts`), so the subpath form is defensive; mirror the
   pi-ai pattern, do not invent a new mechanism.
2. In `scripts/dist-test-resolve.mjs`: add
   `'contracts': new URL('../dist-test/packages/contracts/src/index.js',
   import.meta.url).href` to `WORKSPACE_ENTRIES`, the matching
   `packages/contracts/dist/index.js` entry to `BUILT_PACKAGE_ENTRIES`, and
   `'@opengsd'` to `WORKSPACE_SCOPES`. Verify the subpath-resolution loop
   below handles `@opengsd/contracts` after the scope addition; if it
   special-cases package names, extend it minimally for `contracts`.
3. Do NOT build `packages/contracts` as the fix, do NOT gitignore-track a
   dist artifact, and do NOT change any gate script or test — the fix is
   source redirection only, matching the existing convention.
4. At clean HEAD (no `packages/contracts/dist` present — delete it first if a
   previous build left one), re-run the full T001 baseline procedure and
   append a dated `## Re-run after T024 contracts redirect` section to
   `.project/plan/wave1-gate-baseline.md`: same four gates plus the
   fabricated-evidence probe, with commands, exit codes, verdicts, and a new
   `VERDICT: BASELINE ...` line for the re-run.
5. Compiled-tier spot check: run `pnpm run test:compile`, then run ONE
   compiled test file that transitively imports `@opengsd/contracts`
   (`node --import ./scripts/dist-test-resolve.mjs
   --experimental-test-isolation=process --test
   dist-test/src/tests/prompt-golden-fixtures.test.js`) and record the
   result in the same baseline-doc section.
6. If any gate is still RED for reasons OTHER than the contracts module
   resolution, do NOT fix those failures in this task — record them in the
   baseline doc, mark the task's Log `BLOCKED — true baseline red: <gates>`,
   and stop the wave; the plan re-baselines before T005 starts.

## Acceptance criteria

1. Both resolve hooks redirect `@opengsd/contracts` to source (strip-types
   tier) and to `dist-test/` (compiled tier); no other behavior of either
   hook changes.
2. With `packages/contracts/dist` absent, `pnpm run baseline:refactor:gate`,
   `pnpm run baseline:refactor:phase0`, and
   `pnpm run gate:semantic-shadow-no-cutover` all execute their full test
   bodies (no `ERR_MODULE_NOT_FOUND`) — and pass, or the task is marked
   BLOCKED with the true failure list.
3. The baseline doc carries the re-run section with per-gate exit codes and
   a new verdict line; the compiled-tier spot check is recorded.
4. `legacy:cleanup:gate` still fails honestly (ENOENT) on a missing
   telemetry file — no fabricated green.

## Verify

```bash
grep -q "@opengsd/contracts" src/resources/extensions/gsd/tests/dist-redirect.mjs && grep -q "contracts" scripts/dist-test-resolve.mjs && grep -q "@opengsd" scripts/dist-test-resolve.mjs && grep -q "## Re-run after T024" .project/plan/wave1-gate-baseline.md && pnpm run baseline:refactor:gate && pnpm run gate:semantic-shadow-no-cutover
```

## Log

- 2026-08-02 — created by planner (Defect A repair: gates unrunnable at clean HEAD, `@opengsd/contracts` never redirected to source)
- 2026-08-02 — coder: redirect implemented in both tiers (`dist-redirect.mjs` exact + `dist/index.js` + subpath branches; `dist-test-resolve.mjs` WORKSPACE_ENTRIES/BUILT_PACKAGE_ENTRIES `'contracts'`, `'@opengsd'` scope, exact-match branch in `resolveWorkspaceSubpath`). Contracts `ERR_MODULE_NOT_FOUND` eliminated: baseline:refactor:gate now runs 34 tests (33 pass), semantic-shadow behavioral witnesses 2/15 → 14/15, compiled-tier `@opengsd/contracts` import verified resolving. Baseline re-run appended to `.project/plan/wave1-gate-baseline.md` (## Re-run after T024). Verify: greps pass, gate leg exit 1. BLOCKED — true baseline red: baseline:refactor:gate (prompt-golden Phase-2 reduction assertion 9454/15400 < 40%), baseline:refactor:phase0 (embedded gate), gate:semantic-shadow-no-cutover (`discard` witness — @gsd/native projection-root identity locking unavailable). Not fixed per step 6; plan re-baselines before T005.
- 2026-08-02 — orchestrator: Verify rejected (gate leg exit 1 — pre-existing reds unrelated to the contracts redirect). Rejected diff recorded: paths {scripts/dist-test-resolve.mjs, src/resources/extensions/gsd/tests/dist-redirect.mjs, .project/plan/wave1-gate-baseline.md, .project/tasks/T024-gate-unblock-contracts-redirect.md}, diff hash bcd8b5561655c8e99b311241f7c2adcd380ec808. All rejected changes task-owned; worktree and branch retired. Plan defect: T024 Verify bundled the gate re-run leg, which cannot pass while the true baseline is red — plan repair splits the redirect task from the re-baseline task (T025) before retry.
