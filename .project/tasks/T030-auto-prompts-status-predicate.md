---
id: T030
title: Fix the closed-status predicate in auto-prompts so run-uat and reassess still dispatch
wave: 3
deps: [T011]
status: done
agent: build_T030
commit: 9c0f6ab1fb59cf74e174e40ff831a428c813ce62
base: ac2717d34ed47a0170d8f1c767eea555daeb2fb9
worktree: .worktrees/gsd-path-T030
task_branch: gsd-path/T030
files:
  - src/resources/extensions/gsd/auto-prompts.ts
  - src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts
---

# T030 — Restore closed-status equivalence in auto-prompts

## Context

Fix task from wave-3 review cycle 1 (`.project/review/wave-3.cycle1.md`, T011
section). This is a live dispatch regression, not a display issue. Verbatim:

> ❌ AC2 "Display, index, prompt-context, and sync outputs are byte-identical for
> equivalent project state" — `auto-prompts.ts:1658-1669`
> `loadRoadmapCompletedSliceCandidates` replaced a roadmap-checkbox read with
> `getMilestoneSlices(mid).filter(s => s.status === "complete")`. These are **not**
> equivalent. The roadmap checkbox is rendered `[x]` by `markdown-renderer.ts:318`
> via `isClosedStatus(slice.status)`, whose closed set is
> `["complete", "done", "skipped", "closed"]` (`status-guards.ts:37`). `rowToSlice`
> does **not** normalise status on read (`db-task-slice-rows.ts:95`), and
> `status-guards.ts:30-36` states explicitly that `"done"`/`"closed"` still appear
> in real rows from older projects and imports. So on any migrated legacy project,
> a slice stored as `"done"` or `"closed"` was a UAT candidate before and is not now.
> This is not a display regression: the value flows
> `auto-dispatch.ts:920 → checkNeedsRunUat(...)`, and an empty/short candidate list
> makes `needsRunUat` null, so the `run-uat` unit is **never dispatched**.

The reviewer also folded in two related sites in the same file:

> fix: in `auto-prompts.ts:1666`, replace `slice.status === "complete"` with a
> closed-but-not-skipped predicate built from the shared guards
> (`isClosedStatus(slice.status) && slice.status !== "skipped"`, importing from
> `./status-guards.js`), or normalise via `toStatus()` first.
> Related, pre-existing and out of this commit's diff but the same predicate:
> `auto-prompts.ts:1637` (`checkNeedsReassessment`) filters `s.status === "complete"`
> too. Fold it into the same fix.
> Warning: `checkNeedsReassessment` (`auto-prompts.ts:1632-1654`) now returns `null`
> on a DB-unavailable project instead of falling back to roadmap checkboxes — i.e.
> the reassess-roadmap unit is silently never dispatched.

## Steps

1. Read the T011 section of the review in full.
2. Replace the raw `status === "complete"` comparisons at `:1666` and `:1637`
   with the shared closed-status guard, excluding `"skipped"` where a skipped
   slice must not be a candidate. Import from `./status-guards.js`; do not
   re-implement the closed set locally.
3. Make the DB-unavailable behaviour of `checkNeedsReassessment` explicit rather
   than an accidental `null`: either fail closed with a `recovery` warning or
   document in-code why `null` is correct. Do not reintroduce a markdown parse.
4. Add test cases seeding slice rows with status `"done"` and `"closed"` and
   asserting they are returned as candidates. The existing cases at `:109` and
   `:125` seed only `"complete"`, which is why this shipped.

## Acceptance criteria

1. Slices stored `"done"` or `"closed"` are treated as candidates exactly as the
   roadmap checkbox treated them; `"skipped"` is excluded where it was before.
2. Both `:1666` and `:1637` use the shared guard; no local closed-set literal.
3. New tests cover `"done"` and `"closed"` rows and fail if the predicate
   regresses to an equality check.

## Verify

```bash
grep -q "status-guards" src/resources/extensions/gsd/auto-prompts.ts && ! grep -nE 'status === "complete"' src/resources/extensions/gsd/auto-prompts.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (T011 AC2 failure)
- 2026-08-06 — coder: added `isCompletedSliceStatus()` in `auto-prompts.ts`
  (`isClosedStatus(status) && status !== "skipped"`, importing `isClosedStatus`
  from `./status-guards.js`; no local closed-set literal) and used it at both
  former equality sites — `loadRoadmapCompletedSliceCandidates` (was `:1666`)
  and `checkNeedsReassessment` (was `:1637`). The companion
  `hasIncomplete` check in `checkNeedsReassessment` now uses
  `!isClosedStatus(s.status)` so a fully-closed milestone containing a
  `skipped`/`done`/`closed` slice still short-circuits, matching the roadmap
  checkbox it replaced. Made the DB-unavailable path explicit: an early
  `if (!isDbAvailable()) return null;` with a comment stating why null is the
  sound answer (no markdown parse reintroduced); the surrounding try/catch now
  wraps the DB read directly.
- 2026-08-06 — coder: tests — added three cases to
  `tests/auto-prompts-fallback.test.ts`: legacy `done`/`closed` rows are
  returned as UAT candidates while `skipped` is excluded and reverse order is
  preserved; `checkNeedsReassessment` picks a `done` slice as last-completed;
  and it returns null when every slice is closed via legacy aliases. Each fails
  if the predicate regresses to `status === "complete"`.
- 2026-08-06 — Verify: `grep -q "status-guards" ... && ! grep -nE 'status === "complete"' ... && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts`
  → PASS: tests 10, pass 10, fail 0 (duration_ms 2171). (Unrelated pre-existing
  stderr notice about a stale `@opengsd/engine-darwin-arm64` addon.)
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
