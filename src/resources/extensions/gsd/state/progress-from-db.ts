// Project/App: gsd-pi
// File Purpose: DB-authoritative progress reads for integration surfaces
// (`gsd read progress`, packaged MCP `gsd_progress`). ADR-046: the database
// is the sole workflow authority, so integration reads must not serve
// projection data that can lag it.

import { deriveState, invalidateStateCache } from "./derive/index.js";
import { ensureExistingWorkflowDbOpen } from "./derive/db-open.js";
import {
  getHierarchyCompletionCounts,
  getInFlightSliceCount,
  getMilestoneStatusCounts,
  getProjectAuthorityVersion,
  isDbAvailable,
  _getAdapter,
  readTransaction,
} from "../gsd-db.js";
import type { GSDState } from "../types.js";

const MAX_REVISION_ATTEMPTS = 3;

/**
 * Structural mirror of `ProgressResult`
 * (packages/mcp-server/src/readers/state.ts). Kept local so the extension
 * bundle does not import from packages/; the exact key set is pinned by
 * tests/progress-from-db.test.ts.
 */
export interface DbProgressResult {
  activeMilestone: { id: string; title: string } | null;
  activeSlice: { id: string; title: string } | null;
  activeTask: { id: string; title: string } | null;
  phase: string;
  milestones: { total: number; done: number; active: number; pending: number; parked: number };
  slices: { total: number; done: number; active: number; pending: number };
  tasks: { total: number; done: number; pending: number };
  requirements: { active: number; validated: number; deferred: number; outOfScope: number } | null;
  blockers: string[];
  nextAction: string;
}

function toRef(value: { id: string; title: string } | null): { id: string; title: string } | null {
  return value ? { id: value.id, title: value.title } : null;
}

interface ProgressHierarchy {
  counts: ReturnType<typeof getHierarchyCompletionCounts>;
  milestones: ReturnType<typeof getMilestoneStatusCounts>;
  slicesActive: number;
}

interface ProgressStabilityToken {
  revision: number;
  authorityEpoch: number;
  dataVersion: number;
}

function readProgressStabilityToken(): ProgressStabilityToken {
  const authority = getProjectAuthorityVersion();
  const row = _getAdapter()?.prepare("PRAGMA data_version").get();
  const dataVersion = Number(row?.["data_version"]);
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) {
    throw new Error("GSD database data version is not available");
  }
  return { ...authority, dataVersion };
}

function stabilityTokensMatch(
  before: ProgressStabilityToken,
  after: ProgressStabilityToken,
): boolean {
  return before.revision === after.revision
    && before.authorityEpoch === after.authorityEpoch
    && before.dataVersion === after.dataVersion;
}

function readProgressHierarchy(): ProgressHierarchy {
  return readTransaction(() => ({
    counts: getHierarchyCompletionCounts(),
    milestones: getMilestoneStatusCounts(),
    slicesActive: getInFlightSliceCount(),
  }));
}

function buildProgressResult(
  state: GSDState,
  hierarchy: ReturnType<typeof readProgressHierarchy>,
): DbProgressResult {
  const slicesDone = hierarchy.counts.slices;
  const slicesTotal = hierarchy.counts.slicesTotal;
  const tasksDone = hierarchy.counts.tasks;
  const tasksTotal = hierarchy.counts.tasksTotal;

  return {
    activeMilestone: toRef(state.activeMilestone),
    activeSlice: toRef(state.activeSlice),
    activeTask: toRef(state.activeTask),
    phase: state.phase,
    milestones: hierarchy.milestones,
    slices: {
      total: slicesTotal,
      done: slicesDone,
      active: hierarchy.slicesActive,
      pending: slicesTotal - slicesDone - hierarchy.slicesActive,
    },
    tasks: {
      total: tasksTotal,
      done: tasksDone,
      pending: tasksTotal - tasksDone,
    },
    requirements:
      state.requirements && state.requirements.total > 0
        ? {
            active: state.requirements.active,
            validated: state.requirements.validated,
            deferred: state.requirements.deferred,
            outOfScope: state.requirements.outOfScope,
          }
        : null,
    blockers: [...state.blockers],
    nextAction: state.nextAction,
  };
}

/**
 * Derive the integration progress payload from the database. `deriveState`
 * supplies current refs, phase, blockers, and next action (the same source
 * the runtime and auto-mode use); project-wide milestone/slice/task counts
 * come from the read seam, since `deriveState` may be execution-scoped while
 * `ProgressResult` buckets are project-wide.
 *
 * Note: the derive open path runs pending migrations and syncs the
 * milestone queue-order projection (same behavior as `gsd headless status`).
 * Results are bound to stable authority and data-version tokens; under
 * sustained concurrent commits or same-process interleaved writes, a snapshot
 * may still straddle revisions.
 */
export async function readProgressFromDb(basePath: string): Promise<DbProgressResult | null> {
  ensureExistingWorkflowDbOpen(basePath);
  if (!isDbAvailable()) return null;

  invalidateStateCache();
  for (let attempt = 1; ; attempt++) {
    const before = readProgressStabilityToken();
    const state = await deriveState(basePath);
    const result = buildProgressResult(state, readProgressHierarchy());
    const after = readProgressStabilityToken();

    if (stabilityTokensMatch(before, after)) return result;

    if (attempt === MAX_REVISION_ATTEMPTS) return result;
    invalidateStateCache();
  }
}
