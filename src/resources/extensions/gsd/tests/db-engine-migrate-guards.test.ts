// GSD Extension - Migration guard tests (plan 026).
// Covers the newer-DB refusal in migrateSchema, whole-chain rollback atomicity
// via the _setMigrationFaultForTest seam, the legacy-data guard in initSchema,
// and getCurrentSchemaVersion's empty-table NULL handling.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  SCHEMA_VERSION,
  _setMigrationFaultForTest,
} from '../gsd-db.ts';
import { createDbAdapter } from '../db-adapter.ts';
import { getCurrentSchemaVersion } from '../db-schema-metadata.ts';

const _require = createRequire(import.meta.url);

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-migrate-guards-'));
  return path.join(dir, 'gsd.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Array<Record<string, unknown>> };
  close(): void;
}

function openRawSqliteForTest(dbPath: string): RawDb {
  try {
    const mod = _require('node:sqlite') as { DatabaseSync: new (path: string) => RawDb };
    return new mod.DatabaseSync(dbPath);
  } catch {
    type SqliteCtor = new (path: string) => RawDb;
    const mod = _require('better-sqlite3') as SqliteCtor | { default: SqliteCtor };
    const DatabaseCtor: SqliteCtor = typeof mod === 'function' ? mod : mod.default;
    return new DatabaseCtor(dbPath);
  }
}

function rawColumnNames(raw: RawDb, table: string): string[] {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => r['name'] as string);
}

function rawHasTable(raw: RawDb, table: string): boolean {
  const row = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function rawMaxVersion(raw: RawDb): number | null {
  const row = raw.prepare('SELECT MAX(version) as v FROM schema_version').get();
  return (row?.['v'] as number | null) ?? null;
}

describe('db-engine migrate guards', () => {
  test('getCurrentSchemaVersion returns 0 on an empty schema_version table', () => {
    const sqlite = _require('node:sqlite') as { DatabaseSync: new (path: string) => unknown };
    const adapter = createDbAdapter(new sqlite.DatabaseSync(':memory:'));
    try {
      adapter.exec('CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
      assert.equal(getCurrentSchemaVersion(adapter), 0);
    } finally {
      adapter.close();
    }
  });

  test('refuses to open a DB whose schema is newer than this binary', () => {
    const dbPath = tempDbPath();
    try {
      assert.ok(openDatabase(dbPath), 'fresh open should succeed');
      closeDatabase();

      const raw = openRawSqliteForTest(dbPath);
      raw.exec(
        `INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION + 1}, '2026-01-01T00:00:00Z')`,
      );
      raw.close();

      assert.throws(() => openDatabase(dbPath), /newer than/);
      assert.equal(isDbAvailable(), false, 'no connection may stay open on refusal');
    } finally {
      cleanup(dbPath);
    }
  });

  test('a mid-migration failure rolls back to the starting schema version', () => {
    const dbPath = tempDbPath();
    try {
      assert.ok(openDatabase(dbPath), 'fresh open should succeed');
      closeDatabase();

      // Rewind to v28 and remove a v29 column so the multi-step migration has
      // real work to redo even as later schema versions are added.
      const startVersion = 28;
      const raw = openRawSqliteForTest(dbPath);
      raw.exec('DELETE FROM schema_version');
      raw.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${startVersion}, '2026-01-01T00:00:00Z')`);
      raw.exec('ALTER TABLE slices DROP COLUMN target_repositories');
      raw.exec('ALTER TABLE tasks DROP COLUMN target_repositories');
      raw.close();

      _setMigrationFaultForTest(true);
      try {
        assert.throws(() => openDatabase(dbPath), /migration fault injected/);
      } finally {
        _setMigrationFaultForTest(false);
      }
      assert.equal(isDbAvailable(), false, 'no connection may stay open on migration failure');

      const inspect = openRawSqliteForTest(dbPath);
      try {
        assert.equal(rawMaxVersion(inspect), startVersion, 'version must roll back to the starting version');
        assert.ok(
          !rawColumnNames(inspect, 'slices').includes('target_repositories'),
          'column added by the failed migration must be rolled back',
        );
      } finally {
        inspect.close();
      }

      // The DB is intact — a clean re-open migrates to the current version.
      assert.ok(openDatabase(dbPath), 're-open without the fault should succeed');
      closeDatabase();
      const after = openRawSqliteForTest(dbPath);
      try {
        assert.equal(rawMaxVersion(after), SCHEMA_VERSION);
        assert.ok(rawColumnNames(after, 'slices').includes('target_repositories'));
        assert.equal(rawHasTable(after, 'rework_briefs'), true);
        assert.equal(rawHasTable(after, 'rework_brief_findings'), true);
      } finally {
        after.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  test('a DB with data but no version rows migrates from v1 instead of being stamped current', () => {
    const dbPath = tempDbPath();
    try {
      assert.ok(openDatabase(dbPath), 'fresh open should succeed');
      closeDatabase();

      // Simulate a legacy DB: user data present, version table empty, and a
      // migration-added column missing so we can observe the chain actually run.
      const raw = openRawSqliteForTest(dbPath);
      raw.exec("INSERT INTO milestones (id, title) VALUES ('M001', 'Legacy milestone')");
      raw.exec('DELETE FROM schema_version');
      raw.exec('ALTER TABLE milestones DROP COLUMN vision');
      raw.close();

      assert.ok(openDatabase(dbPath), 'legacy DB open should succeed');
      closeDatabase();

      const inspect = openRawSqliteForTest(dbPath);
      try {
        const versions = inspect.prepare('SELECT version FROM schema_version ORDER BY version').all()
          .map((r) => r['version'] as number);
        assert.equal(versions[0], 1, 'baseline v1 must be recorded, not a fresh-install stamp');
        assert.equal(versions[versions.length - 1], SCHEMA_VERSION, 'migration chain must reach the current version');
        assert.ok(
          rawColumnNames(inspect, 'milestones').includes('vision'),
          'migration-added column must be restored by the chain',
        );
        const row = inspect.prepare('SELECT count(*) as cnt FROM milestones').get();
        assert.equal(row?.['cnt'], 1, 'existing data must survive');
      } finally {
        inspect.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });
});
