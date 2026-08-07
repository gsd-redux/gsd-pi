---
id: T039
title: Reseed the two transitively-reached run-uat tests T011 broke
wave: 3
deps: [T011, T038]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
