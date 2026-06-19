// Project/App: gsd-pi
// File Purpose: Pre-migration backup helper for GSD database schema upgrades.

import type { DbAdapter } from "./db-adapter.js";

export interface MigrationBackupDeps {
  existsSync(path: string): boolean;
  copyFileSync(src: string, dest: string): void;
  logWarning(scope: string, message: string): void;
}

export class MigrationBackupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MigrationBackupError";
  }
}

export function isMigrationBackupError(err: unknown): err is MigrationBackupError {
  return err instanceof MigrationBackupError;
}

export function backupDatabaseBeforeMigration(
  db: DbAdapter,
  dbPath: string | null,
  currentVersion: number,
  deps: MigrationBackupDeps,
): void {
  if (!dbPath || dbPath === ":memory:" || !deps.existsSync(dbPath)) return;

  try {
    const backupPath = `${dbPath}.backup-v${currentVersion}`;
    if (deps.existsSync(backupPath)) return;

    checkpointWal(db);
    deps.copyFileSync(dbPath, backupPath);
  } catch (backupErr) {
    const error = toMigrationBackupError(backupErr);
    deps.logWarning("db", `Pre-migration backup failed: ${error.message}`);
    throw error;
  }
}

function checkpointWal(db: DbAdapter): void {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!isCheckpointComplete(row)) {
    const busy = formatCheckpointValue(row, "busy");
    const log = formatCheckpointValue(row, "log");
    const checkpointed = formatCheckpointValue(row, "checkpointed");
    throw new MigrationBackupError(
      `WAL checkpoint incomplete: busy=${busy} log=${log} checkpointed=${checkpointed}`,
    );
  }
}

function isCheckpointComplete(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  const busy = Number(row["busy"]);
  const log = Number(row["log"]);
  const checkpointed = Number(row["checkpointed"]);
  if (!Number.isFinite(busy) || !Number.isFinite(log) || !Number.isFinite(checkpointed)) return false;
  return busy === 0 && log === checkpointed;
}

function formatCheckpointValue(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return value === undefined ? "unknown" : String(value);
}

function toMigrationBackupError(err: unknown): MigrationBackupError {
  if (isMigrationBackupError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MigrationBackupError(message, err);
}
