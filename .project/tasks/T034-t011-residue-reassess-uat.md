---
id: T034
title: Repair the reassess/UAT dispatch tests T011 broke and restore the #1112 cache-race guard
wave: 3
deps: [T011, T030]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/tests/reassess-detection.test.ts
  - src/resources/extensions/gsd/tests/uat-dispatch.test.ts
  - src/resources/extensions/gsd/auto-prompts.ts
---

# T034 — Repair the T011 residue (RED tests on the branch)

## Context

Fix task from wave-3 review cycle 2 (`.project/review/wave-3.cycle2.md`,
"T011 residue" section). **Three tests are RED on the branch right now.** This
was missed twice: T011's Verify never ran these files, and review cycle 1 marked
T011 AC3/AC4 pass without running them either. Verbatim:

> ❌ T011 AC3 and AC4 (suite green) — three tests are RED at review base, in two
> files neither T011 nor T030 listed:
> - `reassess-detection.test.ts:77` "checkNeedsReassessment returns sliceId when
>   assessment is missing" — `actual: null, expected: { sliceId: 'S01' }`.
> - `reassess-detection.test.ts:113` "checkNeedsReassessment detects assessment
>   written after initial cache population" — **the #1112 cache-race regression
>   guard** — `actual: null, expected: { sliceId: 'S01' }`.
> - `uat-dispatch.test.ts:118` "auto-prompts keeps the compatibility
>   checkNeedsRunUat wrapper" — `actual: null, expected: { sliceId: 'S01',
>   uatType: 'human-experience' }`.
> Attribution established by swapping `auto-prompts.ts` alone at three points:
> pre-wave-3 (`a27f96189^`) reassess 5/5 green, uat-dispatch 5/5 green;
> post-T011 / pre-T030 (`942d048d7`) reassess 3/5, uat-dispatch 4/5; review base
> identical to post-T011. So **T011 broke them and T030 neither fixed nor
> worsened them.** All three fixtures are markdown-only (`writeRoadmap` +
> `writeSummary`, no DB), so the removed roadmap-checkbox fallback is exactly
> what they asserted.
> Additionally the three still-green tests in `reassess-detection.test.ts`
> (`:60`, `:94`, `:141`) are now **vacuous** — they assert `null`.

## Steps

1. Read the "T011 residue" section of cycle 2 in full.
2. Reseed the three RED fixtures with DB rows so each still asserts its ORIGINAL
   subject and returns its original expected value. Do NOT invert them and do
   NOT delete them — these are live dispatch guards, not fallback pins.
   `:113` is the #1112 cache-race regression guard and must still exercise the
   race (assessment written AFTER initial cache population) under DB authority.
3. Fix the three vacuous tests at `:60`, `:94`, `:141`: an assertion of `null`
   that would hold no matter what the code does is not a guard. Either seed them
   so the assertion is meaningful, or assert the specific reason for `null`.
4. Only touch `auto-prompts.ts` if a genuine defect is found — e.g. if the cache
   is not invalidated when an assessment lands, the #1112 race is a real bug and
   not merely a fixture problem. Prefer fixture repair; state clearly in the Log
   which you concluded and why.

## Acceptance criteria

1. `reassess-detection.test.ts` and `uat-dispatch.test.ts` are fully green.
2. Every test in both files fails if its subject regresses — no test asserts a
   value that holds regardless of behaviour. Prove it: for each of the six
   affected tests, state in the Log what you changed and what now makes it fail.
3. The #1112 cache-race guard still exercises an assessment written after the
   cache is populated.
4. If `auto-prompts.ts` changed, the change is a defect fix with a stated
   rationale, not an accommodation to make a test pass.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/reassess-detection.test.ts src/resources/extensions/gsd/tests/uat-dispatch.test.ts src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 2 (T011 residue; RED on branch)
