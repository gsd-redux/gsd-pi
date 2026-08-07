---
id: T035
title: Fix the help-menu coverage regression from the db subcommand registration
wave: 3
deps: [T032]
status: in-progress
agent: build_T035
commit: null
base: 274430a457936ca0d4cece15dc2f92359e2d7816
worktree: .worktrees/gsd-path-T035
task_branch: gsd-path/T035
files:
  - src/resources/extensions/gsd/commands/core.ts
  - src/resources/extensions/gsd/tests/help-menu-coverage.test.ts
---

# T035 — Register `db` in the help menu

## Context

Fix task from wave-3 review cycle 2 (`.project/review/wave-3.cycle2.md`, T032
section). Verbatim:

> **T032 regression** — adding `db` to `TOP_LEVEL_SUBCOMMANDS` broke
> `help-menu-coverage.test.ts` (help text is built from a different catalog in
> `core.ts`, outside T032's `files`). One line fixes it.

T032 correctly registered the command in `catalog.ts`, but the help text is
assembled from a second, separate list in `core.ts`. The coverage test asserts
the two agree, so registering in one and not the other fails it. T032 could not
have fixed this — `core.ts` was outside its declared `files`.

## Steps

1. Add the `db` entry to the help-text catalog in `core.ts`, matching the
   wording and shape of sibling maintenance commands (`rebuild`, `recover`).
2. Confirm `help-menu-coverage.test.ts` passes without weakening its assertion.
   If the test needs updating rather than the source, say so explicitly in the
   Log with the reason.

## Acceptance criteria

1. `help-menu-coverage.test.ts` is green with its coverage assertion intact.
2. `/gsd help` lists `db` alongside the other maintenance subcommands.
3. The catalog registration T032 landed is unchanged.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/help-menu-coverage.test.ts src/resources/extensions/gsd/tests/db-restore-backup-routing.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 2 (T032 regression)
