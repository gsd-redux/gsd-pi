// Project/App: gsd-pi
// File Purpose: Dispatch-key grammar — the single home for building, parsing,
// and normalizing the auto orchestrator's dispatch keys.
/**
 * auto/dispatch-key.ts — Dispatch-key grammar.
 *
 * Canonical key: `${unitType}:${unitId}` (e.g. "execute-task:M001/S01/T01").
 * Legacy key: `${unitType}/${unitId}` (auto/phases.ts, DB rehydration). Unit
 * ids themselves contain "/" (M001/S01/T01) — the first segment is the unit
 * type.
 *
 * Leaf node in the import DAG: the orchestrator and the ADR-047 liveness
 * backstop consume this grammar, so it lives below them.
 */

/** Build the canonical dispatch key for a unit. One format, one home. */
export function buildDispatchKey(unitType: string, unitId: string): string {
  return `${unitType}:${unitId}`;
}

/** Split a canonical or legacy dispatch key into its unit type and id. */
export function parseDispatchKey(key: string): { unitType: string; unitId: string } | null {
  const colon = key.indexOf(":");
  if (colon > 0) {
    return { unitType: key.slice(0, colon), unitId: key.slice(colon + 1) };
  }
  const slash = key.indexOf("/");
  if (slash > 0) {
    return { unitType: key.slice(0, slash), unitId: key.slice(slash + 1) };
  }
  return null;
}

/** Normalize a legacy `${unitType}/${unitId}` key to the canonical format. */
export function normalizeDispatchKey(key: string): string {
  if (key.includes(":")) return key;
  const parsed = parseDispatchKey(key);
  return parsed ? buildDispatchKey(parsed.unitType, parsed.unitId) : key;
}
