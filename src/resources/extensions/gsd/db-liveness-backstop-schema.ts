// Project/App: gsd-pi
// File Purpose: Liveness-backstop tables (ADR-047) — DB-persisted block-signature
// counters and wedge records for the ADR-047 auto-mode liveness backstop.

import type { DbAdapter } from './db-adapter.js';

const LIVENESS_BACKSTOP_SCHEMA_OBJECTS = [
  ['table', 'liveness_block_signatures'],
  ['table', 'liveness_wedge_records'],
  ['index', 'idx_liveness_wedges_open'],
] as const;

/** Whether every non-versioned ADR-047 schema object is present. */
export function hasLivenessBackstopSchema(db: DbAdapter): boolean {
  const rows = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE name IN (
      'liveness_block_signatures',
      'liveness_wedge_records',
      'idx_liveness_wedges_open'
    )
  `).all();
  return LIVENESS_BACKSTOP_SCHEMA_OBJECTS.every(([type, name]) =>
    rows.some((row) => row['type'] === type && row['name'] === name));
}

/**
 * ADR-047: the backstop's ledger must survive process restarts — a restart
 * was previously a silent counter reset (#1622, #1626 looped for hours).
 * Occurrence counting is keyed by stable guard identity, target identity, and
 * the hash of what that guard read (ADR §3).
 */
export function createLivenessBackstopSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS liveness_block_signatures (
      scope_id TEXT NOT NULL,
      guard_id TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, guard_id, unit_type, unit_id, input_hash)
    );

    CREATE TABLE IF NOT EXISTS liveness_wedge_records (
      wedge_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      guard_id TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL,
      sanctioned_exit TEXT NOT NULL,
      forensics_path TEXT,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_liveness_wedges_open
      ON liveness_wedge_records(scope_id)
      WHERE acknowledged_at IS NULL;
  `);
}
