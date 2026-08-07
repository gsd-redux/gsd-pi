---
id: T037
title: Reseed the workspace-index contract tests T011 broke
wave: 3
deps: [T011]
status: done
agent: build_T037
commit: 97f49b67f45f9888f0950c4c9ec93074963ea1ce
base: 0c202c67eb5968ed9a872fbded416e12e3d86f15
worktree: .worktrees/gsd-path-T037
task_branch: gsd-path/T037
files:
  - src/tests/integration/web-state-surfaces-contract.test.ts
---

# T037 — Reseed the web-state-surfaces contract tests

## Context

Fix task from wave-3 review cycle 3 (`.project/review/wave-3.cycle3.md`).
**These tests are RED on the branch and the branch is CI-red** — CI's
`test:integration` job (ci.yml:246) runs `src/tests/integration/*.test.ts`,
while `test:unit:compiled`'s flat glob (`dist-test/src/tests/*.test.js`) does
not, which is why three review cycles missed them. Verbatim:

> `src/tests/integration/web-state-surfaces-contract.test.ts:37` "indexWorkspace
> extracts risk, depends, and demo from roadmap" and `:90` "indexWorkspace
> handles slices without risk/depends/demo" — `TypeError: Cannot read properties
> of undefined (reading 'id' / 'risk')` at `:80` / `:113`, because
> `index.milestones[0].slices[0]` is undefined. Cause: `workspace-index.ts`
> `indexSlice` (`:88-104`) now populates `tasks` only from `getSliceTasks` under
> `isDbAvailable()`; the markdown fallback (`parsePlan`) was deleted by T011.
> **Attribution proved by single-file swap:** replacing only `workspace-index.ts`
> with its `a27f96189^` content turns both tests green (16/16); restoring T011's
> version turns them red again (14/16).

The reviewer's guidance on the reseed shape:

> Same reseed for `indexWorkspace` (`insertMilestone` + `insertSlice` +
> `insertTask` T01), keeping the risk/depends/demo assertions — those still come
> from the roadmap projection via `roadmapMeta`, only `slice.tasks` moved to the
> DB.

## Steps

1. Read the cycle-3 review section for this file in full.
2. Reseed both fixtures with DB rows (`insertMilestone` + `insertSlice` +
   `insertTask`), following the pattern T034 used in
   `reassess-detection.test.ts`.
3. Keep the risk/depends/demo assertions exactly as they are — those values
   still come from the roadmap projection via `roadmapMeta`; only `slice.tasks`
   moved to the DB. Do not weaken them to accommodate the reseed.
4. `workspace-index.ts` is NOT in your files and must not change. If you find a
   genuine product defect there rather than a fixture gap, block and say so.

## Acceptance criteria

1. `web-state-surfaces-contract.test.ts` is fully green.
2. Both repaired tests are proven failable by mutating `workspace-index.ts`;
   record the exact mutation used for each in the Log, as T034 did.
3. The risk/depends/demo assertions are unchanged in substance.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-state-surfaces-contract.test.ts src/tests/integration/web-subprocess-module-resolution.test.ts
```

## Log

- 2026-08-07 — created by planner from wave-3 review cycle 3
- 2026-08-07 — coder build_T037.

  **Implementation** (`src/tests/integration/web-state-surfaces-contract.test.ts`
  only; `workspace-index.ts` byte-unchanged, verified with `git diff --stat`):
  added a lazy `gsd-db.ts` import (`openDatabase`, `closeDatabase`,
  `insertMilestone`, `insertSlice`, `insertTask`, `isDbAvailable`) with a header
  comment stating why the fixtures now seed rows, and reseeded both
  `indexWorkspace` fixtures the way T034 reseeded `reassess-detection.test.ts`:

  - Test `:37` — `openDatabase(":memory:")` + `insertMilestone(M001)` +
    `insertSlice(S01, status "pending", risk "high", depends ["S00"],
    demo "users can see the dashboard")` + `insertTask(T01, status "pending")`.
    The markdown ROADMAP/PLAN/T01-PLAN files are kept unchanged — they still
    supply the milestone title and the artifact paths.
  - Test `:90` — same shape with `insertSlice(S01, status "complete",
    risk "low", depends [], demo "")` and no task row.
  - Both tests close the DB in `t.after` so the later files-API and store tests
    in the same file still run with no DB open.
  - Risk/depends/demo assertions are unchanged in substance (`high` / `["S00"]`
    / `"users can see the dashboard"`, and `low` / `[]` / `""`). Only the stale
    inline comment "Parser defaults risk to low…" was reworded, since the values
    now reach `roadmapMeta` from the slice row rather than the roadmap parser.

  **Failability proof** — each mutation applied to
  `src/resources/extensions/gsd/workspace-index.ts`, test file re-run, then the
  file restored from a pre-mutation copy (final `git diff` on it is empty):

  1. `indexSlice:93` `if (isDbAvailable()) {` → `if (false && isDbAvailable()) {`
     → **`:37` RED** (`slice.tasks.length` 0 ≠ 1), `:90` green. 15 pass / 1 fail.
  2. `indexWorkspace:141` `done: s.status === "complete"` → `done: false`
     → **`:90` RED** (`slice.done` false ≠ true), `:37` green. 15 pass / 1 fail.
  3. `indexSlice:116` `depends: roadmapMeta?.depends,` → `depends: [],`
     → **`:37` RED** (`slice.depends` [] ≠ ["S00"]), `:90` green. 15 pass / 1 fail.
  4. `indexSlice:115` `risk: roadmapMeta?.risk,` → `risk: "medium",`
     → **both RED** (`:37` high, `:90` low). 14 pass / 2 fail.

  Mutations 1+3 pin test `:37`; 2+4 pin test `:90`; 4 additionally proves the
  risk pass-through is live in both. No product defect found in
  `workspace-index.ts` — this was a pure fixture gap from the T011 cutover.

  **Verify** (`node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs
  --experimental-strip-types --test src/tests/integration/web-state-surfaces-contract.test.ts
  src/tests/integration/web-subprocess-module-resolution.test.ts`):
  `tests 27 / pass 27 / fail 0 / skipped 0` (was 16 tests, 14 pass, 2 fail for
  the contract file alone before the fix).
- 2026-08-07 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
