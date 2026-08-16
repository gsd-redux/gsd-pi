---
id: T023
title: Milestone closeout — full gate suite green at the cutover commit; status docs updated
wave: 4
deps: [T017, T018, T019, T020, T021, T022]
status: done
agent: null
commit: null
base: 75397cca5
worktree: null
task_branch: fix/wave-4-legacy-path-deletion
files:
  - docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md
  - CONTEXT.md
  - docs/dev/state-db-cutover-milestone-decision.md
---

# T023 — Milestone closeout

## Context

The milestone is done when: project state is DB-authoritative on the live
path (single-writer and derive-state-db tests pass against the real runtime
path); the no-cutover gate is retired with every invariant re-homed;
`legacy:cleanup:gate`/`legacy:cleanup:evidence` pass green on real
evidence; the legacy filesystem-state read/write path is deleted (not just
bypassed); and `baseline:refactor:gate`, the full unit suite, and
`pnpm run verify:pr` are green at the cutover commit with verify:pr
unweakened (strengthened — it now includes
`gate:lifecycle-shadow-no-cutover`). This task proves all of it in one run
and updates the status docs. It changes no production code.

## Steps

1. At the wave-4 head commit, run in order and record every verdict:
   - `pnpm run verify:pr`
   - `pnpm run baseline:refactor:gate`
   - `pnpm run baseline:refactor:phase0`
   - `pnpm run gate:lifecycle-shadow-no-cutover`
   - fresh-telemetry `pnpm run legacy:cleanup:evidence --file <path>` then
     `pnpm run legacy:cleanup:gate --file <path>`
   - `node scripts/legacy-state-path-proof.mjs`
2. Update `docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md`:
   append a dated closeout section stating the state-DB cutover milestone
   shipped, the gate split-retirement (old gate →
   `gate:lifecycle-shadow-no-cutover`), the evidence-gated deletions, and
   the remaining deferred items (canonical lifecycle read-authority cutover
   under M003/D005; Phase 5 DB split; separately sequenced product cleanup — all explicitly
   OUT of this milestone per INTENT vetoes).
3. Update `CONTEXT.md` (canonical context doc per `docs/agents/domain.md`):
   state layer is DB-authoritative; files are stamped read-only
   projections; the projection contract doc
   (`docs/dev/state-db-cutover-projection-contract.md`) is the reference
   for external readers; the backup-restore command exists for downgrade
   recovery.
4. Append the closeout verdicts (step 1 commands + results) to
   `docs/dev/state-db-cutover-milestone-decision.md` under a
   `## Closeout evidence` section.

## Acceptance criteria

1. Every command in step 1 is green at the closeout commit and recorded in
   the decision doc.
2. The plan-of-plans closeout section exists and names the deferred
   out-of-scope items explicitly.
3. CONTEXT.md reflects DB-authoritative reality and points at the
   projection contract.
4. No production code changes in this task.

## Verify

```bash
grep -q "## Closeout evidence" docs/dev/state-db-cutover-milestone-decision.md && grep -qi "gate:lifecycle-shadow-no-cutover" docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md && grep -qi "state-db-cutover-projection-contract" CONTEXT.md && pnpm run verify:pr && pnpm run gate:lifecycle-shadow-no-cutover
```

## Log

- 2026-08-01 — created by planner
- 2026-08-12 — closeout docs written (plan-of-plans, CONTEXT.md, decision-doc Closeout evidence). Timebox waiver recorded. `baseline:refactor:gate` 34/34 PASS; `baseline:refactor:phase0` 140/140 PASS; `gate:lifecycle-shadow-no-cutover` 7/7+11/11 PASS; legacy evidence+gate PASS; proof PASS; `verify:fast` PASS.
