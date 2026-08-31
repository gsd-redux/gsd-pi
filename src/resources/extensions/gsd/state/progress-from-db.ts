// Project/App: gsd-pi
// File Purpose: DB-authoritative progress reads for integration surfaces
// (`gsd read progress`, packaged MCP `gsd_progress`). ADR-046: the database
// is the sole workflow authority, so integration reads must not serve
// projection data that can lag it.

import { deriveState } from "./derive/index.js";
import { getHierarchyCompletionCounts, getInFlightSliceCount, readTransaction } from "../gsd-db.js";
import type { GSDState } from "../types.js";

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

/**
 * Derive the integration progress payload from the database. `deriveState`
 * supplies current refs, phase, blockers, and next action (the same source
 * the runtime and auto-mode use); project-wide slice/task counts come from
 * the read seam, since `GSDState.progress` is scoped to the active
 * milestone/slice while `ProgressResult` buckets are project-wide.
 *
 * Note: the derive open path runs pending migrations and syncs the
 * milestone queue-order projection (same behavior as `gsd headless status`).
 * Callers must have already decided the DB is present and schema-supported;
 * a locked or unreadable DB should fall back at the call site, not here.
 */
export async function readProgressFromDb(basePath: string): Promise<DbProgressResult> {
  const state: GSDState = await deriveState(basePath);
  const hierarchy = readTransaction(() => ({
    counts: getHierarchyCompletionCounts(),
    slicesActive: getInFlightSliceCount(),
  }));

  const registry = state.registry ?? [];
  const milestonesDone = registry.filter((m) => m.status === "complete").length;
  const milestonesActive = registry.filter((m) => m.status === "active").length;
  const milestonesParked = registry.filter((m) => m.status === "parked").length;

  const slicesDone = hierarchy.counts.slices;
  const slicesTotal = hierarchy.counts.slicesTotal;
  const tasksDone = hierarchy.counts.tasks;
  const tasksTotal = hierarchy.counts.tasksTotal;

  return {
    activeMilestone: toRef(state.activeMilestone),
    activeSlice: toRef(state.activeSlice),
    activeTask: toRef(state.activeTask),
    phase: state.phase,
    milestones: {
      total: registry.length,
      done: milestonesDone,
      active: milestonesActive,
      pending: registry.length - milestonesDone - milestonesActive - milestonesParked,
      parked: milestonesParked,
    },
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
