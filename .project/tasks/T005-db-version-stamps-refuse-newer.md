---
id: T005
title: Stamp gsd.db (application_id, user_version, V46); make refuse-newer typed and surface it at the DB-open seam and state reads; realign the legacy-import schema pin + corpus to V46
wave: 2
deps: [T001, T003, T024, T025]
status: done
agent: build_T005
commit: 92ce63b209d651772f27f4618e1a6329e222b559
base: 50f88d435508973df096dae077e199f15e45007c
worktree: .worktrees/gsd-path-T005
task_branch: gsd-path/T005
files:
  - src/resources/extensions/gsd/db/engine.ts
  - src/resources/extensions/gsd/db-workspace.ts
  - src/resources/extensions/gsd/state/derive/db-open.ts
  - src/headless-query.ts
  - src/read-cli.ts
  - src/resources/extensions/gsd/legacy-import-contract.ts
  - src/resources/extensions/gsd/legacy-import-surfaces.ts
  - src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/
  - src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts
  - src/tests/headless-query-db-open.test.ts
  - src/tests/read-cli-schema-too-new.test.ts
  - src/resources/extensions/gsd/tests/project-authority-cutover.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-forward-repair.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-writer.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-result.test.ts
  - src/resources/extensions/gsd/tests/domain-operation.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-preview-database-target.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-preview-public-corpus.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-plan-corpus.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-public-corpus.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-preview-classification-fixtures.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-contract.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-application-plan.test.ts
  - src/resources/extensions/gsd/tests/legacy-import-preview.test.ts
---

# T005 — DB version stamps + refuse-newer surfacing + legacy-import pin/corpus realignment (expanded per block repair)

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

**Why the legacy-import pin rides with V46 (settled by planner, precedent
`9c338846f`):** the legacy importer pins its accepted base schema via
`LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 45 as const`
(`legacy-import-contract.ts:90`); bumping `SCHEMA_VERSION` to 46 without
advancing the pin makes `pnpm run typecheck:extensions` unsatisfiable (TS2322
in five test files) and turns runtime legacy-import tests red ("legacy import
Preview requires database schema 45"). The V44→V45 precedent (commit
`9c338846f`) advanced the pin, adjusted the message templating, and
regenerated the legacy-import corpus in ONE commit — pin semantic is part of
the same cutover-stamp concern, so it belongs in this task, not a companion.
V46 is stamp-only (NO table changes), so most of the precedent's production
edits are no-ops here: `legacy-import-preview-base.ts` (message now templated
on the constant), `legacy-import-preview-classifier.ts` and
`legacy-import-preview-database-target.ts` (already consume the constant;
anchor check `authority_recovery_receipts === (version >= 45)` stays correct
for v46), `legacy-import-backup.ts`, `legacy-import-database-target-inspector.ts`,
`legacy-import-preview.ts`, and `db-migration-steps.ts` (V45-table-specific)
are NOT expected to need edits.

## Resume state (READ FIRST)

Steps 1–6 below are COMPLETE in the retained worktree `.worktrees/gsd-path-T005`
(branch `gsd-path/T005`, base `c3ed1ff366cc328810cf79003108793962ccf647`,
uncommitted). Do NOT redo them and do NOT start a fresh worktree. Begin with
Step 0 to confirm the preserved state, then continue at Step 7. Note: the
worktree needed `pnpm --filter @gsd/pi-ai build` once for unrelated
environmental typecheck errors (packages/pi-ai dist unbuilt) — repeat that
build if the two oauth-api-model-routing errors reappear.

## Steps

0. Resume-state verification: in the retained worktree, re-run this task's
   Verify command restricted to the original three test files
   (`db-open-version-stamp.test.ts`, `headless-query-db-open.test.ts`,
   `read-cli-schema-too-new.test.ts`) plus the original greps. All 14 tests
   must pass. If anything regressed, STOP and report rather than rebuilding
   from scratch.
1. In `src/resources/extensions/gsd/db/engine.ts` (DONE — verify in Step 0):
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
2. In `src/resources/extensions/gsd/db-workspace.ts` (DONE — verify in
   Step 0): add `"schema-too-new"` to the `WorkflowDatabaseOpenReason` union
   and to the failure branch of `WorkflowDatabaseOpenResult`; in
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
3. In `src/resources/extensions/gsd/state/derive/db-open.ts` (DONE — verify
   in Step 0): when DB open fails with `isSchemaTooNewError` (directly, or
   via a `"schema-too-new"` result from
   `openExistingWorkflowDbOpen`/`openWorkflowDatabase`), THROW the
   `SchemaTooNewError` instead of returning a degraded
   `buildDbUnavailableState` result. Genuine unavailability (DB missing,
   corrupt, busy) keeps the existing fail-closed degraded path — only the
   version-skew case becomes loud.
4. In `src/headless-query.ts` and `src/read-cli.ts` (DONE — verify in
   Step 0): a `SchemaTooNewError` propagating from `deriveState` / state
   reads must print the exact engine message to stderr and exit non-zero —
   never emit a degraded all-zero/`activeMilestone: null` payload with
   exit 0. Catch it at the command boundary, format minimally
   (`[gsd] <exact message>`), and set a non-zero exit code; all other
   errors keep current handling.
5. `src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts`
   (DONE — verify in Step 0): (a) v45→v46 migration stamps
   `application_id`, `user_version = 46`, `MAX(schema_version.version) = 46`;
   fresh DB gets the same three stamps; (b) opening a v47 DB throws
   `SchemaTooNewError` (assert class, fields, and the exact message
   substring `newer than the v46 this gsd-pi supports`); (c) the v45→v46
   migration created a verified `gsd.db.backup-v45`.
6. `src/tests/headless-query-db-open.test.ts` and
   `src/tests/read-cli-schema-too-new.test.ts` (DONE — verify in Step 0):
   fixture project at one schema version above supported —
   `gsd headless query` and `gsd read progress --json` exit NON-ZERO and
   stderr contains the exact refuse-newer message; a genuinely
   DB-unavailable fixture still takes the existing degraded/fail-closed
   path with its current exit behavior.
7. Legacy-import pin advance (mirrors precedent `9c338846f`, stamp-only
   variant):
   a. `legacy-import-contract.ts`: `LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION`
      45 → 46.
   b. `legacy-import-surfaces.ts`: `requiredScenarios` entry `"schema-v45"`
      → `"schema-v46"` (the scenario name tracks the current schema, per the
      precedent's `"schema-v44"` → `"schema-v45"` rename).
   c. Grep all `legacy-import-*.ts` production files for hardcoded `45` /
      `v45` schema references. Expected: NONE remain — preview-base,
      preview-classifier, and preview-database-target already consume the
      constant. If a hardcoded reference IS found in a legacy-import
      production file not in this task's files list, add that file to the
      frontmatter files list, fix it, and record both in the Log. Do NOT
      edit `db-migration-steps.ts`, `legacy-import-backup.ts`,
      `legacy-import-database-target-inspector.ts`, or
      `legacy-import-preview.ts` for this task — their V45 edits were
      table-specific and V46 adds no tables.
8. Legacy-import corpus realignment (fixtures dir is in this task's files;
   mirror the precedent's rename/regen pattern):
   a. Rebuild each binary fixture DB that sits at the base schema using the
      extension's OWN engine — copy the fixture tree to a tmp dir, open the
      DB via `openDatabase` (`gsd-db.ts`) so `migrateSchema` runs the
      stamp-only V45→V46 step, close, and copy the migrated `gsd.db` back
      over the fixture. Affected cases: `action-matrix`,
      `lifecycle-truth-matrix`, `root-external-boundaries`, and
      `db-target-matrix`'s current DB. Record the exact procedure/script in
      the Log so the next version bump can repeat it.
   b. `db-target-matrix`: delete `historical-v44/`, rename
      `current-v45/` → `historical-v45/`, rename `future-v46/` →
      `current-v46/`, and create a NEW `future-v47/` as a copy of the new
      current DB stamped one version ahead (`UPDATE schema_version`,
      `PRAGMA user_version = 47` — same pragma helper pattern as
      `db-open-version-stamp.test.ts`).
   c. Update every case `oracle.json`: `base_database_schema_version` 45→46;
      for cases whose binary changed, recompute each changed source's
      `byte_size`/`sha256` and the case `source_set_hash`. In
      `db-target-matrix/oracle.json` rename the version-keyed rows
      (source ids `database-current-v45`→`database-current-v46`,
      `database-future-v46`→`database-future-v47`,
      `database-historical-v44`→`database-historical-v45`; diagnosis ids
      likewise) preserving dispositions: current = mapped, future =
      unparsed + `future-schema-version` blocker + `unsupported`
      resolution, historical = mapped + `historical-schema-version` info.
   d. `oracle.schema.json`: `base_database_schema_version` const 45→46.
   e. `corpus.json`: recompute the affected cases' `file_set_hash`,
      `oracle_hash`, and `source_set_hash` using the hashing functions in
      `tests/helpers/legacy-import-corpus.ts` (the loader/validator) — do
      not hand-roll hashes.
9. Fix the version-sensitive tests broken by the V46 stamp + pin advance:
   a. The five TS2322 files: `tests/project-authority-cutover.test.ts:93`,
      `tests/legacy-import-forward-repair.test.ts:203`,
      `tests/legacy-import-application-writer.test.ts:82`,
      `tests/legacy-import-application-result.test.ts:387`,
      `tests/domain-operation.test.ts:149` — these construct/annotate
      values against the pin's literal type; update them to track 46 (or
      reference the constant/SCHEMA_VERSION where the test intent allows).
      `project-authority-cutover.test.ts` is now owned by THIS task (moved
      from T006): fix ONLY the pin-related breakage there; T006's new
      end-to-end coverage lives in T006's own new file.
   b. Version-keyed expectations in the corpus consumers:
      `tests/legacy-import-corpus.test.ts` (cross-wave shared with T012,
      wave 3 — layered ownership, this task makes the version bump only),
      `tests/legacy-import-preview-database-target.test.ts`, and the other
      listed `legacy-import-*` test files — update hardcoded
      `current-v45`/`future-v46`/`historical-v44` names and 45 literals to
      the realigned matrix.
   c. LATITUDE CLAUSE: if the stamp+pin advance breaks an additional
      legacy-import test file not listed in this task's files (typecheck or
      runtime), you MAY fix it, and you MUST then append it to the
      frontmatter files list and record the failure output in the Log.
      HARD EXCLUSION: never touch
      `tests/single-writer-invariant.test.ts` (T007, same wave) — stamp-only
      V46 adds no schema file, so it needs no change; if you believe it
      does, STOP and report instead of editing.
10. Full gate re-run: this task's complete Verify command (below), then
    `pnpm run baseline:refactor:phase0` — both must be green. Evidence (test
    counts, typecheck result) goes in the Log.

## Acceptance criteria

1. `SCHEMA_VERSION` is 46; V46 stamps `application_id` + `user_version` on
   migrated and fresh databases; no table changes in V46.
2. Refuse-newer is a typed `SchemaTooNewError`; `openWorkflowDatabase`
   reports `reason: "schema-too-new"` with the exact message attached;
   every other open failure keeps `open-failed` semantics unchanged.
3. `gsd headless query` and `gsd read progress` on a newer-schema project
   exit non-zero with the exact engine message — no degraded exit-0
   payload. Genuine DB-unavailable behavior is unchanged.
4. No consumer outside this task's file list changes behavior.
5. `pnpm run baseline:refactor:phase0` green (runnable post-T024);
   single-writer invariant untouched.
6. `pnpm run typecheck:extensions` clean with `SCHEMA_VERSION = 46` — the
   previously unsatisfiable criterion; the five TS2322 files compile.
7. Legacy-import realigned to V46: pin is 46, corpus oracles carry
   `base_database_schema_version: 46`, db-target-matrix covers
   historical-v45 / current-v46 / future-v47 with dispositions preserved
   (current mapped, future refused, historical mapped-with-info), and all
   corpus/preview consumer tests are green.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/db-open-version-stamp.test.ts src/tests/headless-query-db-open.test.ts src/tests/read-cli-schema-too-new.test.ts src/resources/extensions/gsd/tests/project-authority-cutover.test.ts src/resources/extensions/gsd/tests/legacy-import-forward-repair.test.ts src/resources/extensions/gsd/tests/legacy-import-application-writer.test.ts src/resources/extensions/gsd/tests/legacy-import-application-result.test.ts src/resources/extensions/gsd/tests/domain-operation.test.ts src/resources/extensions/gsd/tests/legacy-import-corpus.test.ts src/resources/extensions/gsd/tests/legacy-import-preview-database-target.test.ts && pnpm run typecheck:extensions && grep -q "SCHEMA_VERSION = 46" src/resources/extensions/gsd/db/engine.ts && grep -q "SchemaTooNewError" src/resources/extensions/gsd/db/engine.ts && grep -q "schema-too-new" src/resources/extensions/gsd/db-workspace.ts && grep -q "LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 46" src/resources/extensions/gsd/legacy-import-contract.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — re-scoped by planner (Defect B repair: T003 spike observed silent divergence — refuse-newer must be typed and surfaced at read seams, not just an engine floor). Added deps T003→kept, T024; took `state/derive/db-open.ts` from T007's scope.
- 2026-08-02 — planner (T024 split repair): dep T025 added — acceptance runs `baseline:refactor:phase0`, green only after T025's re-baseline.
- 2026-08-02 — coder BLOCKED (plan defect: step 1b contradicts acceptance #4 within the files list). Implementation of Steps 1–6 is complete in the worktree: task Verify passes (14/14 tests across db-open-version-stamp/headless-query-db-open/read-cli-schema-too-new + all greps) and `baseline:refactor:phase0` is green (140/140). But `pnpm run typecheck:extensions` cannot be clean with the mandated `SCHEMA_VERSION = 46`: it conflicts with `LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 45 as const` in `src/resources/extensions/gsd/legacy-import-contract.ts` (NOT in files), producing TS2322 "Type '46' is not assignable to type '45'" in five unlisted test files: `tests/project-authority-cutover.test.ts:93`, `tests/legacy-import-forward-repair.test.ts:203`, `tests/legacy-import-application-writer.test.ts:82`, `tests/legacy-import-application-result.test.ts:387`, `tests/domain-operation.test.ts:149`. Fixing requires unlisted paths — the V45-bump precedent (commit 9c338846f) advanced the pin AND regenerated the legacy-import corpus (binary .gsd.db fixtures + oracle.json) in the same commit; runtime legacy-import/headless-recover tests also go red ("legacy import Preview requires database schema 45"). Needed: expand T005's files list to include the legacy-import pin + fixture regen, or spin a companion task for it. (Note: two unrelated oauth-api-model-routing typecheck errors were environmental — packages/pi-ai dist unbuilt in the worktree — and cleared after `pnpm --filter @gsd/pi-ai build`.)
- 2026-08-02 — orchestrator: block accepted as documented plan defect (not an implementation failure — diff not rejected). Isolated worktree .worktrees/gsd-path-T005 RETAINED at base c3ed1ff366cc328810cf79003108793962ccf647 on branch gsd-path/T005 with the complete Steps 1–6 implementation uncommitted; no product commit created. Routing to planner for contract repair (files-list expansion or companion task), then resuming build_T005 in the retained worktree.
- 2026-08-02 — planner (block repair): EXPANDED T005 rather than spinning a companion — the pin semantic is part of the same cutover-stamp concern, the resume is one continued agent run in the retained worktree, and precedent `9c338846f` landed pin + corpus regen + test updates in a single commit. Added files: `legacy-import-contract.ts`, `legacy-import-surfaces.ts`, the legacy-import corpus fixtures dir, the five TS2322 test files, and the precedent-implicated version-sensitive legacy-import test files (`legacy-import-corpus.test.ts` is cross-wave shared with T012, wave 3 — layered). `tests/project-authority-cutover.test.ts` MOVED from T006's files into T005's (T005 fixes only its pin-related type error; T006's end-to-end coverage moves to a new T006-owned file). New Steps 0 (resume verification), 7 (pin advance), 8 (corpus realignment), 9 (test fixes + bounded latitude clause; `single-writer-invariant.test.ts` hard-excluded — T007, same wave), 10 (full gate). New acceptance #6 (typecheck clean) and #7 (corpus realigned). Original Steps 1–6 confirmed DONE in the worktree. Status reset blocked→pending; base/worktree/task_branch unchanged so build_T005 resumes in place.
- 2026-08-02 — coder RESUMED + COMPLETE (Steps 0, 7, 8, 9, 10 all done; full gate green).
  Step 0: preserved Steps 1–6 re-verified green (14/14 tests + 4 greps) before any new work. Also restored `db-target-matrix/source/wal-present/.gsd/gsd.db-shm` from HEAD — an earlier read-only test open had rewritten its bytes; the wal trio is sealed corpus evidence and must stay byte-identical (verified `dc06e3e3…` matches the oracle).
  Step 7: pin advanced — `LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 46 as const` (legacy-import-contract.ts:90); requiredScenarios `"schema-v45"`→`"schema-v46"` (legacy-import-surfaces.ts:51). No hardcoded 45/v45 left in production legacy-import-*.ts.
  Step 8 corpus realignment — EXACT PROCEDURE for the next version bump (deviates from the contract's literal "open via openDatabase" in one documented way): the contract's engine-open procedure CANNOT complete on these corpus fixtures — they are minimal handcrafted DBs carrying only the tables their assertions need, so the engine commits the stamp-only V45→V46 migration step and then its post-migration startup repair throws `ERR_SQLITE_ERROR: no such table: main.workflow_outbox` (ensureCanonicalOutboxInvariantsV31). Verified empirically on action-matrix: the engine run left versions [45,46], application_id 1196639298, user_version 46 — plus ~69 pages of materialized canonical tables, which would bloat fixtures far beyond their handcrafted convention. Since the engine's ENTIRE V46 migration step (`applyMigrationV46StateCutoverStamp`, engine.ts:501-504) is exactly `PRAGMA application_id = 0x47534442` + `PRAGMA user_version = 46` + record schema version 46, the fixtures were stamped with that same step applied directly via node:sqlite, preserving each fixture's single-row `schema_version` convention (`UPDATE schema_version SET version = 46`, matching how the V45 corpus and the old future-v46 were built; action-matrix/lifecycle keep applied_at `2026-01-01T00:00:00.000Z`). Restored action-matrix gsd.db from the engine's `.backup-v45` first, removed backup + WAL sidecars, and reset its journal mode to DELETE to match the other fixtures. db-target-matrix realignment: `current-v45/` renamed to `historical-v45/` (bytes untouched — an unstamped v45 DB, historically accurate); copied to `current-v46/` and stamped v46; copied to `future-v47/` and stamped one version ahead (`UPDATE schema_version SET version = 47`, `PRAGMA user_version = 47`); deleted `future-v46/` + `historical-v44/`. Post-stamp versions: action-matrix 46, lifecycle-truth-matrix 46, root-external-boundaries 46, current-v46 46, future-v47 47, historical-v45 45 — all integrity ok, no -wal/-shm/backup leftovers. Lifecycle byte locators verified INTACT after stamping (`["S00"]` at 118696-118703 unique, `S99` at 180209-180212) — no re-anchoring needed because UPDATE-in-place + page-1 pragma stamps do not move table pages.
  Step 8c/d/e: all 26 oracle.json `base_database_schema_version` 45→46; db-target-matrix oracle row/diagnosis/resolution renames (`database-current-v45`→`database-current-v46`, `database-future-v46`→`database-future-v47`, `database-historical-v44`→`database-historical-v45`; future message "Schema v47 is newer than the accepted v46 target…", historical message "Schema v45 is a supported historical database target.") with fingerprints refreshed from disk and canonical re-sort; `oracle.schema.json` const 45→46; corpus.json scenario `schema-v45`→`schema-v46` + all 26 case rows (`file_set_hash`/`oracle_hash`/`source_set_hash`/`change_set_hash`/counts) and totals recomputed using the REAL helpers (`legacyImportCorpusHash`, `loadLegacyImportCorpusCase`) from tests/helpers/legacy-import-corpus.ts — no hand-rolled hashes. Result verified with the real validator: `validateLegacyImportCorpusCase` ×26 + `validateLegacyImportCorpusManifest` (with production SUPPORTED_LEGACY_SURFACES) all pass.
  Step 9: version-keyed test updates — legacy-import-corpus.test.ts (root-external `{schema_version: 46}`; SCHEMA_VERSION 46 pin assert; lifecycle conflict row `schema_version: 46` (query selects the single version row — preserved by the UPDATE-not-INSERT choice); db-target-matrix source/diagnosis/resolution/scenario/version-map expectations renamed to current-v46/future-v47/historical-v45; action-matrix `{schema_version: 46, revision: 17, authority_epoch: 2}`; recomputed hash rows for db-target-matrix `[f712d432…, 4f53cda1…, b06e5784…, b48c73e2…]` and action-matrix `[2a784442…, 5ee81644…, 4f53cda1…, 4f53cda1…]`; composite-capstone row unchanged); legacy-import-preview-database-target.test.ts (DATABASE_MATRIX_SCENARIOS rename; main-only-bytes test creates v46 so diagnoses stay `[]`; synthetic boundary scenarios historical-v45(45)/future-v47(47); recovery-anchor test renamed v46 and creates v46); legacy-import-preview.test.ts (seal rejection regex `/database schema 46/`); legacy-import-preview-public-corpus.test.ts DEVIATIONS semantic_hash recomputed from PRODUCTION preview output via a script replicating the test's exact flow (cpSync → openDatabase canonical.db → seed action-matrix → createLegacyImportPreview → semanticProjection): action-matrix `10b330dc…`, db-target-matrix `fd81cfe8…`, lifecycle-truth-matrix `882a204c…` — deviation counts unchanged, root-external-boundaries (non-deviation) production==oracle exactly. Two runtime pin fixes in owned files: project-authority-cutover.test.ts future-schema simulation now inserts schema_version 47 (46 is current), domain-operation.test.ts restored-v30 expectations `SCHEMA_VERSION, 46` / `{version: 46}`. The five TS2322 sites needed NO edits (they reference the constant/SCHEMA_VERSION and compile once the pin is 46). LATITUDE CLAUSE not invoked — every edited file was already in frontmatter; `single-writer-invariant.test.ts` untouched.
  Step 10 evidence: task Verify chain green — 150/150 tests across the 10 listed test files + all 4 greps; `pnpm run typecheck:extensions` CLEAN (acceptance #6); additionally legacy-import-preview.test.ts + application-plan-corpus + application-public-corpus + application-contract + application-plan 60/60 and preview-database-target + preview-public-corpus 22/22 green; `pnpm run baseline:refactor:phase0` green 140/140. wal-present shm verified unmodified after all runs. Temporary regen scripts (tmp-t005-*.mts, worktree root, never in files list) deleted after use.
