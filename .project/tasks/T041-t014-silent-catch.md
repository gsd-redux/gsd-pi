---
id: T041
title: Replace the ten silent catch blocks T014 added to commands-maintenance
wave: 3
deps: [T014, T032]
status: done
agent: build_T041
commit: ddbfea14cdead2ecae0830fd2d28943199cafce0
base: 5d92f1a453292af2c6db4fdfb7cbca4ca1fc6d14
worktree: .worktrees/gsd-path-T041
task_branch: gsd-path/T041
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
- 2026-08-07 — coder (build_T041). Ran `silent-catch-diagnostics.test.ts` first to
  get the exact ten lines: 1228, 1230, 1250, 1252, 1459, 1463, 1464, 1465, 1500,
  1783 — all comment-only catch bodies (the test's AST check treats a
  comment-only block as empty, since comments are trivia and not Statement
  nodes). Replaced all ten with `logWarning("command", …)`, matching the file's
  existing convention (`logWarning("command", \`… failed: ${(e as Error).message}\`)`,
  e.g. `:42`, `:96`, `:1780`) rather than the review's suggested `"maintenance"`
  component, which is not a `LogComponent` — `"command"` is the enum member for
  "Slash command execution and maintenance". Each catch now binds the error and
  names what failed plus the consequence:
  - `:1228`/`:1250` — temp-descriptor close failure in
    `claimRestoreBackupIntent` / `rewriteRestoreBackupIntent` (leaked descriptor).
  - `:1230`/`:1252` — temp intent file left behind in the same two functions.
  - `:1459` — `reopenDatabaseAfterReplacement` failure in
    `executeRestoreBackupPlan`; logs `published` and states the replacement fence
    stays for the next run to converge.
  - `:1463`/`:1464`/`:1465` — pre-publication fence cleanup (active intent,
    staged candidate, recovery dir); each says the next run must converge it.
  - `:1500` — `realpathSync` of the project DB path; kept the "may not exist yet"
    rationale as a comment and logs the fallback to the unresolved path.
  - `:1783` — `closeDatabase()` failure after a restore failure.
  All eight restore-path catches now report through the logger. `logWarning`
  does not write to stderr (workflow-logger stderr policy: only `logError`
  does), so no TUI/stdout stream changed. No control flow changed — every
  `return`/`throw`/fallthrough is byte-identical; only catch bindings and log
  statements were added. No new imports (`logWarning` was already imported at
  `:18`) and no `EXEMPT_FILES` change.
  Verify: `! git diff --name-only | grep -q EXEMPT && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/silent-catch-diagnostics.test.ts src/resources/extensions/gsd/tests/backup-restore-command.test.ts src/resources/extensions/gsd/tests/db-restore-backup-routing.test.ts`
  → exit 0. `tests 10 | suites 1 | pass 10 | fail 0 | cancelled 0 | skipped 0 |
  todo 0 | duration_ms 2503.680875`. Both `workflow-logger coverage (#3348)`
  tests green ("no empty catch blocks remain in migrated files",
  "catch blocks use workflow-logger instead of raw stderr/console"), plus
  backup-restore-command (a)–(d) and all four db-restore-backup-routing tests.
  Also ran `npx tsc --noEmit --incremental false -p tsconfig.extensions.json`:
  zero diagnostics naming `commands-maintenance.ts`.
- 2026-08-07 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
