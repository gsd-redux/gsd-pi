// Project/App: gsd-pi
// File Purpose: `.planning/` compat helpers — layout capture and projection sha
// recording. Parallel to the .gsd/ write-time flush in markdown-renderer.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "./compat-marker.js";

export interface PlanningProjectionWrite {
  relPath: string;
  entities: string[];
  sha?: string;
  passthrough?: boolean;
}

export function isPlanningPassthroughRelPath(relPath: string): boolean {
  if (relPath.startsWith("codebase/") || relPath.startsWith("research/")) return true;
  if (relPath === "config.json") return true;
  const name = relPath.split("/").pop() ?? relPath;
  if (name === "PATTERNS.md" || name === "REVIEWS.md") return true;
  if (name.endsWith("-DISCUSSION-LOG.md")) return true;
  if (name.endsWith("-RESEARCH.md") && !name.endsWith("-PLAN.md")) return true;
  return false;
}

export function walkPlanningRelPaths(planningDir: string, prefix = ""): string[] {
  const paths: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(planningDir, prefix), { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "workstreams") continue;
      paths.push(...walkPlanningRelPaths(planningDir, rel));
    } else {
      paths.push(rel);
    }
  }
  return paths;
}

/**
 * Record freshly written `.planning/` projection files in the compat marker.
 */
export function applyPlanningProjectionWrites(
  basePath: string,
  writes: PlanningProjectionWrite[],
): void {
  if (writes.length === 0) return;
  const marker = readCompatMarker(basePath);
  if (!marker.planning) {
    marker.planning = { active: true, layout: null, projections: {}, passthrough: {} };
  }
  marker.planning.active = true;
  for (const write of writes) {
    const abs = join(basePath, ".planning", write.relPath);
    if (!existsSync(abs)) continue;
    const entry = {
      sha: write.sha ?? computeProjectionSha(readFileSync(abs, "utf-8")),
      entities: write.entities,
    };
    const map = write.passthrough ? marker.planning.passthrough : marker.planning.projections;
    map[write.relPath] = entry;
  }
  marker.lastWriter = "gsd-pi";
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(basePath, marker);
}
