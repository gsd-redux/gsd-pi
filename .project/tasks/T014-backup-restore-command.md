---
id: T014
title: Ship the explicit backup-restore command; re-point commands-maintenance off parsers-legacy
wave: 3
deps: [T006]
status: done
agent: build_T014
commit: ef879f79bfc804512731816329c3ea4f919eb163
base: 40bdcfca4d1eea63fb1eb2d3198928c73d91fd37
worktree: .worktrees/gsd-path-T014
task_branch: gsd-path/T014
files:
  - src/resources/extensions/gsd/commands-maintenance.ts
  - src/resources/extensions/gsd/legacy-import-restore-assessment.ts
  - src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts
  - src/resources/extensions/gsd/tests/backup-restore-command.test.ts
---

# T014 — Explicit backup-restore command (ruled: ships in this milestone)

## Context

The downgrade-window ruling (2026-08-01: 2 stable releases + ≥60 days,
ADR-046 window) REQUIRES an explicit backup-restore command to ship in this
milestone. Rollback semantics per synthesis: restore the verified backup —
backup-restore beats down-migrations for destructive changes. The repo
already has restore machinery: `commands-maintenance.ts` implements a
consent-gated restore flow (`--restore
--consent=proceed:destructive-database-restore:sha256:<hash>`, ~line 512)
backed by `legacy-import-restore-assessment.ts`
(`LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION`), with recovery
statuses like `restored` and `restore-consent-required` (~lines 653-677).
This task exposes that machinery as an explicit, discoverable user-facing
command for restoring `gsd.db.backup-v<N>` files produced by the verified
pre-migration/cutover backup (`db-migration-backup.ts`). Also:
`commands-maintenance.ts` is itself a parsers-legacy consumer (prompt
context text) — re-point it per T004 class (a) while you own the file; the
registry is reconciled by T016.

## Steps

1. Read the existing restore flow in `commands-maintenance.ts` (lines
   ~500-700) and `legacy-import-restore-assessment.ts` fully.
2. Add an explicit user-facing command surface (follow the existing
   maintenance-command registration pattern in `commands-maintenance.ts`):
   `gsd db restore-backup --backup <path-to-gsd.db.backup-vN>
   --consent=proceed:destructive-database-restore:sha256:<hash>`. It must:
   (a) list/validate candidate `gsd.db.backup-v*` files beside the project
   DB with their schema versions when invoked without `--backup`; (b)
   verify the chosen backup before restoring (ATTACH + `quick_check` +
   schema-version read, reusing `db-migration-backup.ts`'s verification
   approach); (c) require the existing consent token pattern — never
   restore without explicit consent; (d) restore inside the startup
   EXCLUSIVE claim (single-writer invariant); (e) print the restored-from
   backup id, schema version, and next-step guidance (upgrade/downgrade
   note) on success.
3. Do NOT invent a second restore path — wire the command into the existing
   assessment/consent/receipt machinery; persist a restore receipt using
   the existing authority-recovery writers so restores are auditable.
4. Re-point `commands-maintenance.ts`'s `parsers-legacy` usage (prompt
   context text) to DB reads per T004; remove the import.
5. Write `tests/backup-restore-command.test.ts`: (a) fixture project with a
   v45 DB + verified `gsd.db.backup-v45`; simulate the v46 cutover, invoke
   the command with consent, assert the DB is restored to v45 contents
   (hash comparison) and a restore receipt is persisted; (b) invocation
   without consent is refused with the consent-required guidance; (c)
   invocation with a corrupt/tampered backup fails the verification and
   restores nothing; (d) `--list`-style invocation shows candidates and
   mutates nothing. Update
   `tests/legacy-import-restore-assessment.test.ts` only as needed.

## Acceptance criteria

1. The command exists, is consent-gated, verifies before restoring, runs
   inside the EXCLUSIVE claim, and persists a restore receipt.
2. Corrupt-backup and no-consent invocations fail closed with guidance.
3. `commands-maintenance.ts` has zero `parsers-legacy` references.
4. New tests pass; single-writer invariant untouched.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/backup-restore-command.test.ts src/resources/extensions/gsd/tests/legacy-import-restore-assessment.test.ts && ! grep -n "parsers-legacy" src/resources/extensions/gsd/commands-maintenance.ts && grep -q "restore-backup" src/resources/extensions/gsd/commands-maintenance.ts
```

## Log

- 2026-08-01 — created by planner
- 2026-08-03 — implemented (wave 3, worktree gsd-path-T014).
  `handleDbRestoreBackup(ctx, basePath, args)` added to
  `commands-maintenance.ts`: list mode (no `--backup`, or `--list`) enumerates
  `gsd.db.backup-v*` candidates via read-only SQLite connections (quick_check +
  schema version + sha256 consent hash) and never opens/migrates the engine
  DB; restore mode validates path/name (`<db>.backup-vN` beside the project
  DB, N ≤ 46), verifies via ATTACH + quick_check + schema-version read
  (mirroring `db-migration-backup.ts` verifyBackup), refuses backups without
  `workflow_import_restores` (pre-v45) or a foreign project_id, and requires
  the existing `--consent=proceed:destructive-database-restore:sha256:<hash>`
  token (`requestedRestoreConsent`) bound to the backup file bytes — missing
  or stale consent fails closed with the exact token to re-run. The restore
  stages `candidate.sqlite` in `<db>.recovery/`, claims a schema-valid
  replacement intent, detaches via `detachActiveDatabaseForReplacement`,
  publishes by rename, reopens with full publication evidence
  (`reopenDatabaseAfterReplacement`), and persists an auditable receipt
  through `_executeImportRestoreDomainOperation` +
  `insertImportRestoreReceipt` (event `legacy-import.restored`, projection
  `legacy-import/restore`) — the existing writers, no second restore path.
  Fresh runs execute inside `withDatabaseMaintenanceClaim` (startup
  EXCLUSIVE claim); crash-convergence re-runs adopt the matching intent
  (requestHash is deterministic over backup bytes + contents) and are fenced
  by the intent itself. Receipt/idempotency fields derive only from backup
  bytes + contents, so interrupted restores converge by re-running the
  identical command (domain op replays on the stable idempotency key).
  Step 4: `handleCleanupBranches` stale-milestone check is now DB-only —
  the markdown fallback (`resolveMilestoneFile`/`loadFile`/`parseRoadmap`/
  `isMilestoneComplete`) is deleted; branches with no DB milestone row (or
  no DB) are skipped. `legacy-import-restore-assessment.ts` read fully — no
  change needed: the synthesized receipt satisfies its strict
  `terminalReceipt` validation (exact receipt keys, canonical lineage,
  route-bound event/projection), and its test file is unchanged.
  Verify: PASS — new `tests/backup-restore-command.test.ts` 4/4 (consent
  restore → v45 contents + receipt; no-consent + stale-consent refusals;
  corrupt backup fails verification, restores nothing; list mutates
  nothing), existing `legacy-import-restore-assessment.test.ts` 15/15, zero
  `parsers-legacy` references in commands-maintenance.ts. Blast-radius
  check: gsd-recover/gsd-rebuild/gsd-sync-fail-closed suites 30/30.
