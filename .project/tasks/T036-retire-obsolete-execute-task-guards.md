---
id: T036
title: Retire the obsolete execute-task checkbox and sibling-dir guards made unfailable by DB authority
wave: 3
deps: [T029]
status: done
agent: build_T036
commit: b4c0bcfcb6c070e530011dbb02c6b13caad25e0d
base: 274430a457936ca0d4cece15dc2f92359e2d7816
worktree: .worktrees/gsd-path-T036
task_branch: gsd-path/T036
files:
  - src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts
  - src/resources/extensions/gsd/artifact-verification.ts
  - docs/dev/state-db-cutover-milestone-decision.md
---

# T036 — Retire what DB authority made obsolete, explicitly

## Context

Fix task from wave-3 review cycle 2 (`.project/review/wave-3.cycle2.md`, T029
AC4 / probe (a)). The reviewer confirmed the coder's report and found it worse
than described. Verbatim:

> **T029 AC4 — coverage-loss class (probe (a) confirmed and it is worse than
> reported).** DB-closed `execute-task` verification is now unconditionally
> `false`, so **six** tests in `verify-artifact-tightened.test.ts` cannot fail:
> the `#1500` reseed (probed tautological — deleting the stale SUMMARY leaves it
> green), the `#1500` foreign-milestone negative, and all four surviving `#3607`
> negatives. Nothing in the repo tests checkbox discrimination any more, and
> `allowSiblingTeamSuffixProjections` is dead.

USER RULING 2026-08-06: retire the obsolete guards explicitly. Rationale
recorded at decision time: under DB authority a settled Attempt record IS the
completion fact, so SUMMARY-file path resolution is a projection concern rather
than a verification input. The alternative — adding a filesystem artifact-
existence check back alongside the DB check — was rejected as reintroducing a
markdown read into a path the cutover deliberately made DB-authoritative. The
consequence is accepted and must be recorded, not hidden: execute-task no longer
fails when a settled attempt's SUMMARY file is absent.

A test that cannot fail is worse than no test: it reads as protection that is
not there. This wave has now hit that pattern five times.

## Steps

1. Read the T029 section of cycle 2 in full, including probe (a).
2. Delete the six unfailable tests in `verify-artifact-tightened.test.ts` — the
   `#1500` reseed, the `#1500` foreign-milestone negative, and the four
   surviving `#3607` negatives. Do not leave a weakened stand-in. Any test you
   keep in that file must be able to fail; verify by mutation, not by reading.
3. Delete `allowSiblingTeamSuffixProjections` and any now-callerless helpers it
   used, confirming repo-wide there is no other caller before removing.
4. Record the retirement in `docs/dev/state-db-cutover-milestone-decision.md`
   under `## Accepted residual risks`: name #1500 and #3607, state that
   execute-task no longer verifies SUMMARY presence or checkbox state, give the
   reason (DB Attempt record is authoritative), and note the behaviour a user
   would observe — a settled attempt with a deleted SUMMARY now verifies true.

## Acceptance criteria

1. No test in `verify-artifact-tightened.test.ts` is unfailable; each surviving
   test is shown to fail under a mutation of its subject, and the Log records
   which mutation was used for each.
2. `allowSiblingTeamSuffixProjections` and its dead helpers are gone; no
   callers remain.
3. The milestone decision doc records the #1500/#3607 retirement, the reason,
   and the observable behaviour change.
4. No production behaviour changes in this task beyond dead-code removal.

## Verify

```bash
! grep -rn "allowSiblingTeamSuffixProjections" src/resources/extensions/gsd/ && grep -q "#1500" docs/dev/state-db-cutover-milestone-decision.md && grep -q "#3607" docs/dev/state-db-cutover-milestone-decision.md && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 2 (T029 AC4 / probe a); user ruled explicit retirement over restoring a filesystem check

- 2026-08-06 — coder (build_T036).

  **Deleted (6 unfailable tests)** in `verify-artifact-tightened.test.ts`: the four
  `#3607` negatives (unchecked `[ ]`, bare heading, missing plan, wrong task id),
  the `#1500` stale-sibling reseed, and the `#1500` foreign-milestone negative.
  All six went through `verifyExpectedArtifact("execute-task", …)`, whose result
  no longer depends on any file on disk. No weakened stand-ins were left; two
  short comment blocks record what was removed and why, at the sites. The file
  header (which still asserted "only a checked checkbox counts as evidence") was
  rewritten to state the DB-authoritative behaviour and what the file now covers.
  The now-callerless `seedSettledTaskAttempt` helper and its four imports
  (`_getAdapter`, `claimTaskAttempt`, `settleTaskAttempt`,
  `internalExecutionInvocation`) went with it. 17 tests → 11.

  **Dead code removed** in `artifact-verification.ts`: the
  `allowSiblingTeamSuffixProjections` const (`:375`), the
  `allowTeamSuffixProjections` parameter of `findExistingSiblingPhaseArtifact`
  and its `matchesFallback` arm, both call sites' third argument, and the
  now-unused `milestoneIdUniqueSuffix` import. Confirmed repo-wide before
  removing that `milestoneIdUniqueSuffix` (gsd-db.ts, paths.ts) and
  `phaseDirMatchesMilestoneId`'s own team-suffix parameter (paths.ts:778) have
  live callers elsewhere, so those stay. No production behaviour change: the
  parameter defaulted to `false` and was only ever set true for `execute-task`,
  which returns before path resolution (DB open) or fails closed (DB closed).

  **Mutation proof — every surviving test shown to actually fail.** Each mutation
  was applied to `artifact-verification.ts`, the file re-run, then the file
  restored byte-identical (verified with `diff`). Result per test:

  | Surviving test | Mutation that turns it RED |
  |---|---|
  | `execute-task … checked checkbox [x] fails closed` | M1: execute-task fail-closed block `return false` → `return true` |
  | `execute-task … checked checkbox [X] (uppercase) also fails closed` | M1 |
  | `execute-task DB branch ignores checked plan and summary without an Attempt Result` | M2: `readExecuteTaskArtifactReadiness(...) !== null` → unconditional `true` |
  | `execute-task DB branch ignores legacy complete Task status without an Attempt Result` | M2 |
  | `execute-task DB lag branch — summary without checked plan still fails` | M2 |
  | `#1500: plan-milestone does NOT borrow a roadmap from a team-suffix sibling projection` | M3: re-enable team-suffix matching (`phaseDirMatchesMilestoneId(..., true)`) in `findExistingSiblingPhaseArtifact` — this is the exact fallback deleted by this task, so the guard is real and pinned |
  | `#852: discuss-milestone falls back to project root when CONTEXT not in worktree` | M4: disable the worktree→project-root fallback block |
  | `#852: discuss-milestone passes when CONTEXT is in the worktree` | M6: terminal `return true` → `return false` |
  | `#852: discuss-milestone fails when CONTEXT is in neither worktree nor project root` | M7: `!absPath` branch `return false` → `return true` (M5, the `existsSync false` branch, does NOT reach it — this fixture exits at the null-path branch, so a targeted mutation was needed) |
  | `#870: … base IS the canonical-layout worktree` | M4 |
  | `#870: … base is the legacy-layout worktree` | M4 |

  M5 (`existsSync false` → `return true`) additionally turns the `#1500`
  plan-milestone test RED, giving it two independent kills.

  **Decision doc**: added `## Accepted residual risks` → `### R5 — execute-task no
  longer verifies SUMMARY presence or checkbox state (#1500, #3607)`, naming both
  issues, the reason (a settled Attempt record IS the completion fact under
  ADR-017; the rejected alternative and why), and the user-observable consequence
  stated plainly: **a settled attempt whose SUMMARY file has been deleted now
  verifies true**, and auto mode will not re-dispatch to regenerate it. Counts
  updated ("Four" → "Five"; the downgrade-window sentence now scopes R1–R4, which
  is where it was accurate).

  **Verify** — exact command from this task, exit `0`:
  `! grep -rn allowSiblingTeamSuffixProjections … && grep -q "#1500" … && grep -q "#3607" … && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test verify-artifact-tightened.test.ts auto-recovery.test.ts`
  → `tests 97 / pass 97 / fail 0 / skipped 0` (11 in verify-artifact-tightened,
  86 in auto-recovery).

  Also ran `npx tsc -p tsconfig.extensions.json --noEmit --incremental false`:
  the only errors are pre-existing and environmental, in
  `tests/oauth-api-model-routing.test.ts` (missing `packages/pi-ai/dist`
  build output). Zero errors in either file this task touched.
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
