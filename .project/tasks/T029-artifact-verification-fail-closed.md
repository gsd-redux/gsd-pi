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

## Acceptance criteria

1. No branch in `artifact-verification.ts` returns a verify-PASS on the basis of
   markdown content when the DB is unavailable or a required row is absent.
2. Every DB-unavailable path in the file either fails closed with a `recovery`
   warning or is a content-validation parse that makes no authority judgment.
3. Two new witnesses cover the `execute-task` and closeout-proof branches;
   `recovery-verify-logs.test.ts` and `integration/idle-recovery.test.ts` stay
   green with no test count regression.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/recovery-verify-logs.test.ts src/resources/extensions/gsd/tests/integration/idle-recovery.test.ts src/resources/extensions/gsd/tests/auto-recovery.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (T010 AC2 failure)
