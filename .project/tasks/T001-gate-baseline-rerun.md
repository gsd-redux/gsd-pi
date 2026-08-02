---
id: T001
title: Re-run all four gates at clean HEAD and record evidence
wave: 1
deps: []
status: done
agent: build_T001
commit: ecd912871c690d8fdf3c19c358ed1e076e18f3c2
base: 254f51d046caa5863956f350210749b6daab680c
worktree: .worktrees/gsd-path-T001
task_branch: gsd-path/T001
files:
  - .project/plan/wave1-gate-baseline.md
---

# T001 — Re-run all four gates at clean HEAD and record evidence

## Context

Every green claim for the refactor gates is 2026-05-04 vintage, doc-claimed in
`docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md`, and never re-run
at current HEAD (`ade9db0e4` per `.project/research/evidence-codebase.md`). The
whole milestone plan assumes a green baseline that is unverified. This task
produces the ground-truth record. TypeScript tests run via Node's strip-types
hook: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs
--experimental-strip-types --test <file>` — replicate that invocation exactly
for any direct test run. This task changes no production code.

## Steps

1. `git status --porcelain` must be empty; record `git rev-parse HEAD`.
2. Run `pnpm install --frozen-lockfile --ignore-scripts`, then run each gate
   and capture the exact command, exit code, and salient output:
   - `pnpm run baseline:refactor:gate`
   - `pnpm run baseline:refactor:phase0`
   - `pnpm run gate:semantic-shadow-no-cutover`
   - `pnpm run legacy:cleanup:gate --file "$TMPFILE"` with
     `TMPFILE=$(mktemp -u)` (a path guaranteed not to exist) — record whether
     it passes, fails, or fabricates a green result. Also run
     `pnpm run legacy:cleanup:evidence --file "$TMPFILE2"` against a second
     nonexistent path and record whether it fabricates an all-zero report
     (pitfalls evidence says `ensureTelemetryReport` in
     `scripts/legacy-cleanup-evidence.mjs` fabricates all-zero counters on
     ENOENT; verify this is still true at HEAD).
3. Write `.project/plan/wave1-gate-baseline.md` containing: HEAD SHA, date,
   per-gate command, exit code, pass/fail verdict, a short excerpt of any
   failure output, and an explicit `VERDICT: BASELINE GREEN` or
   `VERDICT: BASELINE RED — <gate names>` line. If RED, name the failing
   gate(s) and stop the wave: the plan re-baselines before wave 2.

## Acceptance criteria

1. `.project/plan/wave1-gate-baseline.md` exists and records command, exit
   code, and verdict for all four gates plus the fabricated-evidence check.
2. The file contains exactly one `VERDICT: BASELINE ...` line.
3. No production source file is modified (the task diff touches only
   `.project/plan/wave1-gate-baseline.md`).

## Verify

```bash
grep -q "baseline:refactor:gate" .project/plan/wave1-gate-baseline.md && grep -q "baseline:refactor:phase0" .project/plan/wave1-gate-baseline.md && grep -q "gate:semantic-shadow-no-cutover" .project/plan/wave1-gate-baseline.md && grep -q "legacy:cleanup:gate" .project/plan/wave1-gate-baseline.md && grep -qE "VERDICT: BASELINE (GREEN|RED)" .project/plan/wave1-gate-baseline.md
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — coder: re-ran all four gates at clean HEAD `254f51d046caa5863956f350210749b6daab680c` after `pnpm install --frozen-lockfile --ignore-scripts`; wrote `.project/plan/wave1-gate-baseline.md`. Results: `baseline:refactor:gate` FAIL (exit 1, 32/34 tests; 2 prompt-golden-fixture tests die on `ERR_MODULE_NOT_FOUND @opengsd/contracts/dist/index.js`); `baseline:refactor:phase0` FAIL (exit 1, embedded gate fails first, phase-0 tests never ran); `gate:semantic-shadow-no-cutover` FAIL (exit 1, structural 8/8 PASS, behavioral 2/15 — all 13 witness failures confirmed to share the same contracts-dist root cause by running one witness directly); `legacy:cleanup:gate --file <nonexistent>` exits 1 with raw ENOENT (honest, no fabricated green); `legacy:cleanup:evidence --file <nonexistent>` exits 1 — all-zero fabrication path still exists in code (`ensureTelemetryReport`, scripts/legacy-cleanup-evidence.mjs:73-87) but was not reached because the default evidence command failed first. VERDICT: BASELINE RED — the three failing gates all trace to `@opengsd/contracts` lacking a built `dist` at clean HEAD (not gitignored; not redirected by `dist-redirect.mjs`). Whether the baseline is otherwise green is undetermined; plan should build contracts or extend dist-redirect, then re-baseline before wave 2. Verify: PASS (grep chain exit 0; exactly one `VERDICT: BASELINE` line; `git status --porcelain` shows only the new baseline file). No production source modified; no git mutations performed.
