import { readdirSync } from "node:fs";

import { milestonesDir } from "./paths.js";

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const match = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

export function findMilestoneIds(basePath: string): string[] {
  const dir = milestonesDir(basePath);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const match = entry.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/);
        if (match) return match[1];
        // Flat-phase layout: `01-some-slug` directories carry the canonical
        // M001-form ID; returning the raw dirname orphans every ID-keyed
        // lookup (dispatch sweep, orphan detection) against the milestone.
        const flatPhase = entry.name.match(/^(\d+)-/);
        if (flatPhase) return `M${flatPhase[1]!.padStart(3, "0")}`;
        return entry.name;
      })
      .sort(milestoneIdSort);
  } catch {
    return [];
  }
}
