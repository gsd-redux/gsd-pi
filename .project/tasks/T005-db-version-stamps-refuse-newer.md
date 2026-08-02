---
id: T005
title: Stamp gsd.db with application_id/user_version and schema V46; lock the refuse-newer guard
wave: 2
deps: [T001, T003]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/db/engine.ts
  - src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts
---

# T005 — Stamp gsd.db (application_id, user_version, schema V46) and lock the refuse-newer guard

## Context

Downgrade compatibility is settled: keep the existing loud refuse-newer guard
(`src/resources/extensions/gsd/db/engine.ts:455-460` —
`gsd.db schema is vN, newer than the vM this gsd-pi supports`) as the floor —
no silent corruption, ever. Stamp `PRAGMA user_version` and a fixed
`PRAGMA application_id` so older binaries and external tools can detect
DB-authored state cheaply. The filesystem-state cutover is one more versioned
step in the existing `migrateSchema` chain (engine.ts, `SCHEMA_VERSION = 45`),
so the cutover release bumps the chain to V46 — this is what makes
pre-cutover binaries refuse a cut-over project loudly (empirically validated
by T003; if T003 observed anything other than loud refusal, re-scope before
starting). Backup behavior is unchanged: `backupDatabaseBeforeMigration` in
`src/resources/extensions/gsd/db-migration-backup.ts` already does
`wal_checkpoint(TRUNCATE)` → `gsd.db.backup-v<N>` → ATTACH + `quick_check` +
version match, and backup failure aborts the migration.

## Steps

1. In `src/resources/extensions/gsd/db/engine.ts`: add a module-level constant
   `GSD_APPLICATION_ID` (a fixed 4-byte integer derived from the ASCII bytes
   of `"gsd\0"`-style tag — document the derivation in a comment) and bump
   `SCHEMA_VERSION` from 45 to 46.
2. Add `applyMigrationV46StateCutoverStamp(db)`: executes
   `PRAGMA application_id = <GSD_APPLICATION_ID>` and
   `PRAGMA user_version = 46`, then `recordSchemaVersion(db, 46)`. Wire it
   into `migrateSchema` as the `if (currentVersion < 46)` step, following the
   exact pattern of the existing V2…V45 steps. PRAGMA `user_version`/
   `application_id` writes are valid inside the migration transaction; if
   SQLite refuses them mid-transaction in the vendored adapter, apply them
   immediately after the migration COMMIT in the same code path instead —
   pick ONE placement and test it, do not leave both.
3. For fresh databases, ensure the same stamps are applied in the
   schema-initialization path (where `recordSchemaVersion(db, SCHEMA_VERSION)`
   is called for new DBs) so new and migrated DBs are indistinguishable.
4. Do NOT weaken, reword, or gate the existing refuse-newer error at
   engine.ts:455-460. Do NOT add any silent-downgrade or compat-read path.
5. Write `src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts`
   (Node `node:test`, strip-types invocation like sibling tests) asserting:
   (a) a DB migrated from v45 has `PRAGMA application_id = GSD_APPLICATION_ID`
   and `PRAGMA user_version = 46` and `MAX(schema_version.version) = 46`;
   (b) a fresh DB has the same three stamps; (c) opening a DB whose
   `schema_version` is 47 throws the existing refuse-newer error message
   (assert the `newer than the v46 this gsd-pi supports` substring);
   (d) the v45→v46 migration created a verified `gsd.db.backup-v45`
   (reuse the backup-test patterns from existing migration tests; sql.js/
   node:sqlite adapter per the sibling test conventions).

## Acceptance criteria

1. `SCHEMA_VERSION` is 46; the V46 step stamps `application_id` and
   `user_version` on both migrated and fresh databases.
2. The refuse-newer error path is byte-identical in behavior: opening a
   newer-than-supported DB throws before any DDL runs.
3. New test file passes; `pnpm run baseline:refactor:phase0` (which includes
   `single-writer-invariant.test.ts`) is green — the single-writer invariant
   is untouched.
4. No other files change; no schema tables are added or altered in V46
   (stamp-only step).

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts && grep -q "SCHEMA_VERSION = 46" src/resources/extensions/gsd/db/engine.ts && grep -q "application_id" src/resources/extensions/gsd/db/engine.ts
```

## Log

- 2026-08-01 — created by planner
