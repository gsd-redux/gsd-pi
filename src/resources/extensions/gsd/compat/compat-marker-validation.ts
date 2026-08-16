import { isAbsolute, normalize } from "node:path";

import type { CompatMarker, PlanningMarker, ProjectionEntry } from "./compat-marker.js";

export function isSafeProjectionKey(key: string): boolean {
  if (key.length === 0 || key.includes("\\") || key.includes("\0")) return false;
  if (isAbsolute(key) || /^[A-Za-z]:/.test(key)) return false;
  const normalized = normalize(key);
  return normalized !== ".." && !normalized.startsWith("../") && !isAbsolute(normalized);
}

function isValidProjectionEntry(value: unknown): value is ProjectionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha === "string"
    && Array.isArray(entry.entities)
    && entry.entities.every((entity) => typeof entity === "string");
}

function isValidProjectionMap(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).every(
    ([key, entry]) => isSafeProjectionKey(key) && isValidProjectionEntry(entry),
  );
}

function isValidPlanningMarker(value: unknown): value is PlanningMarker {
  if (typeof value !== "object" || value === null) return false;
  const planning = value as Record<string, unknown>;
  return typeof planning.active === "boolean"
    && (planning.layout === null
      || planning.layout === "flat-phases"
      || planning.layout === "multi-milestone"
      || planning.layout === "legacy-milestone-dir")
    && isValidProjectionMap(planning.projections)
    && isValidProjectionMap(planning.passthrough);
}

export function isValidCompatMarker(value: unknown): value is CompatMarker {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Record<string, unknown>;
  return marker.lastWriter === "gsd-pi"
    && typeof marker.schema === "number"
    && typeof marker.lastProjectedAt === "string"
    && typeof marker.piVersion === "string"
    && isValidProjectionMap(marker.projections)
    && (marker.planning === undefined || isValidPlanningMarker(marker.planning));
}
