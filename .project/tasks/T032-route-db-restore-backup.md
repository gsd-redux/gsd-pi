---
id: T032
title: Route the shipped backup-restore command so /gsd db restore-backup is reachable
wave: 3
deps: [T014]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
