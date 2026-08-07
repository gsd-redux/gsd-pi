---
id: T038
title: Reseed the four auto-prompts test files T011 broke, including the file cycle 3 missed
wave: 3
deps: [T011, T030, T034]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts
  - src/resources/extensions/gsd/tests/integration/run-uat.test.ts
  - src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts
  - src/resources/extensions/gsd/tests/right-sized-workflow-prompts.test.ts
---

# T038 — Reseed the auto-prompts residue (14 RED tests)

## Context

Fix task from wave-3 review cycle 3 (`.project/review/wave-3.cycle3.md`).
**These are RED on the branch and the branch is CI-red.** They escaped three
review cycles because no task Verify named them and `test:unit:compiled`'s glob
does not reach `src/.../tests/integration/`.

Cycle 3 identified three of these files. An orchestrator sweep of all 39 in-repo
test files importing a T011-touched module then found a FOURTH the review
missed: `right-sized-workflow-prompts.test.ts`, 1 RED —
"complete-milestone prompt does not trust pass validation missing current
summary coverage" (`:176`), which asserts the prompt contains
`/Validation Requires Attention/`. That is a safety guard against trusting a
`pass` validation lacking summary coverage, and it would have shipped broken.

Verbatim from the review for the three it did find:

> `prompt-budget-enforcement.test.ts` — 5 RED in the `prompt-budget:
> inlineDependencySummaries truncation` describe block: `:108`, `:120`, `:138`,
> `:155`, `:187` (#4435 12-dep cap). Cause: `inlineDependencySummaries`
> (`auto-prompts.ts:1061-1080`) now sources `depends` from `getSlice(mid, sid)`
> only and returns `"- (no dependencies)"` when there is no DB row; the fixture
> (`setupDependencyFixture`) writes only a ROADMAP with `depends:[S01]`.

> `integration/run-uat.test.ts` — 6 RED: `:388` (m) non-artifact UAT skip, `:595`
> (r) no ASSESSMENT still dispatches, `:642` (s) ASSESSMENT without verdict does
> not skip, `:691` (t) browser-observable final-slice UAT dispatches with
> `uat_dispatch` off, `:839` (x) runtime-executable promotion, `:913` (x2)
> browser-executable stays unpromoted. All import `checkNeedsRunUat` from
> `../../auto-prompts.ts` and all use markdown-only fixtures, so
> `loadRoadmapCompletedSliceCandidates` returns `[]` and the wrapper yields
> `null`. **These are live dispatch guards**, including "human-experience UAT
> pause".

## Steps

1. Read the cycle-3 review sections for these files in full.
2. Reseed every failing fixture with DB rows so each test asserts its ORIGINAL
   subject and its original expected value. Follow the pattern T034 established
   in `reassess-detection.test.ts` / `uat-dispatch.test.ts`.
3. Do NOT invert or delete these tests. The run-uat six are live dispatch
   guards (human-experience UAT pause, browser-observable final-slice UAT); the
   right-sized one is a validation-trust guard. Losing them silently is the
   defect this wave has now produced six times.
4. `auto-prompts.ts` is NOT in your files and must not change — T034 established
   this class is a fixture problem, not a product defect, and proved
   `auto-prompts.ts` byte-identical. If you find a genuine product defect,
   block and say so rather than widening scope.
5. Watch for tests that become vacuous rather than green: an assertion that
   holds regardless of behaviour is not a repair.

## Acceptance criteria

1. All four files are fully green.
2. Every repaired test is proven failable by mutating `auto-prompts.ts`; the Log
   records the exact mutation used per test, as T034 did.
3. No test is inverted or deleted; each still asserts its original subject.
4. `auto-prompts.ts` is byte-unchanged — state its hash before and after.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts src/resources/extensions/gsd/tests/integration/run-uat.test.ts src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts src/resources/extensions/gsd/tests/right-sized-workflow-prompts.test.ts
```

## Log

- 2026-08-07 — created by planner from wave-3 review cycle 3, plus a 39-file orchestrator sweep that found right-sized-workflow-prompts.test.ts, which the review missed
