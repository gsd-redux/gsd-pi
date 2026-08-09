// Project/App: gsd-pi
// File Purpose: Single-writer layer for the ADR-047 liveness backstop ledger —
// owns the block-signature and wedge-record write SQL so the backstop logic in
// auto-liveness-backstop.ts stays a read/orchestration module.

import { getDb } from "../engine.js";

export interface LivenessSignatureKey {
  scopeId: string;
  unitType: string;
  unitId: string;
  inputHash: string;
}

/**
 * Insert-or-increment the occurrence counter row for a block signature and
 * return the post-write count (ADR-047 §3).
 */
export function upsertLivenessBlockSignature(
  key: LivenessSignatureKey,
  guardId: string,
  now: string,
): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO liveness_block_signatures
       (scope_id, guard_id, unit_type, unit_id, input_hash, occurrence_count, first_seen_at, last_seen_at)
     VALUES (:scope, :guard, :utype, :uid, :hash, 1, :now, :now)
     ON CONFLICT(scope_id, unit_type, unit_id, input_hash) DO UPDATE SET
       occurrence_count = occurrence_count + 1,
       guard_id = :guard,
       last_seen_at = :now`,
  ).run({
    ':scope': key.scopeId,
    ':guard': guardId,
    ':utype': key.unitType,
    ':uid': key.unitId,
    ':hash': key.inputHash,
    ':now': now,
  });
  const counted = db.prepare(
    `SELECT occurrence_count FROM liveness_block_signatures
     WHERE scope_id = :scope AND unit_type = :utype AND unit_id = :uid AND input_hash = :hash`,
  ).get({
    ':scope': key.scopeId,
    ':utype': key.unitType,
    ':uid': key.unitId,
    ':hash': key.inputHash,
  }) as { occurrence_count: number } | undefined;
  return counted?.occurrence_count ?? 1;
}

export interface LivenessWedgeInsert {
  wedgeId: string;
  scopeId: string;
  guardId: string;
  unitType: string;
  unitId: string;
  inputHash: string;
  occurrenceCount: number;
  sanctionedExit: string;
  forensicsPath: string | null;
  createdAt: string;
}

/** Persist a freshly-tripped wedge record (ADR-047 §3). */
export function insertLivenessWedgeRecord(wedge: LivenessWedgeInsert): void {
  getDb().prepare(
    `INSERT INTO liveness_wedge_records
       (wedge_id, scope_id, guard_id, unit_type, unit_id, input_hash, occurrence_count,
        sanctioned_exit, forensics_path, created_at, acknowledged_at)
     VALUES (:wid, :scope, :guard, :utype, :uid, :hash, :count, :exit, :forensics, :now, NULL)`,
  ).run({
    ':wid': wedge.wedgeId,
    ':scope': wedge.scopeId,
    ':guard': wedge.guardId,
    ':utype': wedge.unitType,
    ':uid': wedge.unitId,
    ':hash': wedge.inputHash,
    ':count': wedge.occurrenceCount,
    ':exit': wedge.sanctionedExit,
    ':forensics': wedge.forensicsPath,
    ':now': wedge.createdAt,
  });
}

/**
 * Mark a wedge acknowledged and clear its tripped signature counter so
 * auto-mode re-enters with a clean slate for that signature (ADR-047 §5).
 */
export function acknowledgeLivenessWedgeRecord(
  wedgeId: string,
  signature: LivenessSignatureKey,
  now: string,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE liveness_wedge_records SET acknowledged_at = :now WHERE wedge_id = :wid`,
  ).run({ ':now': now, ':wid': wedgeId });
  db.prepare(
    `DELETE FROM liveness_block_signatures
     WHERE scope_id = :scope AND unit_type = :utype AND unit_id = :uid AND input_hash = :hash`,
  ).run({
    ':scope': signature.scopeId,
    ':utype': signature.unitType,
    ':uid': signature.unitId,
    ':hash': signature.inputHash,
  });
}
