---
id: T014
title: Ship the explicit backup-restore command; re-point commands-maintenance off parsers-legacy
wave: 3
deps: [T006]
status: pending
agent: null
commit: null
base: null
worktree: null
task_branch: null
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
