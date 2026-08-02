---
id: T005
title: Stamp gsd.db (application_id, user_version, V46); make refuse-newer typed and surface it at the DB-open seam and state reads
wave: 2
deps: [T001, T003, T024]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
files:
  - src/resources/extensions/gsd/db/engine.ts
  - src/resources/extensions/gsd/db-workspace.ts
  - src/resources/extensions/gsd/state/derive/db-open.ts
  - src/headless-query.ts
  - src/read-cli.ts
  - src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts
  - src/tests/headless-query-db-open.test.ts
  - src/tests/read-cli-schema-too-new.test.ts
---

# T005 — DB version stamps + refuse-newer surfacing contract (re-scoped per T003 spike)

## Context

Downgrade compatibility is settled: keep the existing loud refuse-newer guard
(`db/engine.ts:455-460`) as the floor — no silent corruption, ever. The T003
spike (`docs/dev/state-db-cutover-mixed-version-spike.md`, observed behavior:
**silent divergence**) proved the floor exists at engine level but is
SWALLOWED at CLI surfaces: v1.11.0 read a v32 fixture with exit 0 and
wrong/empty state (`gsd headless query`, `gsd read progress --json`) because
`openWorkflowDatabase` (`db-workspace.ts:138-165`) catches the engine's
refuse-newer throw into `{ ok: false, reason: "open-failed" }` and the
derive/read seams then degrade to empty state instead of refusing. This task
ships the read-side half of the spike's mandated amendment: (1) refuse-newer
becomes a TYPED, distinguishable error; (2) state-read surfaces refuse loudly
with the exact engine message and non-zero exit. (Write-side gating and
rebuild-path propagation are T006.) The cutover itself remains one more
versioned step in the `migrateSchema` chain (V46), stamped with
`PRAGMA application_id` + `PRAGMA user_version` so binaries and external
tools can detect DB-authored state cheaply. Backup behavior is unchanged
(`db-migration-backup.ts` verified same-directory copy; backup failure aborts
migration). Gate note: this task's acceptance runs
`baseline:refactor:phase0`, which only executes at clean HEAD after T024's
contracts redirect.

## Steps

1. In `src/resources/extensions/gsd/db/engine.ts`:
   a. Add and export `class SchemaTooNewError extends Error` with
      `name = "GSDSchemaTooNewError"` and readonly fields
      `currentVersion: number` and `supportedVersion: number`; throw it from
      the existing refuse-newer site with the message text UNCHANGED
      (`gsd.db schema is vN, newer than the vM this gsd-pi supports. Update
      gsd-pi ...`). Export `isSchemaTooNewError(err)` type guard. Do not
      weaken, reword, or gate the message.
   b. Add module constant `GSD_APPLICATION_ID` (fixed 4-byte integer;
      document the derivation in a comment) and bump `SCHEMA_VERSION` to 46.
   c. Add `applyMigrationV46StateCutoverStamp(db)`:
      `PRAGMA application_id = <GSD_APPLICATION_ID>`,
      `PRAGMA user_version = 46`, `recordSchemaVersion(db, 46)`; wire it as
      the `if (currentVersion < 46)` step following the existing V2…V45
      pattern. If the vendored adapter refuses these PRAGMA writes
      mid-transaction, apply them immediately after the migration COMMIT in
      the same code path — pick ONE placement and test it. Apply the same
      stamps in the fresh-DB initialization path so new and migrated DBs
      are indistinguishable. V46 adds/alters NO tables.
2. In `src/resources/extensions/gsd/db-workspace.ts`: add
   `"schema-too-new"` to the `WorkflowDatabaseOpenReason` union and to the
   failure branch of `WorkflowDatabaseOpenResult`; in
   `openWorkflowDatabase`'s catch, map `isSchemaTooNewError(err)` to
   `{ ok: false, reason: "schema-too-new", location, error }` — the error
   (with its exact message) is ALWAYS attached. All other failures keep
   `open-failed`. Grep every `reason === "open-failed"` / exhaustive
   consumer (`auto-start.ts`, `auto-worktree-merge-db-ready.ts`,
   `auto-worktree-merge-stash.ts`, `md-importer.ts`,
   `parallel-monitor-overlay.ts`, `workflow-reconcile.ts`,
   `migration-auto-check.ts`, `migrate/execution.ts`,
   `src/headless-recover.ts`): the union addition is source-compatible for
   non-exhaustive consumers (they keep failing closed as today); fix any
   EXHAUSTIVE switch that stops compiling, but do NOT change any other
   consumer's behavior — read-side surfacing is only in the files this
   task owns.
3. In `src/resources/extensions/gsd/state/derive/db-open.ts` (moved into
   this task's scope from T007): when DB open fails with
   `isSchemaTooNewError` (directly, or via a `"schema-too-new"` result from
   `openExistingWorkflowDbOpen`/`openWorkflowDatabase`), THROW the
   `SchemaTooNewError` instead of returning a degraded
   `buildDbUnavailableState` result. Genuine unavailability (DB missing,
   corrupt, busy) keeps the existing fail-closed degraded path — only the
   version-skew case becomes loud.
4. In `src/headless-query.ts` and `src/read-cli.ts`: a `SchemaTooNewError`
   propagating from `deriveState` / state reads must print the exact
   engine message to stderr and exit non-zero — never emit a degraded
   all-zero/`activeMilestone: null` payload with exit 0. Catch it at the
   command boundary, format minimally (`[gsd] <exact message>`), and set a
   non-zero exit code; all other errors keep current handling.
5. Write `src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts`:
   (a) v45→v46 migration stamps `application_id`, `user_version = 46`,
   `MAX(schema_version.version) = 46`; fresh DB gets the same three stamps;
   (b) opening a v47 DB throws `SchemaTooNewError` (assert class, fields,
   and the exact message substring `newer than the v46 this gsd-pi
   supports`); (c) the v45→v46 migration created a verified
   `gsd.db.backup-v45`.
6. Extend `src/tests/headless-query-db-open.test.ts` and write
   `src/tests/read-cli-schema-too-new.test.ts`: fixture project at one
   schema version above supported — `gsd headless query` and
   `gsd read progress --json` exit NON-ZERO and stderr contains the exact
   refuse-newer message; a genuinely DB-unavailable fixture still takes the
   existing degraded/fail-closed path with its current exit behavior.

## Acceptance criteria

1. `SCHEMA_VERSION` is 46; V46 stamps `application_id` + `user_version` on
   migrated and fresh databases; no table changes in V46.
2. Refuse-newer is a typed `SchemaTooNewError`; `openWorkflowDatabase`
   reports `reason: "schema-too-new"` with the exact message attached;
   every other open failure keeps `open-failed` semantics unchanged.
3. `gsd headless query` and `gsd read progress` on a newer-schema project
   exit non-zero with the exact engine message — no degraded exit-0
   payload. Genuine DB-unavailable behavior is unchanged.
4. No consumer outside this task's file list changes behavior; typecheck
   clean (`pnpm run typecheck:extensions`).
5. `pnpm run baseline:refactor:phase0` green (runnable post-T024);
   single-writer invariant untouched.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts src/tests/headless-query-db-open.test.ts src/tests/read-cli-schema-too-new.test.ts && grep -q "SCHEMA_VERSION = 46" src/resources/extensions/gsd/db/engine.ts && grep -q "SchemaTooNewError" src/resources/extensions/gsd/db/engine.ts && grep -q "schema-too-new" src/resources/extensions/gsd/db-workspace.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect B repair: T003 spike observed silent divergence — refuse-newer must be typed and surfaced at read seams, not just an engine floor). Added deps T003→kept, T024; took `state/derive/db-open.ts` from T007's scope.
