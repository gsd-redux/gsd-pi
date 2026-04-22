// GSD2 — Extension — Unified Cache Invalidation
import { invalidateStateCache } from './state.js';
import { clearPathCache } from './paths.js';
import { clearParseCache } from './files.js';

/**
 * Invalidate all GSD runtime read caches in one call.
 *
 * Call this after file writes, milestone transitions, merge reconciliation,
 * or any operation that changes .gsd/ contents on disk. Forgetting to clear
 * any single cache causes stale reads (see #431).
 */
export function invalidateAllCaches(): void {
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
}
