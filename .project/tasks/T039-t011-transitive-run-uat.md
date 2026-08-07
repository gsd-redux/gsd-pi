---
id: T039
title: Reseed the two transitively-reached run-uat tests T011 broke
wave: 3
deps: [T011, T038]
status: done
agent: build_T039
commit: 385952914e065509dcaece0adec296783e8316d8
base: 5d92f1a453292af2c6db4fdfb7cbca4ca1fc6d14
worktree: .worktrees/gsd-path-T039
task_branch: gsd-path/T039
files:
  - src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts
  - src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts
---

# T039 — The two T011 failures no sweep could find

## Context

Fix task from wave-3 review cycle 4 (`.project/review/wave-3.cycle4.md`). These
fail under `test:unit:compiled`, which no task Verify and no review cycle ever
ran. Both attributed to T011 by single-file swap (replacing only
`auto-prompts.ts` with its `a27f96189^` content turns them green):

- `dispatch-run-uat-browser-tools.test.ts` — "run-uat browser preflight uses
  registered tools when the active surface is scoped"
- `run-uat-replay-cap.test.ts` — "run-uat dispatch stops after three attempts
  without a verdict"

Why four sweeps missed them: **both import only `auto-dispatch.ts`**, a
transitive consumer of `auto-prompts.ts`. A direct-importer sweep cannot see
them, and the reviewer's own 29-file symbol sweep did not either.

This is the same class T034/T038 already repaired successfully: markdown-only
fixtures against DB-only reads. `auto-prompts.ts` is NOT in your files and both
prior tasks proved it byte-unchanged — this is a fixture gap.

## Steps

1. Read the cycle-4 review section for these two files.
2. Reseed each fixture with DB rows encoding what its markdown already declares,
   following the pattern T038 used in `integration/run-uat.test.ts`.
3. Do not invert or delete. Both are live dispatch guards — one covers browser
   preflight tool scoping, the other the three-attempt replay cap.
4. Watch for the silent form: a test that goes green because a candidate list is
   empty is not repaired. T038 found four such tests hiding behind the same
   symptom.

## Acceptance criteria

1. Both files fully green.
2. Each repaired test proven failable by mutating `auto-prompts.ts` (or
   `auto-dispatch.ts`); Log records the exact mutation per test.
3. `auto-prompts.ts` byte-unchanged — state its hash before and after.
4. No assertion weakened; test counts unchanged or higher.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts src/resources/extensions/gsd/tests/uat-dispatch.test.ts
```

## Log

- 2026-08-07 — created by planner from wave-3 review cycle 4
- 2026-08-07 — coder. Reproduced both failures first: `dispatch-run-uat-browser-tools.test.ts:80`
  `undefined !== 'stop'` and `run-uat-replay-cap.test.ts:55` `undefined !== 'dispatch'`
  (6 pass / 2 fail across the Verify set).

  **Diagnosis.** Both fixtures were markdown-only. Post-cutover the dispatch gate has
  *no* markdown path left: `auto-dispatch.ts:916-921` calls
  `uat-dispatch.checkNeedsRunUat(basePath, mid, prefs, await loadRoadmapCompletedSliceCandidates(...))`,
  and `auto-prompts.ts:1676-1687` now reads `getMilestoneSlices(mid)` DB rows —
  it returns `[]` when no DB is open, so *both* the authoritative and the
  fallback argument were empty and the rule returned `null`. Fixture gap, not a
  product defect.

  **Fix (fixture-only, additive).** Both files: import
  `{ closeDatabase, insertMilestone, insertSlice, isDbAvailable, openDatabase }`
  from `../gsd-db.ts`, add a `seedSliceRows()` helper that opens `:memory:` and
  inserts the milestone plus the slice rows the fixture's ROADMAP already
  declares (S01 `complete`, S02 `pending` `depends:[S01]`), call it from the
  scaffold, and `closeDatabase()` in teardown (`t.after` / `finally`). No
  assertion added, removed, weakened, or reworded; test counts unchanged
  (3 in these two files, 8 across the Verify set).

  **Failability — four mutations, each applied to `auto-dispatch.ts`, run, then
  reverted (`git hash-object` back to `981706481d94f0e421aee94fbfcc884891a39914`
  after every one).**

  | # | Mutation | Result |
  |---|---|---|
  | M1 | `:922` `if (!needsRunUat) return null;` → `if (!needsRunUat \|\| true) return null;` | **both RED** (1 pass / 2 fail) |
  | M2 | `:943` `registeredTools,` → `registeredTools: undefined,` in the `getUatBrowserToolSupportError` call | **browser-tools RED only** (2 pass / 1 fail) |
  | M3 | `:965` `if (attempts >= MAX_UAT_ATTEMPTS) {` → `if (false && attempts >= MAX_UAT_ATTEMPTS) {` | **replay-cap RED only** (2 pass / 1 fail) |
  | M4 | `:923` `const { sliceId, uatType } = needsRunUat;` → `const { uatType } = needsRunUat; const sliceId = "S99";` | **both RED** (1 pass / 2 fail) |

  So each test has a mutation that kills it *alone* and pins its own subject —
  M2 the browser-tool preflight contract, M3 the three-attempt cap — plus M1/M4
  covering the shared dispatch path.

  **Not vacuous.** The failure mode this task warns about is a test that passes
  because a candidate list is empty. That cannot be what happened here: both
  tests assert *positive* outcomes (`'dispatch'` / `'stop'` with a specific
  reason and `unitId` `M001/S01`), and an empty candidate list is exactly what
  made them RED. M4 is the asymmetric probe — it changes nothing unless a
  candidate is actually found and flows through as `S01`, and it turns both RED,
  proving the seeded rows are load-bearing rather than decorative.

  **Byte-identity.** `auto-prompts.ts` untouched: blob
  `29af5990cee6d025b334fc40b46bf9fe87b14756` (sha256
  `5c344a642629ce69a20cf55fa67e08862b1a05e6e56edfa7222248ff67c1c6b2`) before and
  after — matching the review's required `29af5990c…`. `auto-dispatch.ts` blob
  `981706481d94f0e421aee94fbfcc884891a39914` before and after all four mutations.
  `git status --porcelain` shows only the two test files plus this task file.

  **Verify** —
  `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts src/resources/extensions/gsd/tests/uat-dispatch.test.ts`
  → `tests 8 / suites 0 / pass 8 / fail 0 / cancelled 0 / skipped 0 / todo 0`,
  **exit 0**.

  Note for the orchestrator: the pre-existing "stale native addon" warning
  (`@opengsd/engine-darwin-arm64` lacks `SqliteFileIdentityLock` /
  `ProjectionRootIdentityLock`) prints on every run here and is unrelated to
  this task — see the review's Process finding on `build:native:test`.
- 2026-08-07 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
