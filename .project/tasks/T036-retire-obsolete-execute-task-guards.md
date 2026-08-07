---
id: T036
title: Retire the obsolete execute-task checkbox and sibling-dir guards made unfailable by DB authority
wave: 3
deps: [T029]
status: in-progress
agent: build_T036
commit: null
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
