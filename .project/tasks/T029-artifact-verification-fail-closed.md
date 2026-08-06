---
id: T029
title: Close the two surviving fail-open DB-unavailable branches in artifact-verification
wave: 3
deps: [T010]
status: in-progress
agent: build_T029
commit: null
base: ac2717d34ed47a0170d8f1c767eea555daeb2fb9
worktree: .worktrees/gsd-path-T029
task_branch: gsd-path/T029
files:
  - src/resources/extensions/gsd/artifact-verification.ts
  - src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts
  - src/resources/extensions/gsd/tests/integration/idle-recovery.test.ts
  - src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/integration/auto-recovery.test.ts
---

# T029 — Fail-closed the two branches T010 missed

## Context

Fix task from wave-3 review cycle 1 (`.project/review/wave-3.cycle1.md`, T010
section). T010 closed two fail-open DB-unavailable branches; the reviewer found
two more still live in the same file. Verbatim failed criterion:

> ❌ AC2 "No markdown-fallback branch remains in reactive-graph or
> artifact-verification" — found: two live markdown-fallback branches survive in
> `src/resources/extensions/gsd/artifact-verification.ts`, and **both return a
> verify-PASS when the DB is unavailable** — the exact defect class AC5 and
> SYNTHESIS clause (c) exist to close:
> 1. `artifact-verification.ts:524-528` (`execute-task`): accepts a `PLAN.md`
>    `- [x] **T0N:` checkbox as task completion (helper `:156-165`).
> 2. `artifact-verification.ts:566-568`: turns a failed closeout proof into a
>    pass from markdown SUMMARY content.

The file now carries two fail-closed and two fail-open DB-unavailable branches
side by side, which is incoherent as well as wrong. SYNTHESIS clause (c) keeps
DB-unavailable fail-closed witnesses in the unit tier; a deleted or bypassed
fallback must never convert a verify-fail into a verify-pass.

## Steps

1. Read the T010 section of `.project/review/wave-3.cycle1.md` in full before
   editing — it names both sites and the exact permissive outcome of each.
2. `:524-528` (`execute-task`) and its `:156-165` checkbox helper: replace the
   markdown-checkbox acceptance with the same explicit fail-closed shape T010
   used at complete-slice and parallel-research — `logWarning("recovery", ...)`
   naming DB unavailability, then `return false`. Delete the helper if it has no
   other caller; leave it if it does.
3. `:566-568`: a failed closeout proof must stay failed. Remove the
   SUMMARY-content rescue and fail closed with a recovery warning.
4. Add a DB-unavailable witness for each of the two branches, matching the shape
   of the witnesses T010 established (fixture base with no gsd.db; assert
   `false` plus a `recovery` log naming why). Do not weaken or delete existing
   witnesses.

5. The three newly-listed test files. An orchestrator sweep ran 24 test files
   touching these surfaces against your implementation: 21 green, 3 red. That
   is the complete remaining blast radius — measured, not inferred. Six failing
   tests, and the dispositions DIFFER. Do not blanket-invert:
   - `verify-artifact-tightened.test.ts` — "#3607: execute-task legacy branch —
     checked checkbox [x] passes verification" and its "[X] (uppercase)" twin:
     **INVERT**. Both open with `closeDatabase()` and
     `assert.equal(isDbAvailable(), false, "DB must be closed to hit legacy
     branch")`, then assert the checkbox passes. They exist to pin the legacy
     branch you deleted. Assert `false` plus a `recovery` warning, and rename
     them so the titles stop claiming a pass.
   - `verify-artifact-tightened.test.ts` — "#1500: execute-task accepts SUMMARY
     in stale sibling flat-phase dir": **RESEED**. Its real subject is
     sibling-flat-phase-dir SUMMARY resolution — a genuine regression guard —
     which it happens to reach through the deleted checkbox branch. Seed a DB
     task row so the same sibling-dir assertion still runs and still returns
     `true`. Inverting it would silently drop the #1500 protection.
   - `auto-recovery.test.ts` — "complete-milestone passes with impl files
     (#1703)" and "complete-milestone passes on main retry with milestone
     implementation commits (#4699)", and the #1703 twin in
     `integration/auto-recovery.test.ts`: **RESEED**. These assert that real
     implementation evidence is honored; the fixtures simply have no DB. Seed a
     complete DB milestone row so they still return `true`. Do not invert them —
     the invariant they protect is still correct under DB authority.

## Acceptance criteria

1. No branch in `artifact-verification.ts` returns a verify-PASS on the basis of
   markdown content when the DB is unavailable or a required row is absent.
2. Every DB-unavailable path in the file either fails closed with a `recovery`
   warning or is a content-validation parse that makes no authority judgment.
3. Two new witnesses cover the `execute-task` and closeout-proof branches;
   `recovery-verify-logs.test.ts` and `integration/idle-recovery.test.ts` stay
   green with no test count regression.
4. All three newly-listed files are green, with the two #3607 tests inverted
   and #1500/#1703/#4699 reseeded rather than inverted — no regression guard is
   lost to a deletion.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts src/resources/extensions/gsd/tests/integration/idle-recovery.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts src/resources/extensions/gsd/tests/integration/auto-recovery.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (T010 AC2 failure)
- 2026-08-06 — coder: implemented both fail-closed conversions in
  `artifact-verification.ts`.
  1. `execute-task` (was `:524-528`): deleted the
     `hasLegacyCheckedTaskCompletion` branch and its now-callerless helper plus
     the file-local `escapeRegExp` (verified repo-wide: no other caller — the
     other `escapeRegExp` definitions are separate file-local copies). Replaced
     with `logWarning("recovery", "verify-fail execute-task <id>: <DB
     unavailable | no settled Task Attempt in the DB>, cannot confirm task
     completion")` + `return false`, matching the complete-slice shape T010
     landed at `:541-550`.
  2. `complete-milestone` (was `:566-568`): deleted the SUMMARY-content rescue.
     Any `!closeoutProof.ok` now logs
     `verify-fail complete-milestone <id>: closeout proof failed (<reason>)[,
     DB unavailable], cannot confirm milestone closeout` and returns false.
     Dropped the two imports that rescue was the sole consumer of
     (`classifyMilestoneSummaryContent`, `hasImplementationArtifacts`);
     `auto-recovery.ts` re-exports `hasImplementationArtifacts` straight from
     `milestone-implementation-evidence.js`, so no public surface changed.
  Added two DB-unavailable witnesses to `recovery-verify-logs.test.ts`
  (fixture base with no `gsd.db`; each asserts `false` plus the `recovery`
  warning): one seeds a PLAN with `- [x] **T01:` + a `T01-SUMMARY.md` and
  proves the checkbox no longer verifies; one seeds a success-looking
  `M001-SUMMARY.md` and proves the failed closeout proof stays failed. No
  existing witness weakened or deleted; `integration/idle-recovery.test.ts`
  needed no change (its execute-task/complete-slice cases already assert
  `false`).
- 2026-08-06 — coder Verify (exact result):
  `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts src/resources/extensions/gsd/tests/integration/idle-recovery.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts`
  → `tests 126 / pass 124 / fail 2 / skipped 0`.
  Both new witnesses pass. `recovery-verify-logs.test.ts` (16/16) and
  `integration/idle-recovery.test.ts` (24/24) are fully green.
  The two failures are both in `src/resources/extensions/gsd/tests/auto-recovery.test.ts`:
  - `:2049` "verifyExpectedArtifact complete-milestone passes with impl files (#1703)"
  - `:2068` "verifyExpectedArtifact complete-milestone passes on main retry with
    milestone implementation commits (#4699)"
- 2026-08-06 — coder: **BLOCKED (plan defect — unlisted path required)**.
  Both failing tests seed a git base with a SUMMARY + implementation commits and
  **no `gsd.db`**, then assert `verifyExpectedArtifact("complete-milestone", …)
  === true`. That `true` was produced by exactly the `:566-568` escape this task
  requires deleted — they are the "pre-existing test elsewhere asserting a silent
  pass as intended behaviour" the brief names. They cannot pass under acceptance
  criterion 1 and must be inverted (assert `false` + a `recovery` warning naming
  the failed closeout proof), which the wave-3 review also prescribed
  ("invert/re-express every test that pins the old behaviour").
  `src/resources/extensions/gsd/tests/auto-recovery.test.ts` is in this task's
  Verify command but **not** in its `files` frontmatter, so the coder contract
  forbids the edit. Production changes and the two new witnesses are left in
  place; the task needs `auto-recovery.test.ts` added to `files` (or a sibling
  fix task owning it) to reach green.
- 2026-08-06 — planner (block repair): block accepted and upheld. The contract
  was defective in the way this milestone keeps repeating — `auto-recovery.test.ts`
  was in the Verify command but not in `files`, an authoring error by the
  orchestrator, not the coder. Rather than patch forward on the two failures the
  coder happened to hit, swept 24 test files touching artifact-verification /
  auto-recovery / verifyExpectedArtifact against this worktree's implementation:
  21 green, 3 red, 6 failing tests. TWO of the three red files were invisible to
  the coder because its Verify never ran them. files += verify-artifact-tightened
  .test.ts, auto-recovery.test.ts, integration/auto-recovery.test.ts; new Step 5
  records the per-test disposition; AC4 added; Verify extended to the full set.
  Worktree RETAINED with its implementation — the diff is in scope and both
  intended conversions are correct.
  Note for the reviewer: this is now the FOURTH distinct place in this repo where
  a silent verify-pass was pinned as an asserted invariant (idle-recovery
  "lenient", T013's forged-stamp no-drift test, and the two #3607 legacy-branch
  tests). All were green before the cutover touched them.
