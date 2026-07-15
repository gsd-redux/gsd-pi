// Project/App: gsd-pi
// File Purpose: Typed soft-state writes for milestone-status observation turns.

import type { DbAdapter } from "../../db-adapter.js";

export function deleteMilestoneStatusObservationTurn(
  database: DbAdapter,
  key: string,
  expectedValue?: string,
): boolean {
  const valuePredicate = expectedValue === undefined ? "" : " AND value_json = :value_json";
  const result = database.prepare(`
    DELETE FROM runtime_kv
    WHERE scope = 'global' AND scope_id = '' AND key = :key${valuePredicate}
  `).run({
    ":key": key,
    ...(expectedValue === undefined ? {} : { ":value_json": expectedValue }),
  });
  return Number((result as { changes?: unknown }).changes ?? 0) > 0;
}

export function writeMilestoneStatusObservationTurn(
  database: DbAdapter,
  input: { key: string; valueJson: string; updatedAt: string },
): void {
  database.prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', :key, :value_json, :updated_at)
    ON CONFLICT (scope, scope_id, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run({
    ":key": input.key,
    ":value_json": input.valueJson,
    ":updated_at": input.updatedAt,
  });
}

export function updateMilestoneStatusObservationTurn(
  database: DbAdapter,
  input: { key: string; expectedValueJson: string; valueJson: string; updatedAt: string },
): boolean {
  const result = database.prepare(`
    UPDATE runtime_kv
    SET value_json = :value_json, updated_at = :updated_at
    WHERE scope = 'global'
      AND scope_id = ''
      AND key = :key
      AND value_json = :expected_value_json
  `).run({
    ":key": input.key,
    ":expected_value_json": input.expectedValueJson,
    ":value_json": input.valueJson,
    ":updated_at": input.updatedAt,
  });
  return Number((result as { changes?: unknown }).changes ?? 0) > 0;
}
