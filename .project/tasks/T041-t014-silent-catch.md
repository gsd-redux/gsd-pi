---
id: T041
title: Replace the ten silent catch blocks T014 added to commands-maintenance
wave: 3
deps: [T014, T032]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/commands-maintenance.ts
---

# T041 — Ten silent catches on the new restore path

## Context

Fix task from wave-3 review cycle 4 (`.project/review/wave-3.cycle4.md`).
`silent-catch-diagnostics.test.ts` — "no empty catch blocks remain in migrated
files" / "workflow-logger coverage (#3348)" — is RED under
`test:unit:compiled`. All ten offending lines blame to `ef879f79b` (T014); the
file is green at `ef879f79b^`.

Several of the ten are on the **new backup-restore path** T014 shipped — the
rollback mechanism the ADR-046 downgrade window requires. A restore that
swallows its own failures silently is the worst place in this milestone to have
one.

Why no sweep found it: `silent-catch-diagnostics.test.ts` **imports nothing from
the product**. It scans the filesystem for the pattern, so no import-based sweep
at any depth could reach it. This is the clearest evidence for the ruling that
wave 3 closes on a gate run rather than another inspection cycle.

**Explicitly forbidden fix:** adding `commands-maintenance.ts` to
`EXEMPT_FILES`. That weakens the invariant rather than satisfying it, and the
invariant is protected by an INTENT veto. If you believe an exemption is the
only correct answer, BLOCK and say why — do not take it.

## Steps

1. Read the cycle-4 review section for this file, then run the diagnostic test
   to get the exact ten line numbers.
2. Replace each empty/silent `catch` with a `logWarning` (or the established
   workflow-logger call for that file) naming what failed and what the
   consequence is. Match the surrounding conventions — the file was already
   migrated to the workflow logger, so follow how its other catches report.
3. Where a catch is genuinely best-effort and the swallow is correct, the
   repo's convention is an explanatory comment; a bare swallow with no comment
   is what the diagnostic flags. Prefer logging on the restore path regardless —
   a silent failure there loses user data.
4. Do not change control flow or add new dependencies.

## Acceptance criteria

1. `silent-catch-diagnostics.test.ts` fully green with no `EXEMPT_FILES` change.
2. Every restore-path catch reports its failure through the logger.
3. `backup-restore-command.test.ts` and `db-restore-backup-routing.test.ts` stay
   green — the fix must not alter restore behaviour.

## Verify

```bash
! git diff --name-only | grep -q EXEMPT && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/silent-catch-diagnostics.test.ts src/resources/extensions/gsd/tests/backup-restore-command.test.ts src/resources/extensions/gsd/tests/db-restore-backup-routing.test.ts
```

## Log

- 2026-08-07 — created by planner from wave-3 review cycle 4
