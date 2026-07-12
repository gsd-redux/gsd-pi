// Project/App: gsd-pi
// File Purpose: `.planning/` compat helpers — layout capture and projection sha
// recording. Parallel to the .gsd/ write-time flush in markdown-renderer.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
  type PlanningLayout,
} from "./compat-marker.js";
import { logWarning } from "../workflow-logger.js";

export interface PlanningProjectionWrite {
  relPath: string;
  entities: string[];
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

// Files that gsd-pi creates in .gsd/ at startup and that do not constitute
// markdown content written by gsd-core. Excluded from the content check so a
// .planning/-only project that already has a gsd.db (but no milestone markdown)
// is not mistakenly treated as a coexistence project.
const KNOWN_NON_CONTENT_FILES = new Set([
  "gsd.db",
  "gsd.db-wal",
  "gsd.db-shm",
  "completed-units.json",
]);

export function gsdTreeHasContent(basePath: string): boolean {
  const gsdDir = join(basePath, ".gsd");
  return (
    existsSync(gsdDir) &&
    readdirSync(gsdDir).some(
      (name) => !name.startsWith(".") && !KNOWN_NON_CONTENT_FILES.has(name),
    )
  );
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
      sha: computeProjectionSha(readFileSync(abs, "utf-8")),
      entities: write.entities,
    };
    const map = write.passthrough ? marker.planning.passthrough : marker.planning.projections;
    map[write.relPath] = entry;
  }
  marker.lastWriter = "gsd-pi";
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(basePath, marker);
}

export interface CapturePlanningCompatOptions {
  dryRun?: boolean;
}

/**
 * Capture-on-first-read: infer `.planning/` layout from disk, import content
 * into the DB so gsd-pi's projection reflects gsd-core's tree instead of
 * overwriting it, then activate the compat marker. Projection shas are seeded
 * by drift repair / write-time hooks — not from raw disk here.
 *
 * Must only be called when !dryRun — it writes both the DB and the marker.
 */
export async function capturePlanningCompatIfNeeded(
  basePath: string,
  options?: CapturePlanningCompatOptions,
): Promise<void> {
  if (options?.dryRun) return;

  const planningDir = join(basePath, ".planning");
  if (!existsSync(planningDir)) return;

  const marker = readCompatMarker(basePath);
  if (marker.planning?.active && marker.planning.layout) return;

  // First encounter: parse layout, import content into the DB, then activate the
  // marker. When `.gsd/` already exists (coexistence), import from disk via
  // migrateHierarchyToDb and do not call writeGSDDirectory — reconcile runs
  // external-markdown-edit before external-planning-edit and must not destroy
  // gsd-core `.gsd/` edits before that pipeline can see them. Planning-only
  // projects materialize `.gsd/` from the parsed tree first, then import.
  const { parsePlanningDirectory } = await import("../migrate/parser.js");
  const { detectPlanningLayout } = await import("../migrate/layout-detect.js");
  const parsed = await parsePlanningDirectory(planningDir);
  const layout: PlanningLayout | null = detectPlanningLayout(parsed);
  if (!layout) return;

  // Import into the DB. Dynamic imports break the module-init cycle
  // (planning-compat ← reconcile ← state ← md-importer). Matches the import
  // pattern in repairExternalPlanningEdit.
  try {
    const { migrateHierarchyToDb } = await import("../md-importer.js");
    const { invalidateStateCache } = await import("../state.js");
    if (!gsdTreeHasContent(basePath)) {
      const { transformToGSD } = await import("../migrate/transformer.js");
      const { writeGSDDirectory } = await import("../migrate/writer.js");
      const gsdProject = transformToGSD(parsed);
      await writeGSDDirectory(gsdProject, basePath);
    }
    migrateHierarchyToDb(basePath);
    invalidateStateCache();
  } catch (e) {
    logWarning(
      "reconcile",
      `planning DB import failed on initial capture — reconcile may overwrite gsd-core content: ${(e as Error).message}`,
    );
    return;
  }

  // Activate the marker. Leave projections/passthrough empty: the next
  // writePlanningDirectory → applyPlanningProjectionWrites call will seed
  // accurate SHAs from the normalized output rather than the raw gsd-core files.
  const freshMarker = readCompatMarker(basePath);
  if (!freshMarker.planning) {
    freshMarker.planning = { active: false, layout: null, projections: {}, passthrough: {} };
  }
  freshMarker.planning.active = true;
  freshMarker.planning.layout = layout;
  writeCompatMarker(basePath, freshMarker);
}
