// Project/App: gsd-pi
// File Purpose: Dispatch History module — the single home for the auto
// orchestrator's dispatch-decision window, cross-session rehydration, and
// stuck detection (#482 / #442 deepening).
/**
 * auto/dispatch-history.ts — Dispatch History module.
 *
 * Owns the sliding window of recent dispatch decisions that the Auto
 * Orchestration module consults for idempotency and stuck-loop detection.
 *
 * Before this module existed the orchestrator kept a private in-memory
 * `dispatchKeyWindow: string[]` that was reset to `[]` in start()/resume().
 * Because a fresh orchestrator is constructed per session, the window never
 * saw dispatches from a previous session — a unit could be re-dispatched
 * across session restarts indefinitely (issue #482: 146 re-dispatches of the
 * same unit). This module rehydrates the window from the DB dispatch ledger
 * (`unit_dispatches`, via getRecentUnitKeysForProjectRoot) so stuck detection
 * survives process restarts, and it delegates the verdict to the full
 * detect-stuck rule set (repeat-error / consecutive / oscillation / ENOENT,
 * with retry-budget suppression) instead of the bare saturation count.
 *
 * Key format: the canonical dispatch key is `${unitType}:${unitId}`
 * (e.g. "execute-task:M001/S01/T01"). The legacy auto/phases.ts path and the
 * DB rehydration helper use `${unitType}/${unitId}`; normalizeDispatchKey
 * converts those on rehydrate so one format lives in the window. The key
 * grammar itself lives in auto/dispatch-key.ts and is re-exported here for
 * import stability.
 */

import type { WindowEntry } from "./types.js";
import { buildDispatchKey, normalizeDispatchKey, parseDispatchKey } from "./dispatch-key.js";
import { detectStuck } from "./detect-stuck.js";
import {
  getLatestForUnit,
  getRecentUnitKeysForProjectRoot,
} from "../db/unit-dispatches.js";
import { debugLog } from "../debug-logger.js";

export { buildDispatchKey, normalizeDispatchKey, parseDispatchKey } from "./dispatch-key.js";

/**
 * Size of the dispatch-decision ring buffer. Mirrors the legacy
 * `STUCK_WINDOW_SIZE` in auto/phases.ts so behaviour is preserved across the
 * cutover (issue #5791).
 */
export const STUCK_WINDOW_SIZE = 6;

export interface DispatchHistory {
  /**
   * Record a dispatch decision in the window (evicting oldest-first past the
   * window size). When the window already holds an entry for the same unit,
   * attaches the latest ledger error summary so the repeat-error and ENOENT
   * stuck rules can fire; first-time dispatches (the common case) skip the
   * ledger lookup entirely. Returns the canonical key.
   */
  recordDispatch(unitType: string, unitId: string): string;
  /** Read-only view of the current window, oldest-first. */
  getRecentWindow(): readonly WindowEntry[];
  /** Number of window entries matching the given canonical key. */
  countMatching(key: string): number;
  /**
   * Run the full detect-stuck rule set over the window (all four rules plus
   * retry-budget suppression via the dispatch ledger).
   */
  detectStuck(): { stuck: true; reason: string } | null;
  /**
   * Seed the window from the DB dispatch ledger (cross-session continuity,
   * #482). Legacy `${unitType}/${unitId}` keys are normalized. Degrades to a
   * no-op when the ledger is unavailable. Returns the number of entries
   * rehydrated.
   */
  rehydrate(): number;
  /** Clear the window after a successful stuck recovery (or hard stop). */
  clearOnRecovery(): void;
}

export interface DispatchHistoryOptions {
  /**
   * Stable project scope used to rehydrate from the dispatch ledger. Resolved
   * lazily so worktree adoption after construction is respected. Return
   * null/empty to skip rehydration.
   */
  resolveScopeId: () => string | null;
  windowSize?: number;
}

/**
 * Fetch the latest dispatch ledger error for a unit, the single canonical
 * lookup shared by the DispatchHistory window and the legacy
 * `loopState.recentUnits` path in dispatch.ts. The ledger keys rows by the
 * bare unit id with the unit type in its own column, so the lookup must use
 * the bare id and require a unit_type match (a compound `type/id` key would
 * miss the row, and another unit type's error on the same id must never be
 * attached — it would trip the repeat-error rule spuriously).
 */
export function lookupLatestLedgerError(unitType: string, unitId: string): string | undefined {
  try {
    const row = getLatestForUnit(unitId);
    if (!row || row.unit_type !== unitType) return undefined;
    return row.error_summary ?? undefined;
  } catch {
    return undefined;
  }
}

export function createDispatchHistory(options: DispatchHistoryOptions): DispatchHistory {
  const windowSize = options.windowSize ?? STUCK_WINDOW_SIZE;
  let window: WindowEntry[] = [];

  return {
    recordDispatch(unitType: string, unitId: string): string {
      const key = buildDispatchKey(unitType, unitId);
      // Ledger errors only feed the repeat-error/ENOENT rules, which need a
      // prior occurrence of the same unit in the window — first-dispatch
      // advances (the common case) pay zero DB cost.
      const error = window.some((entry) => entry.key === key)
        ? lookupLatestLedgerError(unitType, unitId)
        : undefined;
      window.push({ key, error });
      while (window.length > windowSize) window.shift();
      return key;
    },

    getRecentWindow(): readonly WindowEntry[] {
      return window;
    },

    countMatching(key: string): number {
      return window.filter((entry) => entry.key === key).length;
    },

    detectStuck(): { stuck: true; reason: string } | null {
      return detectStuck(window);
    },

    rehydrate(): number {
      const scopeId = options.resolveScopeId();
      if (!scopeId) return 0;
      try {
        const persisted = getRecentUnitKeysForProjectRoot(scopeId, windowSize);
        if (persisted.length === 0) return 0;
        const rebuilt: WindowEntry[] = [];
        for (const { key } of persisted) {
          const normalized = normalizeDispatchKey(key);
          const parsed = parseDispatchKey(normalized);
          const error =
            parsed && rebuilt.some((entry) => entry.key === normalized)
              ? lookupLatestLedgerError(parsed.unitType, parsed.unitId)
              : undefined;
          rebuilt.push({ key: normalized, error });
        }
        window = rebuilt;
        while (window.length > windowSize) window.shift();
        return window.length;
      } catch (err) {
        debugLog("dispatchHistory", {
          phase: "rehydrate-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return 0;
      }
    },

    clearOnRecovery(): void {
      window = [];
    },
  };
}
