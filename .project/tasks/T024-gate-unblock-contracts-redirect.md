---
id: T024
title: Redirect @opengsd/contracts to source in both test tiers so the gates' full test bodies execute at clean HEAD
wave: 2
deps: []
status: done
agent: build_T024
commit: 35c4157ab747907ca11f7384a7b16bc1d054b4d8
base: ff77ea38a9b1552746ab923c66ea92ba1ef62d89
worktree: .worktrees/gsd-path-T024
task_branch: gsd-path/T024-retry
files:
  - src/resources/extensions/gsd/tests/dist-redirect.mjs
  - scripts/dist-test-resolve.mjs
  - .project/plan/wave1-gate-baseline.md
---

# T024 — @opengsd/contracts source redirect (retry: redirect ONLY, no gate-green leg)

## Context

T001's baseline re-run (`.project/plan/wave1-gate-baseline.md`, VERDICT:
BASELINE RED) found that `baseline:refactor:gate`, `baseline:refactor:phase0`,
and `gate:semantic-shadow-no-cutover` all fail at clean HEAD with
`ERR_MODULE_NOT_FOUND: @opengsd/contracts/dist/index.js` (imported from
`src/resources/extensions/gsd/workflow-tool-surface.ts`). Root cause:
`packages/contracts` is NOT redirected to source by
`src/resources/extensions/gsd/tests/dist-redirect.mjs` (the strip-types tier),
its `dist/` is not gitignored so it is never present at clean HEAD, and
nothing in the gate procedure builds it. The compiled test tier has the same
gap: `scripts/dist-test-resolve.mjs` maps workspace packages into `dist-test/`
via `WORKSPACE_ENTRIES` + `WORKSPACE_SCOPES` — neither covers
`@opengsd/contracts`. `scripts/compile-tests.mjs` already compiles
`packages/*/src/` into `dist-test/`, so no build-step change is needed — only
the two resolve hooks. This task is the redirect ONLY. Its Verify proves the
contracts module error is eliminated and the previously-dead tests/witnesses
EXECUTE — it does NOT require the gates to be green. Two pre-existing red
legs (prompt-golden Phase-2 reduction assertion; `discard` witness native
lock) survive this task by design and are owned by T025. The implementation
approach below is the one the blocked run validated (contracts
ERR_MODULE_NOT_FOUND eliminated; gate 34 tests running; witnesses 2/15 →
14/15 executing); the orchestrator retired that diff only because the old
Verify bundled the gate-green leg.

## Steps

1. In `src/resources/extensions/gsd/tests/dist-redirect.mjs`, add a redirect
   branch for `@opengsd/contracts` following the exact existing `@gsd/*`
   convention (see the `@gsd/pi-ai` exact + `dist/index.js` forms): map
   `@opengsd/contracts` and `@opengsd/contracts/dist/index.js` to
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
   handles `@opengsd/contracts` after the scope addition; if it special-cases
   package names, extend it minimally for `contracts`.
3. Do NOT build `packages/contracts` as the fix, do NOT gitignore-track a
   dist artifact, and do NOT change any gate script or test — the fix is
   source redirection only.
4. With `packages/contracts/dist` absent (delete it first if a previous build
   left one), run `pnpm run baseline:refactor:gate` and
   `pnpm run gate:semantic-shadow-no-cutover`. They will still exit non-zero
   (the two T025-owned red legs) — that is EXPECTED. Confirm instead: zero
   `ERR_MODULE_NOT_FOUND` in output, all 34 gate tests execute, and ≥14/15
   behavioral witnesses execute and pass (only the `discard` witness fails,
   native-lock cause, owned by T025).
5. Append a dated `## Re-run after T024 contracts redirect` section to
   `.project/plan/wave1-gate-baseline.md`: per-gate command, exit code, what
   now EXECUTES that previously did not, and the two surviving red legs
   explicitly assigned to T025. No new VERDICT line — the final green
   verdict belongs to T025's own evidence doc.
6. Compiled-tier spot check: run `pnpm run test:compile`, then
   `node --import ./scripts/dist-test-resolve.mjs
   --experimental-test-isolation=process --test
   dist-test/src/tests/prompt-golden-fixtures.test.js`; record in the same
   doc section that the compiled tier resolves `@opengsd/contracts` (the
   Phase-2 assertion outcome is T025's concern, not this task's).

## Acceptance criteria

1. Both resolve hooks redirect `@opengsd/contracts` (strip-types tier to
   source, compiled tier to `dist-test/`); no other behavior of either hook
   changes.
2. With `packages/contracts/dist` absent, `baseline:refactor:gate` executes
   all 34 tests and `gate:semantic-shadow-no-cutover` executes all 15
   behavioral witnesses — zero `ERR_MODULE_NOT_FOUND` anywhere.
3. The baseline doc's re-run section records execution evidence and assigns
   the two surviving red legs to T025; the compiled-tier spot check is
   recorded.
4. This task does NOT modify the prompt-golden fixtures, any prompt builder,
   any native file, any gate script, or package.json — those are T025/T009
   scope.

## Verify

```bash
grep -q "@opengsd/contracts" src/resources/extensions/gsd/tests/dist-redirect.mjs && grep -q "contracts" scripts/dist-test-resolve.mjs && grep -q "@opengsd" scripts/dist-test-resolve.mjs && grep -q "## Re-run after T024" .project/plan/wave1-gate-baseline.md && OUT=$(pnpm run baseline:refactor:gate 2>&1); ! echo "$OUT" | grep -q "ERR_MODULE_NOT_FOUND" && echo "$OUT" | grep -q "prompt golden fixtures meet Phase 2 reduction gate" && OUT2=$(pnpm run gate:semantic-shadow-no-cutover 2>&1); ! echo "$OUT2" | grep -q "ERR_MODULE_NOT_FOUND" && echo "$OUT2" | grep -qE "Behavioral: 1[0-9]/15"
```

## Log

- 2026-08-02 — created by planner (Defect A repair: gates unrunnable at clean HEAD, `@opengsd/contracts` never redirected to source)
- 2026-08-02 — coder: redirect implemented in both tiers (`dist-redirect.mjs` exact + `dist/index.js` + subpath branches; `dist-test-resolve.mjs` WORKSPACE_ENTRIES/BUILT_PACKAGE_ENTRIES `'contracts'`, `'@opengsd'` scope, exact-match branch in `resolveWorkspaceSubpath`). Contracts `ERR_MODULE_NOT_FOUND` eliminated: baseline:refactor:gate now runs 34 tests (33 pass), semantic-shadow behavioral witnesses 2/15 → 14/15, compiled-tier `@opengsd/contracts` import verified resolving. Baseline re-run appended to `.project/plan/wave1-gate-baseline.md` (## Re-run after T024). Verify: greps pass, gate leg exit 1. BLOCKED — true baseline red: baseline:refactor:gate (prompt-golden Phase-2 reduction assertion 9454/15400 < 40%), baseline:refactor:phase0 (embedded gate), gate:semantic-shadow-no-cutover (`discard` witness — @gsd/native projection-root identity locking unavailable). Not fixed per step 6; plan re-baselines before T005.
- 2026-08-02 — orchestrator: Verify rejected (gate leg exit 1 — pre-existing reds unrelated to the contracts redirect). Rejected diff recorded: paths {scripts/dist-test-resolve.mjs, src/resources/extensions/gsd/tests/dist-redirect.mjs, .project/plan/wave1-gate-baseline.md, .project/tasks/T024-gate-unblock-contracts-redirect.md}, diff hash bcd8b5561655c8e99b311241f7c2adcd380ec808. All rejected changes task-owned; worktree and branch retired. Plan defect: T024 Verify bundled the gate re-run leg, which cannot pass while the true baseline is red — plan repair splits the redirect task from the re-baseline task (T025) before retry.
- 2026-08-02 — planner (repair): T024 re-scoped to the redirect ONLY per the split; the two surviving red legs move to new task T025. The previously validated implementation approach is preserved verbatim in steps 1-2 for the retry. Frontmatter reset to pending/null for re-dispatch.
- 2026-08-02 — coder (retry): redirect-only implementation re-applied exactly as validated in the blocked run. `dist-redirect.mjs`: `@opengsd/contracts` exact + `dist/index.js` forms → `packages/contracts/src/index.ts`, subpath branch mirroring the pi-ai pattern. `dist-test-resolve.mjs`: `'contracts'` added to WORKSPACE_ENTRIES (`dist-test/packages/contracts/src/index.js`) and BUILT_PACKAGE_ENTRIES (`packages/contracts/dist/index.js`), `'@opengsd'` added to WORKSPACE_SCOPES, exact-match branch (`contracts` + `contracts/dist/index.js`) added in `resolveWorkspaceSubpath`. With `packages/contracts/dist` absent: baseline:refactor:gate exit 1, zero ERR_MODULE_NOT_FOUND, 34/34 tests execute (33 pass; only prompt-golden Phase-2 reduction assertion fails — T025); gate:semantic-shadow-no-cutover exit 1, zero ERR_MODULE_NOT_FOUND, Structural 8/8, Behavioral 14/15 (only `discard` witness fails, native-lock cause — T025). Compiled-tier spot check: test:compile OK, `@opengsd/contracts` resolves from dist-test (all exports returned); prompt-golden compiled file executes 3 tests (2 fail on a pre-existing, unrelated native `dist-test/packages/native/dist` gap; Phase-2 outcome owned by T025). Re-run evidence appended to `.project/plan/wave1-gate-baseline.md` (## Re-run after T024 contracts redirect), surviving red legs explicitly assigned to T025, no new VERDICT line. Verify: PASS (greps + both gate legs exactly as specified).
