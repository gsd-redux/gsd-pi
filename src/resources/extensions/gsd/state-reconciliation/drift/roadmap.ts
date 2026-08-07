// Project/App: gsd-pi
// File Purpose: ADR-017 roadmap-divergence drift handler. Detects mismatches
// between ROADMAP.md (parsed slice sequence, depends declarations, and
// checkboxes) and the DB slice rows for that milestone, then re-renders the
// ROADMAP projection from the authoritative DB rows.

import { existsSync, readFileSync } from "node:fs";

import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "../../gsd-db.js";
import { renderRoadmapFromDb } from "../../markdown-renderer.js";
import { findMilestoneIds } from "../../milestone-ids.js";
import { parseRoadmap } from "../../parsers-legacy.js";
import { resolveMilestoneFile } from "../../paths.js";
import { isClosedStatus, isSkippedForDispatch } from "../../status-guards.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type RoadmapDivergenceDrift = Extract<
  DriftRecord,
  { kind: "roadmap-divergence" }
>;

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getSlicesReadyForDivergenceCheck(
  milestoneId: string,
  dbSlices: ReturnType<typeof getMilestoneSlices>,
): Set<string> {
  const ready = new Set<string>();
  for (const slice of dbSlices) {
    if (isClosedStatus(slice.status) || getSliceTasks(milestoneId, slice.id).length > 0) {
      ready.add(slice.id);
    }
  }
  return ready;
}

function milestoneHasDivergence(
  basePath: string,
  milestoneId: string,
): boolean {
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath || !existsSync(roadmapPath)) return false;

  let roadmap: ReturnType<typeof parseRoadmap>;
  try {
    roadmap = parseRoadmap(readFileSync(roadmapPath, "utf-8"));
  } catch {
    return false;
  }

  // Mirror renderRoadmapFromDb's filter (#1619): the ROADMAP projection omits
  // skipped slices, so the detector must compare against the same view.
  // Without this, a skipped slice counts as "ready" (skipped ∈
  // RAW_CLOSED_STATUSES) but never appears in the rendered markdown, so the
  // absence/order checks below report a divergence that re-rendering can never
  // repair — reconcileBeforeDispatch then throws on every dispatch.
  const dbSlices = getMilestoneSlices(milestoneId).filter((s) => s.status !== "skipped");
  const dbSliceMap = new Map(dbSlices.map((s) => [s.id, s]));
  const dbSliceOrder = new Map(dbSlices.map((s, index) => [s.id, index]));
  const readySliceIds = getSlicesReadyForDivergenceCheck(milestoneId, dbSlices);
  if (dbSlices.length > 0 && readySliceIds.size === 0) {
    return false;
  }
  const roadmapSliceIds = new Set<string>();

  for (let i = 0; i < roadmap.slices.length; i++) {
    const roadmapSlice = roadmap.slices[i]!;
    roadmapSliceIds.add(roadmapSlice.id);
    const dbSlice = dbSliceMap.get(roadmapSlice.id);
    if (!dbSlice) return true; // Roadmap has a slice the DB doesn't.
    if (!readySliceIds.has(dbSlice.id)) continue;
    if (dbSliceOrder.get(dbSlice.id) !== i) return true;
    if (!arraysEqual(dbSlice.depends, roadmapSlice.depends)) return true;
    if (isClosedStatus(dbSlice.status) !== roadmapSlice.done) return true;
  }
  for (const dbSlice of dbSlices) {
    if (!readySliceIds.has(dbSlice.id)) continue;
    if (!roadmapSliceIds.has(dbSlice.id)) return true;
  }
  return false;
}

export function detectRoadmapDivergenceDrift(
  _state: GSDState,
  ctx: DriftContext,
): RoadmapDivergenceDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: RoadmapDivergenceDrift[] = [];
  for (const milestoneId of findMilestoneIds(ctx.basePath)) {
    // Skip milestones that don't yet have a DB row — that's the
    // unregistered-milestone drift handler's responsibility.
    const milestone = getMilestone(milestoneId);
    if (!milestone) continue;
    if (isSkippedForDispatch(milestone.status)) continue;
    if (milestoneHasDivergence(ctx.basePath, milestoneId)) {
      drifts.push({ kind: "roadmap-divergence", milestoneId });
    }
  }
  return drifts;
}

/**
 * Repair a milestone's roadmap divergence by regenerating the projection from
 * DB rows. ROADMAP.md is a projection; runtime reconciliation must not import
 * slice presence, sequence, dependencies, or checkbox state from markdown.
 */
export async function repairRoadmapDivergence(
  record: RoadmapDivergenceDrift,
  ctx: DriftContext,
): Promise<void> {
  await renderRoadmapFromDb(ctx.basePath, record.milestoneId);
}

export const roadmapDivergenceHandler: DriftHandler<RoadmapDivergenceDrift> = {
  kind: "roadmap-divergence",
  detect: detectRoadmapDivergenceDrift,
  repair: repairRoadmapDivergence,
};
