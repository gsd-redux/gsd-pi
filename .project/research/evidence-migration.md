# Evidence — migration

<!-- Written by one researcher role. Consumed by the synthesizer. -->

Dimension: custom (migration — live user-data migration during the on-disk format/authority cutover of `~/.gsd` project state)
Questions assigned: [RESEARCH] "Migration design for existing `~/.gsd` state: backup format, idempotency key, rollback procedure, downgrade compatibility window" (INTENT.md open questions, item 3)

## Finding: The repo already runs the canonical journaled, transaction-wrapped, idempotent migration chain

- **Claim**: `src/resources/extensions/gsd/db/engine.ts` defines `SCHEMA_VERSION = 45` (line 159) and `migrateSchema` (lines 448–720) applies a linear v2→v45 chain where every step is guarded by `if (currentVersion < N)`, each step's DDL is idempotent (`CREATE TABLE IF NOT EXISTS`, `ensureColumn` in `db-migration-steps.ts`), `recordSchemaVersion(db, N)` is stamped after each step, and the whole chain runs inside one `BEGIN`/`COMMIT` (or SAVEPOINT when nested) with `ROLLBACK` on any error. A legacy DB with data but no `schema_version` row is stamped v1 so the full chain runs instead of being mis-marked current (engine.ts:340–351).
- **Source**: `src/resources/extensions/gsd/db/engine.ts:159,322-399,448-471`; `src/resources/extensions/gsd/db-migration-steps.ts:22-34` (representative idempotent step); corroborated by Flyway's official migrations doc (versioned migrations "applied in order exactly once", per-migration transaction with "rollback (if possible) and stop", schema history table) at https://documentation.red-gate.com/fd/migrations-184127470.html and Rails' `schema_migrations` journaling at https://guides.rubyonrails.org/active_record_migrations.html (section 4.8).
- **Confidence**: high
- **Why it matters here**: The file→DB authority cutover does not need a new migration framework — INTENT's "idempotent, backed up, rollback-safe" requirement slots into the existing chain as one more versioned step plus a cutover receipt; idempotency is already structural, not aspirational.

## Finding: The repo's pre-migration backup is a verified same-directory file copy — and backup failure aborts the migration

- **Claim**: `backupDatabaseBeforeMigration` performs `PRAGMA wal_checkpoint(TRUNCATE)` (fail if incomplete), `copyFileSync(dbPath, `${dbPath}.backup-v${currentVersion}`)`, then ATTACHes the backup and requires `quick_check = 'ok'` plus a `schema_version` match; any failure is wrapped in `MigrationBackupError` and rethrown before migration DDL runs, so a DB that cannot be safely backed up is never migrated. It is called both from startup (`prepareStartupMigrationBackup`, engine.ts:269–297) and inside `migrateSchema` (engine.ts:463–469).
- **Source**: `src/resources/extensions/gsd/db-migration-backup.ts:33-51,53-83,85-95`; `src/resources/extensions/gsd/db/engine.ts:269-297,463-469`.
- **Confidence**: high
- **Why it matters here**: This is the evidence-supported backup format and location for the cutover: whole-DB copy beside the live DB, version-suffixed, integrity-verified — satisfying INTENT's "backed up" constraint with machinery that already exists and is already fail-loud.

## Finding: Refuse-newer is the shipped-CLI norm for downgrade safety — and the repo already implements it

- **Claim**: `migrateSchema` throws `gsd.db schema is v${currentVersion}, newer than the v${SCHEMA_VERSION} this gsd-pi supports. Update gsd-pi ... before opening this project.` when the DB is newer than the binary (engine.ts:455–460). Git's SHA-256 transition uses the same pattern: `core.repositoryFormatVersion = 1` plus `extensions.*` ensures "all versions of Git later than v0.99.9l will die instead of trying to operate on the SHA-256 repository" with a clear error. Firefox similarly writes `compatibility.ini` and refuses to start an older binary against a newer profile (with an explicit `--allow-downgrade` escape hatch).
- **Source**: `src/resources/extensions/gsd/db/engine.ts:455-460`; https://git-scm.com/docs/hash-function-transition ("Repository format extension" section); https://support.mozilla.com/zh-CN/questions/1418760 (downgrade refusal + `-allow-downgrade`) corroborated by https://www.dedoimedo.com/computers/firefox-old-profile-reuse.html.
- **Confidence**: high (repo + Git doc); medium (Firefox — official KB page failed to load; corroborated secondary sources)
- **Why it matters here**: INTENT's risk "a rolled-back (older) binary must not strand DB-authored state unreadable" is addressed in practice by (a) hard-failing with an actionable message rather than corrupting, and (b) keeping a real recovery path (backup restore, kept projections) — not by promising indefinite downgrade readability.

## Finding: Migration tooling guidance prefers backup-restore over down-migrations for rollback of destructive changes

- **Claim**: Flyway's official docs state that undo/down migrations "break down in practice" as soon as there are destructive changes, and recommend instead "maintain backwards compatibility between the DB and all versions of the code currently deployed in production" complemented by "a proper, well tested, backup and restore strategy"; Rails likewise requires explicit `down` methods and offers `ActiveRecord::IrreversibleMigration` for data-destroying steps.
- **Source**: https://documentation.red-gate.com/fd/migrations-184127470.html ("Important Notes" under Undo Migrations); https://guides.rubyonrails.org/active_record_migrations.html (sections 3.12–3.13).
- **Confidence**: high
- **Why it matters here**: The cutover ends with deleting the legacy filesystem read/write path — a destructive, effectively irreversible step; the evidence supports rollback = restore the verified `.backup-v<N>` DB copy (and retained legacy files), not writing a reverse file-authority migration.

## Finding: SQLite ships header fields (`application_id`, `user_version`) intended for format/version identification; the repo uses a `schema_version` table instead

- **Claim**: SQLite documents `application_id` (offset 68, "so that utilities such as file(1) can determine the specific file type") and `user_version` for application use, plus `integrity_check`/`quick_check` for corruption detection. The gsd DB records its version in a `schema_version` table (queried via `SELECT MAX(version)`) and touches `PRAGMA user_version` only as a writability probe (`probeDbWritable` re-writes the current value inside an IMMEDIATE transaction and rolls back).
- **Source**: https://www.sqlite.org/pragma.html (`application_id`, `user_version`, `integrity_check`, `quick_check` sections); `src/resources/extensions/gsd/db/engine.ts:2690-2720`; `src/resources/extensions/gsd/db-migration-backup.ts:58`.
- **Confidence**: high
- **Why it matters here**: For the cutover, additionally stamping `PRAGMA user_version` (and a fixed `application_id`) would let older binaries and external tools detect "DB-authored state" without opening tables — a cheap belt-and-braces complement to the existing table journal, directly relevant to downgrade detection.

## Finding: Expand/migrate/contract (ParallelChange) is the canonical bounded dual-run window; the repo is mid-pattern and Fowler's named failure mode is skipping "contract"

- **Claim**: Martin Fowler's ParallelChange splits a backward-incompatible change into expand (both old and new supported), migrate (clients moved incrementally, possibly behind a feature flag), and contract (old removed only after all usage is gone), and warns: "If the contract phase is not executed you might end up in a worse state than you started, therefore you need discipline to finish the transition." The repo's "semantic shadow" mode is precisely the expand phase, and INTENT's `legacy:cleanup:evidence` → `legacy:cleanup:gate` → delete sequence is the disciplined contract phase.
- **Source**: https://martinfowler.com/bliki/ParallelChange.html; INTENT.md summary + success criterion 3; `.project/research/evidence-codebase.md` (semantic-shadow-no-cutover gate finding).
- **Confidence**: high
- **Why it matters here**: This bounds the dual-read/dual-write window by evidence, not by calendar: the legacy path is deleted only when telemetry/tests show zero usage — exactly the "how do we bound the transition window" answer the migration design needs.

## Finding: SQLite's official backup guidance blesses copy-under-lock but the Online Backup API / VACUUM INTO give consistent snapshots without blocking writers; the repo's EXCLUSIVE startup lock makes its file copy safe under multi-worktree use

- **Claim**: sqlite.org documents that the historical "shared lock + copy the file" technique "works well in many scenarios" but blocks writers during the copy, and offers the Online Backup API and `VACUUM INTO` for consistent snapshots of live databases; separately, `PRAGMA locking_mode=EXCLUSIVE` exists for an application that "wants to prevent other processes from accessing the database file". The repo acquires `locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE` at startup before any backup/migration work (engine.ts:191–232), so its checkpoint+copy is taken while no other process (other worktrees/sessions) can write.
- **Source**: https://www.sqlite.org/backup.html (sections 1, 1.1); https://www.sqlite.org/pragma.html (`locking_mode` section); `src/resources/extensions/gsd/db/engine.ts:191-232`.
- **Confidence**: high
- **Why it matters here**: INTENT flags multi-worktree concurrent use as normal; the evidence shows the existing startup EXCLUSIVE claim is what makes the simple file-copy backup atomic and race-free during the cutover — the migration design should run inside that same claim window, not beside it.

## Finding: The repo already has cutover-grade idempotency/replay machinery: hashed backup contracts, owned staging dirs, consent tokens, and replay-conflict error codes

- **Claim**: The legacy-import subsystem verifies backups via sha256 manifests (`snapshot.sqlite`, `VERIFIED_BACKUP_SCHEMA_VERSION = 1`) and stages them in directories owned by `pid-identity-nonce` (`STAGING_OWNER_PATTERN`, legacy-import-backup.ts:67–74); the authority-cutover domain operation defines contract/evidence/consent schema versions and typed errors including `GSD_IDEMPOTENCY_CONFLICT`, `PROJECT_AUTHORITY_CUTOVER_REPLAY_CONFLICT`, `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION`, and records cutover receipts in the DB (project-authority-cutover-domain-operation.ts:32–47).
- **Source**: `src/resources/extensions/gsd/legacy-import-backup.ts:67-74`; `src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts:32-47` (plus imports of `GSD_IDEMPOTENCY_CONFLICT` from `./errors.js`).
- **Confidence**: high
- **Why it matters here**: The idempotency key for the ~/.gsd migration need not be invented: re-running the cutover is safe when keyed on (schema_version row, verified backup hash, cutover receipt) — replay is detected and rejected rather than re-executed, which is exactly INTENT's "idempotent" constraint on live user data.

## Assigned questions — answers

- **[RESEARCH] Migration design for existing `~/.gsd` state: backup format, idempotency key, rollback procedure, downgrade compatibility window** → Evidence-supported proposal:
  - **Backup format/location**: reuse the existing verified backup — `wal_checkpoint(TRUNCATE)` → whole-file copy to `gsd.db.backup-v<N>` beside the live DB → ATTACH + `quick_check` + version match, aborting the cutover on any failure (db-migration-backup.ts). For the file→DB authority flip specifically, additionally keep the legacy `.gsd` file tree untouched (never delete in the same step as the flip; deletion only after `legacy:cleanup:evidence` passes), and use the legacy-import backup contract (sha256 manifest, owned staging dir) where a verified export is needed.
  - **Idempotency key**: the existing composite — `schema_version` table row (chain steps are `IF NOT EXISTS`, so partial re-runs converge) + cutover receipt recorded in the DB + replay detection via the existing `GSD_IDEMPOTENCY_CONFLICT` / `..._REPLAY_CONFLICT` codes. Keying on "schema_version == N AND receipt present" makes re-entry a no-op.
  - **Atomic flip**: perform the flip inside the existing startup EXCLUSIVE claim (engine.ts:191–232) as one transaction: import legacy state → verify → stamp version + receipt → commit. Backup-restore is the only rename-swap, and it happens on recovery, not on the happy path.
  - **Rollback procedure**: restore the verified `gsd.db.backup-v<N>` copy (per Flyway's guidance: prefer tested backup-restore over down-migrations for destructive changes); because legacy files are retained as projections during the transition window, a rolled-back binary can still read them — no reverse migration needed.
  - **Downgrade compatibility window**: keep projection writing byte-compatible with the pre-cutover file format for a bounded number of releases (evidence supports "at least the releases until telemetry shows legacy readers at zero" — the ParallelChange contract phase gated by `legacy:cleanup:evidence`, not a fixed N); beyond that window, rely on the existing refuse-newer guard (engine.ts:455–460, matching Git's repositoryFormatVersion and Firefox's compatibility.ini precedents) with an actionable "upgrade gsd-pi" message. Optionally stamp `PRAGMA user_version` so old binaries and tools can detect DB-authored state cheaply. The exact count of supported downgrade releases is a NEEDS-USER decision (INTENT.md) — no external source fixes a number.
  - **Corruption detection/recovery**: `quick_check` on every backup (existing), `integrity_check` available for deeper checks (sqlite.org pragma doc); recovery = refuse to migrate a DB whose backup fails + restore path above.

## Dead ends

- Mozilla "Dedicated profiles per Firefox installation" official KB (support.mozilla.org/kb/dedicated-profiles-firefox-installation) — page blocked/failed to load; used a support.mozilla.com forum thread plus corroborating blogs for the downgrade-protection precedent instead.
- `https://git-scm.com/docs/gitformat-repository` — 404; repository layout confirmed via `gitrepository-layout` and the format-extension mechanism via `hash-function-transition` instead.
- Flyway docs main URL (documentation.red-gate.com/flyway/learn-more-about-flyway/migrations) — 404; the versioned content page (documentation.red-gate.com/fd/migrations-184127470.html) supplied the same official material.
- VS Code `state.vscdb` / other Electron-app SQLite migration internals — no authoritative public documentation surfaced quickly; SQLite/Git/Firefox/Flyway/Rails precedents were sufficient, so this thread was dropped.
- Searching for a prescriptive "how many released versions must a downgrade stay readable" number — no external source fixes this; it is product policy (INTENT lists it as NEEDS-USER).
