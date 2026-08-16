---
id: T022
title: Delete _deriveStateImpl and legacy markdown-fallback remnants, gated on fail-closed evidence (timebox-gated)
wave: 4
deps: [T015, T016]
status: done
agent: null
commit: null
base: 75397cca5
worktree: null
task_branch: fix/wave-4-legacy-path-deletion
files:
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/tests/derive-state-db.test.ts
  - src/resources/extensions/gsd/tests/derive-state-helpers.test.ts
---

# T022 — Delete _deriveStateImpl and the legacy markdown fallback (TIMEBOX-GATED)

## Context

The first of the two final legacy filesystem-state code deletions — this
task runs BEFORE T020 in wave-4 layering. T007 made the fallback
unreachable on the live path; T016 left `gsd/state.ts` as the sole
remaining production importer of `parsers-legacy` (via `_deriveStateImpl`).
Deleting `_deriveStateImpl` here drops that last import, which is what
allows T020 to delete `parsers-legacy.ts` at zero production importers.
(The T016-version registry test will flag `gsd/state.ts` as a stale
allowlist entry between this task and T020 — expected; T020 rewrites the
registry into its zero-importer end-state in the next layer.) The deletion
is evidence-gated per the settled sequence: `legacy:cleanup:evidence`
(fail-closed, T015) → `legacy:cleanup:gate` → delete. This task MUST NOT
land before the ruled window elapses (2 stable releases + ≥60 days
post-cutover release).

## Steps

1. Confirm the window has elapsed; record release tags/dates in the Log.
   If not elapsed, STOP.
2. Run the evidence chain at the task commit and paste verdicts into the
   Log: `pnpm run legacy:cleanup:evidence --file <fresh telemetry path>`
   (produce fresh telemetry via the gate's own evidence commands first,
   per the T015 redesign), `node scripts/legacy-state-path-proof.mjs`,
   `pnpm run legacy:cleanup:gate --file <same path>`. All must be green
   with `_deriveStateImpl` still present EXCEPT the proof's known-offender
   entry for `state.ts` — then delete and re-run to full green. The point
   is the pipeline demonstrably blocks before and passes after.
3. Delete `_deriveStateImpl` from `state.ts` along with its
   `parsers-legacy` import and any now-dead private helpers used only by
   it (read the file; `state.ts:296-340` region). Keep every public
   re-export that other modules consume.
4. Update `tests/derive-state-db.test.ts` and
   `tests/derive-state-helpers.test.ts`: remove tests that exercised
   `_deriveStateImpl` directly (AGENTS.md: removing behavior removes its
   tests); keep DB-path coverage intact.
5. Re-run: `node scripts/legacy-state-path-proof.mjs` (zero offenders) and
   the derive test files above. Do NOT run `pnpm run test:unit` as this
   task's gate: the T016-version importer-registry test will now flag
   `gsd/state.ts` as a stale allowlist entry — expected, resolved by T020
   in the next wave-4 layer, which owns that file. The wave-level full
   build-and-test runs after T020.

## Acceptance criteria

1. `state.ts` contains no `_deriveStateImpl`, no `parsers-legacy` import,
   and no markdown-fallback branch.
2. The evidence chain (evidence → proof → gate) is green at the task
   commit, and the Log shows it blocked pre-deletion and passes
   post-deletion.
3. No test references `_deriveStateImpl`; DB-path test coverage is
   unchanged.
4. `pnpm run verify:pr` green; window-elapsed evidence recorded.

## Verify

```bash
! grep -n "_deriveStateImpl\|parsers-legacy" src/resources/extensions/gsd/state.ts && node scripts/legacy-state-path-proof.mjs && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-db.test.ts src/resources/extensions/gsd/tests/derive-state-helpers.test.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-12 — same timebox waiver as T020. Deleted `_deriveStateImpl` and the `parsers-legacy` import from `state.ts`. `getActiveMilestoneId` fail-closes when no DB is open. Proof was BLOCK before deletion (live-repo pin) and PASS after. Re-homed `getActiveMilestoneId skips parked` onto DB rows so the discard witness file stays green.
