---
id: T037
title: Reseed the workspace-index contract tests T011 broke
wave: 3
deps: [T011]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
