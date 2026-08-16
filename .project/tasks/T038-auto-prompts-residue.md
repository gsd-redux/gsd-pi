---
id: T038
title: Reseed the four auto-prompts test files T011 broke, including the file cycle 3 missed
wave: 3
deps: [T011, T030, T034]
status: done
agent: build_T038
commit: 75c07cdbc27fbda7f3c52b2189993ed513817c37
base: 0c202c67eb5968ed9a872fbded416e12e3d86f15
worktree: .worktrees/gsd-path-T038
task_branch: gsd-path/T038
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

- 2026-08-07 — coder (build_T038). **Fixture-only repair; `auto-prompts.ts` byte-unchanged.**

  **auto-prompts.ts hash (AC4):** blob `29af5990cee6d025b334fc40b46bf9fe87b14756`
  **before** and **after**, and re-verified after every mutation probe below
  (each probe restored from a pristine copy and re-hashed; all seven printed
  `restored ok`). `git status` shows only the four test files plus this task
  file. No product defect found — the review's diagnosis holds: T011 moved the
  source of truth to the DB and these fixtures were markdown-only.

  **Baseline measured here:** 79 tests / 65 pass / **14 fail** / 0 skipped —
  exactly the 14 the brief names. After: 79 / **79 pass** / 0 fail / 0 skipped.
  Test count is identical before and after, so **nothing was deleted**, and no
  expected value was flipped — every repaired test still asserts its original
  subject and its original expected value (AC3).

  ### What changed (per file)

  1. `prompt-budget-enforcement.test.ts` — added `seedSliceRows(mid, sid, deps)`
     and called it from `setupDependencyFixture` after the ROADMAP write, so the
     `depends` edge the roadmap encodes (S02→S01, S03→S01+S02, S13→12 deps) now
     exists as DB rows, which is where `inlineDependencySummaries` reads it
     (`auto-prompts.ts:1061-1080`). `cleanup()` now closes the DB.
  2. `integration/run-uat.test.ts` — added `seedSliceRows(mid, slices)` and
     called it in all **eight** `checkNeedsRunUat` tests (the six RED ones plus
     (n) and (q), which were passing *vacuously* — they expect `null` and got it
     only because the wrapper found no candidates). S01 `complete`, S02 `pending`
     for the two-slice fixtures; single `complete` S01 for the M001/M007/M008
     final-slice fixtures. `cleanup()` now closes the DB.
  3. `complete-milestone-excerpt.test.ts` — added `seedRoadmapSlices(base)`
     (S01+S02, both `complete`, matching `makeRoadmap()`), called from the three
     tests that write `makeRoadmap()` + both fat summaries. `cleanup()` now
     closes the DB. The file's existing gate tests already seeded rows; this
     follows their `openDatabase(join(base, ".gsd", "gsd.db"))` pattern.
  4. `right-sized-workflow-prompts.test.ts` — `writeCompleteMilestoneFiles` now
     seeds M001/S01, because the closer derives *which artifacts a validation
     receipt must cover* from the DB slice list. Without the row, S01's SUMMARY
     was not a "current artifact", so every coverage check passed vacuously —
     that is why the one guard asserting a **negative** ("Validation Requires
     Attention") was the only RED one and the two positives stayed green.
     Added `cleanupRepo()` to close the DB before `rmSync`.

  ### Failability proof (AC2) — mutations of `auto-prompts.ts`, each applied to a pristine copy and reverted

  | # | Mutation on `auto-prompts.ts` | Tests turned RED |
  |---|---|---|
  | A | `inlineDependencySummaries` (`:1071`) `depends = slice.depends as string[]` → `depends = []` | prompt-budget: "passes through all content…", "truncates at section boundaries…", "returns content unchanged…", "handles multiple dependency summaries…", "caps 12 cumulative dep summaries (#4435)" — **5/5 of the RED set** (24/29) |
  | A2 | `inlineDependencySummaries` (`:1070`) disable `if (slice.depends.length === 0) return "- (no dependencies)"` | prompt-budget: "returns no-dependencies marker when slice has no deps" (28/29) |
  | C1 | `checkNeedsRunUat` wrapper (`:1695-1707`) body → `return null` | run-uat **(m), (r), (s), (t), (x), (x2)** — **all 6 of the RED set** (23/29) |
  | C2 | same wrapper → always `return { sliceId: "S01", uatType: "artifact-driven" }` | run-uat (m), **(n)**, **(q)**, (t), (x), (x2) (23/29) |
  | D | `buildCompleteMilestonePrompt` (`:3297`) **and** `buildValidateMilestonePrompt` (`:3498`) `.filter(s => s.status !== "skipped")` → `.filter(() => false)` (reproduces T011's own change) | complete-milestone-excerpt: "#4780 closer prompt…", "validate-milestone prompt uses slice excerpts…", plus the pre-existing "…Q3/Q4 gate flags"; right-sized: **"complete-milestone prompt does not trust pass validation missing current summary coverage"** (17/21) |
  | E | `isValidationFreshOrApplicable` (`:302`) `size === 0` → `size >= 0` (always false) | right-sized: "trusts passing validation artifact", "trusts centralized markdown body pass verdict" (9/11) |
  | G | `buildSliceSummaryExcerpt` (`:892`) → inline the full summary instead of an excerpt | complete-milestone-excerpt: the three `#4780 excerpt:` unit tests + "#4780 closer prompt…" + "validate-milestone prompt uses slice excerpts…" (5/10) |

  Union of C1 ∪ C2 kills **all eight** `checkNeedsRunUat` tests, so the two that
  were silently vacuous now discriminate too. Every one of the 14 originally-RED
  tests appears in at least one row above.

  ### Disclosed, not fixed (out of this task's mandate)

  `complete-milestone-excerpt.test.ts` "complete-milestone prompt caps repeated
  inlined context around 20k chars" is **unfailable**, and was unfailable at the
  review base as well — it was never in the RED set. Probed with mutation F
  (`capPreamble` → `return preamble`, i.e. the cap removed entirely): 10/10 still
  pass. Mutation G (full summaries instead of excerpts) also leaves it green.
  Reason: the closer keeps `M001-CONTEXT.md` and `KNOWLEDGE.md` **on-demand**, so
  the fat bodies the fixture writes are never inlined and the measured slice is
  ~7K against a 21K bound. Not a T011 surface (`capPreamble` is untouched by
  T011) and not one of the 14, so I left it alone rather than widen scope; my
  reseed strictly *increases* what it measures (two summary excerpts that were
  previously absent). Recording it so closeout does not count the 20K cap as
  covered.

  ### Verify — exact result

  ```
  $ node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
      --experimental-strip-types --test \
      src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts \
      src/resources/extensions/gsd/tests/integration/run-uat.test.ts \
      src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts \
      src/resources/extensions/gsd/tests/right-sized-workflow-prompts.test.ts
  ℹ tests 79
  ℹ suites 14
  ℹ pass 79
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  exit 0
  ```

  Per-file, run standalone: prompt-budget 29/29, run-uat 29/29,
  complete-milestone-excerpt 10/10, right-sized 11/11.
  `npx tsc -p tsconfig.test.json --noEmit --incremental false` reports zero
  diagnostics for all four files.
- 2026-08-07 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
