---
id: T032
title: Route the shipped backup-restore command so /gsd db restore-backup is reachable
wave: 3
deps: [T014]
status: done
agent: build_T032
commit: 8928a909be702e4a407ce4c56f51248335d78719
base: ac2717d34ed47a0170d8f1c767eea555daeb2fb9
worktree: .worktrees/gsd-path-T032
task_branch: gsd-path/T032
files:
  - src/resources/extensions/gsd/commands/handlers/ops.ts
  - src/resources/extensions/gsd/commands/catalog.ts
  - src/resources/extensions/gsd/tests/db-restore-backup-routing.test.ts
---

# T032 — Make the backup-restore command reachable

## Context

Fix task from wave-3 review cycle 1 (`.project/review/wave-3.cycle1.md`, T014
section). Verbatim failed criterion:

> ❌ AC1 — confirmed: `handleDbRestoreBackup` has no route in `ops.ts`, no entry
> in `catalog.ts`, and no `db` command family exists. `/gsd db restore-backup` is
> unreachable. Plan defect (both files outside `files`), criterion unmet either way.

T014 shipped `handleDbRestoreBackup` at `commands-maintenance.ts:1483` and its
own tests, but `commands/handlers/ops.ts` and `commands/catalog.ts` were outside
its declared `files`, so the coder correctly stayed in scope and the command
shipped unreachable by a user. This matters beyond tidiness: the explicit
backup-restore command is REQUIRED to ship in this milestone by the ADR-046
downgrade-window ruling (2 stable releases + ≥60 days), because backup-restore
is the rollback mechanism for a destructive migration. An unreachable command
does not satisfy that ruling.

## Steps

1. `ops.ts`: add a route for `db restore-backup` dispatching to
   `handleDbRestoreBackup`, following the exact shape of the adjacent `recover`
   and `rebuild` routes (trimmed-prefix match, argument remainder passed
   through).
2. `catalog.ts`: register the command so it is discoverable, matching how
   sibling maintenance commands are registered. If no `db` family exists,
   introduce it in the established pattern rather than inventing a new one.
3. Add a routing test asserting `/gsd db restore-backup` reaches the handler and
   that the no-candidates path surfaces its informational message.

## Acceptance criteria

1. `handleOpsCommand("db restore-backup", ...)` returns handled and invokes
   `handleDbRestoreBackup`.
2. The command appears in the catalog alongside sibling maintenance commands.
3. The routing test fails if the route is removed.

## Verify

```bash
grep -q "handleDbRestoreBackup" src/resources/extensions/gsd/commands/handlers/ops.ts && grep -q "restore-backup" src/resources/extensions/gsd/commands/catalog.ts && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-restore-backup-routing.test.ts src/resources/extensions/gsd/tests/backup-restore-command.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 1 (T014 AC1 failure)
- 2026-08-06 — coder: `ops.ts` now imports `handleDbRestoreBackup` from
  `commands-maintenance.js` and dispatches `db restore-backup` (exact + trimmed
  prefix, remainder passed through) in the same shape as the adjacent
  `recover`/`rebuild`/`sync` arms, placed just before `sync`. `catalog.ts` adds
  `db` to `GSD_COMMAND_DESCRIPTION`, a `{ cmd: "db", ... }` entry beside
  `rebuild` in `TOP_LEVEL_SUBCOMMANDS`, and a `db` → `restore-backup`
  `NESTED_COMPLETIONS` family. New `tests/db-restore-backup-routing.test.ts`
  covers: the route returns handled and produces the handler's no-candidates
  informational message; the argument remainder survives the prefix trim
  (`--backup … --list` hits the mutually-exclusive refusal); `db-restore-backup`
  is still unclaimed; and the catalog/nested-completion registration.
  Verify (exact): `tests 8 / pass 8 / fail 0` — 4 routing + 4 pre-existing
  `backup-restore-command.test.ts`; both greps matched; exit 0.
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
