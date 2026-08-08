// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler registry and explicit repair phases.

import { completionTimestampHandler } from "./drift/completion.js";
import {
  artifactDbStatusDivergenceHandler,
  completedMilestoneReopenedHandler,
  diskSliceIdDivergenceHandler,
} from "./drift/artifact-db.js";
import { mergeStateHandler } from "./drift/merge-state.js";
import { externalMarkdownEditHandler } from "./drift/external-markdown-edit.js";
import { externalPlanningEditHandler } from "./drift/external-planning-edit.js";
import { unregisteredMilestoneHandler } from "./drift/project-md.js";
import { roadmapDivergenceHandler, roadmapMissingHandler } from "./drift/roadmap.js";
import { sketchFlagHandler } from "./drift/sketch-flag.js";
import { staleRenderHandler } from "./drift/stale-render.js";
import { staleWorkerHandler } from "./drift/stale-worker.js";
import type { DriftHandler } from "./types.js";

export interface ReconciliationRepairPhase {
  name: string;
  /** Stop before later phases when this phase surfaces a terminal blocker. */
  stopOnBlocker?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: ReadonlyArray<DriftHandler<any>>;
}

/**
 * Repairs run phase-by-phase; detection uses the flattened registry (all handlers).
 * External modeled edits are an authority boundary: passthrough bookkeeping may
 * complete, but a modeled-edit blocker must stop DB normalization/re-projection
 * before those later phases can overwrite the user's source bytes.
 */
export const RECONCILIATION_REPAIR_PHASES: ReadonlyArray<ReconciliationRepairPhase> = [
  {
    name: "external-edit-boundary",
    stopOnBlocker: true,
    handlers: [externalMarkdownEditHandler, externalPlanningEditHandler],
  },
  {
    name: "normalize-db",
    handlers: [
      sketchFlagHandler,
      mergeStateHandler,
      staleWorkerHandler,
      unregisteredMilestoneHandler,
      diskSliceIdDivergenceHandler,
      completedMilestoneReopenedHandler,
      artifactDbStatusDivergenceHandler,
    ],
  },
  {
    name: "re-project",
    // roadmap-missing sits beside roadmap-divergence but cannot fight it:
    // detection for ALL handlers runs before any repair, and both repairs
    // invoke the same renderRoadmapFromDb, so a missing-file render can never
    // create state the divergence repair would undo (#1634).
    handlers: [staleRenderHandler, roadmapMissingHandler, roadmapDivergenceHandler, completionTimestampHandler],
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DRIFT_REGISTRY: ReadonlyArray<DriftHandler<any>> =
  RECONCILIATION_REPAIR_PHASES.flatMap((phase) => phase.handlers);

export function handlerPhaseIndex(kind: string): number {
  return RECONCILIATION_REPAIR_PHASES.findIndex((phase) =>
    phase.handlers.some((handler) => handler.kind === kind),
  );
}
