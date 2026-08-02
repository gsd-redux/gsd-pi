---
id: T006
title: Filesystem-state cutover via the authority-cutover op — EXCLUSIVE-claim migration, idempotent re-entry, authority-epoch refusal, wedge fix
wave: 2
deps: [T002, T005]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts
  - src/resources/extensions/gsd/migrate-external.ts
  - src/resources/extensions/gsd/tests/project-authority-cutover.test.ts
  - src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts
---

# T006 — Cutover migration riding the existing authority-cutover op + partial-destination wedge fix

## Context

Migration design is settled: ride the existing machinery, build NO new
migration path. The flip is one more versioned step in the existing
`migrateSchema` chain (V46, landed in T005) plus the existing
`src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts`
(consent tokens, authority-epoch checks, persisted cutover receipts, error
codes `GSD_IDEMPOTENCY_CONFLICT` / `..._REPLAY_CONFLICT`). Backup = the
existing verified same-directory copy; backup failure aborts the cutover.
Rollback = restore the verified backup (backup-restore beats down-migrations);
legacy user files are NEVER deleted in the same step as the flip. The atomic
flip runs inside the existing startup EXCLUSIVE lock window
(`acquireStartupMaintenance`, engine.ts:191-232: `PRAGMA
locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE`), so no concurrent writer can hold
the DB mid-flip. Known wedge pattern from `src/resources/extensions/gsd/migrate-external.ts`:
a failed migration can leave a partial destination (`.gsd.migrating`) that
permanently blocks retry — the cutover must clean or own its partial
destination so retry is never permanently blocked on user machines.

## Steps

1. Read `project-authority-cutover-domain-operation.ts` in full plus
   `src/resources/extensions/gsd/db/domain-operation.js` (the
   `_executeAuthorityCutoverDomainOperation` executor) and
   `src/resources/extensions/gsd/legacy-import-application*.ts`. Extend the
   existing cutover domain operation with the filesystem-state authority
   scope: after the verified backup and receipt flow, the op records that
   filesystem-state (markdown) authority has flipped to the DB for this
   project — reuse the existing receipt/evidence shapes (add a
   `filesystemStateAuthority: "db"` field to the receipt, bumping the
   evidence schema version constant if the shape validation requires it).
   Do NOT create a second operation type or a parallel consent flow.
2. Ensure the op executes only inside the startup EXCLUSIVE claim: assert at
   op entry that the exclusive ownership state is held (follow how existing
   startup maintenance asserts ownership); fail with a
   `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION`-class error otherwise.
3. Authority-epoch loud refusal: when the op's `expectedAuthorityEpoch` does
   not match the project's current epoch, or a receipt already exists with a
   different idempotency key, keep/extend the existing loud error codes —
   re-entry with the SAME idempotency key MUST be a no-op returning the
   existing receipt (`status: "replayed"`), never an error.
4. Wedge fix: in `migrate-external.ts`, and in any destination-copy path the
   cutover op uses, make partial destinations self-healing — on entry, if a
   stale `.gsd.migrating` (or op-specific partial destination) exists and is
   not owned by a live process, remove or adopt it before proceeding; a prior
   failed attempt must never require manual deletion to retry. Follow the
   existing `isMigratingPath`/`rmSync(migratingPath)` patterns at
   migrate-external.ts:119-120,202,256-257.
5. Extend `tests/project-authority-cutover.test.ts` with: (a) end-to-end
   fixture — a pre-cutover fixture project migrates via the op inside the
   EXCLUSIVE claim: verified backup exists, receipt persisted, projections
   rendered, schema v46; (b) idempotent re-entry: invoking the op again with
   the same inputs returns `status: "replayed"` and mutates nothing (hash
   the DB before/after); (c) wrong-epoch and conflicting-idempotency-key
   invocations fail loudly with the existing error codes; (d) rollback:
   restoring the verified `gsd.db.backup-v<N>` returns the project to the
   pre-cutover schema version and the old code path reads it.
6. Write `tests/migrate-external-wedge.test.ts`: simulate a failed migration
   leaving a partial destination, assert the next attempt cleans/owns it and
   completes without manual intervention.

## Acceptance criteria

1. The cutover op covers filesystem-state authority with consent, verified
   backup, receipt, and replay-safe idempotent re-entry, inside the
   EXCLUSIVE claim only.
2. A stale partial destination never blocks retry (test proves it).
3. Rollback by restoring the verified backup is demonstrated in tests;
   legacy files are not deleted by the flip.
4. `pnpm run baseline:refactor:phase0` stays green; single-writer invariant
   untouched; no changes to canonical-lifecycle read authority (D005 remains
   in force there per T002).

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/project-authority-cutover.test.ts src/resources/extensions/gsd/tests/migrate-external-wedge.test.ts
```

## Log

- 2026-08-01 — created by planner
