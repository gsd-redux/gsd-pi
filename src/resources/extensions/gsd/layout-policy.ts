// Project/App: gsd-pi
// File Purpose: Single source of truth for the on-disk layout inside .gsd/.
// Adopted gsd-core's flat-phase structure so both tools read/write the same
// shape. The 17 path resolvers in paths.ts delegate here; the renderer and
// importer route through them.
//
// DB table/column names (milestones/slices/tasks, milestone_id, etc.) stay
// unchanged — those are internal identifiers. Only the on-disk segment names
// and file-naming change.

/** Root directory name. Both gsd-core (Stage 2) and gsd-pi standardize here. */
export const LAYOUT_ROOT = ".gsd";

/** Segment names inside the root. */
export const LAYOUT_SEGMENTS = {
  /** Was "milestones". A phase = one unit of work (gsd-core vocabulary). */
  level1: "phases",
} as const;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Phase directory name: `NN-slug` (e.g. "01-foundation").
 * Matches gsd-core's `phases/NN-name/` convention.
 */
export function phaseDirName(phaseNum: number, slug: string): string {
  return `${pad(phaseNum)}-${slug}`;
}

/**
 * Plan file name: `NN-MM-SUFFIX.md` (e.g. "01-01-PLAN.md").
 * Matches gsd-core's per-plan file convention.
 */
export function planFileName(phaseNum: number, planNum: number, suffix: string): string {
  return `${pad(phaseNum)}-${pad(planNum)}-${suffix}.md`;
}

/** DB path: `.gsd/gsd.db`. gsd-core ignores this file. */
export function dbPath(basePath: string): string {
  return `${basePath}/${LAYOUT_ROOT}/gsd.db`.replaceAll(/\/+/g, "/");
}

/**
 * Extract the numeric portion of a milestone id (M001 → 1).
 * Used by the renderer to derive the phase number from the DB's milestone_id.
 */
export function milestoneIdToPhaseNum(milestoneId: string): number {
  // No $ anchor: accepts bare (M012), team-suffixed (M012-abc123), and legacy numeric IDs.
  const m = milestoneId.match(/^M0*(\d+)/i);
  if (!m && /^\d+$/.test(milestoneId)) return Number.parseInt(milestoneId, 10);
  return m ? Number.parseInt(m[1]!, 10) : 1;
}

const TEAM_MILESTONE_ID_RE = /^M(\d{3})(?:-([a-z0-9]{6}))?$/i;
const LEADING_MILESTONE_ID_TOKENS = /^(?:M\d{3}(?:-[a-z0-9]{6})?(?:[\s:_-]+|$))+/i;

/** Team-mode suffix from milestone ids like M001-abc123. */
export function milestoneIdUniqueSuffix(milestoneId: string): string | undefined {
  return milestoneId.match(TEAM_MILESTONE_ID_RE)?.[2]?.toLowerCase();
}

const CANONICAL_SLICE_ID_RE = /^S0*(\d+)(?:-.*)?$/i;

/**
 * Extract the numeric portion of a slice id (S01 → 1, S01-replan → 1).
 * Used by the renderer to derive the plan number from the DB's slice_id.
 */
export function sliceIdToPlanNum(sliceId: string): number {
  const m = sliceId.match(CANONICAL_SLICE_ID_RE);
  return m ? Number.parseInt(m[1]!, 10) : 1;
}

/**
 * File-name segment identifying a slice inside flat-phase plan file names
 * (#1975). Canonical S-ids (S01, S01-replan) keep the zero-padded plan
 * number, so existing NN-MM-SUFFIX.md layouts are untouched. Any other id
 * (e.g. a remediation slice R01 added by gsd_reassess_roadmap) uses the id
 * itself: digits guessed from a non-canonical id would map the slice onto
 * another slice's files (R01 → S01's 01-01-SUMMARY.md), on both read and
 * write.
 */
export function slicePlanSegment(sliceId: string): string {
  const m = sliceId.match(CANONICAL_SLICE_ID_RE);
  if (m) return pad(Number.parseInt(m[1]!, 10));
  if (/^\d+$/.test(sliceId)) return pad(Number.parseInt(sliceId, 10));
  return sliceId;
}

/**
 * Plan file name derived from a slice id: `NN-<segment>-SUFFIX.md`
 * (e.g. "01-01-PLAN.md" for S01, "01-R01-PLAN.md" for R01).
 */
export function slicePlanFileName(phaseNum: number, sliceId: string, suffix: string): string {
  return `${pad(phaseNum)}-${slicePlanSegment(sliceId)}-${suffix}.md`;
}

/**
 * Derive a stable, deterministic, filesystem-safe slug from a milestone title.
 * Used for the phase directory name so the layout is human-readable.
 *
 * Stability is load-bearing: the renderer must produce the same slug for the
 * same title on every run, or the directory churns on every projection.
 */
export function derivePhaseSlug(title: string): string {
  const trimmed = title.trim();
  const withoutIds = trimmed.replace(LEADING_MILESTONE_ID_TOKENS, "").trim();
  const source = withoutIds || trimmed;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "phase";
}

/**
 * Canonical flat-phase directory name for a milestone.
 * Team-suffix ids contribute the suffix once; title text that already
 * contains the milestone id is not baked into the slug a second time.
 */
export function canonicalPhaseDirName(milestoneId: string, title?: string): string {
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const suffix = milestoneIdUniqueSuffix(milestoneId);
  const idSlug = derivePhaseSlug(milestoneId);
  const slug = derivePhaseSlug(title || milestoneId);
  const rest = slug === idSlug ? "" : slug;
  if (suffix) {
    return phaseDirName(phaseNum, rest ? `${suffix}-${rest}` : suffix);
  }
  return phaseDirName(phaseNum, rest || idSlug);
}
