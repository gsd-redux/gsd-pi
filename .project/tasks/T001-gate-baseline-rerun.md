---
id: T001
title: Re-run all four gates at clean HEAD and record evidence
wave: 1
deps: []
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
