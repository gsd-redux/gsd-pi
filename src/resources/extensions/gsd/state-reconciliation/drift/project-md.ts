// Project/App: gsd-pi
// File Purpose: ADR-017 unregistered-milestone drift handler. Detects
// milestones whose on-disk directory has meaningful content (ROADMAP/
// CONTEXT/SUMMARY) but no DB row, then fails closed with an explicit recovery
// instruction. Markdown hierarchy import is reserved for operator-controlled
// migration/recovery commands, not automatic runtime reconciliation.

import { existsSync } from "node:fs";

import { getAllMilestones, getMilestone, isDbAvailable } from "../../gsd-db.js";
import { findMilestoneIds, parseMilestoneId } from "../../milestone-ids.js";
import { resolveMilestoneFile, resolveMilestonePath } from "../../paths.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type UnregisteredMilestoneDrift = Extract<
  DriftRecord,
  { kind: "unregistered-milestone" }
>;

function milestoneHasContent(basePath: string, milestoneId: string): boolean {
  const roadmap = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  const context = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const summary = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  return (
    (roadmap !== null && existsSync(roadmap)) ||
    (context !== null && existsSync(context)) ||
    (summary !== null && existsSync(summary))
  );
}

/**
 * A directory extracted to a bare `M{NNN}` id is not unregistered when the
 * milestone is actually registered under a `unique_milestone_ids` suffixed id
 * (`M{NNN}-<suffix>`) for the same sequence number. The flat-phase extractor in
 * `milestone-ids` cannot recover the suffix from a descriptive slug (e.g.
 * `07-v40fmq-m007-...-footer-system`), so it falls through to the bare `M007`.
 * Probing the DB for a suffixed row on that sequence resolves the directory to
 * its registered identity instead of firing a false-positive drift (issue
 * #1281).
 */
function hasRegisteredSuffixedVariant(milestoneId: string): boolean {
  const { suffix, num } = parseMilestoneId(milestoneId);
  // Only bare, well-formed `M{NNN}` ids can be ambiguous with a suffixed row.
  if (suffix || num === 0) return false;
  return getAllMilestones().some((m) => {
    const parsed = parseMilestoneId(m.id);
    return parsed.num === num && parsed.suffix !== undefined;
  });
}

export function detectUnregisteredMilestoneDrift(
  _state: GSDState,
  ctx: DriftContext,
): UnregisteredMilestoneDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: UnregisteredMilestoneDrift[] = [];
  for (const milestoneId of findMilestoneIds(ctx.basePath)) {
    if (getMilestone(milestoneId)) continue;
    if (hasRegisteredSuffixedVariant(milestoneId)) continue;
    if (!milestoneHasContent(ctx.basePath, milestoneId)) continue;
    drifts.push({ kind: "unregistered-milestone", milestoneId });
  }
  return drifts;
}

/**
 * The recovery hint deliberately leads with the *targeted*, non-destructive
 * options. The common cause of this drift is a directory left under an old ID
 * after a `unique_milestone_ids` rename, where the right fix is to rename (move)
 * the directory — not a full DB reimport. `/gsd recover --confirm` is a
 * destructive clear-and-reimport of the entire DB and is offered only as a last
 * resort, so users do not reach for it expecting a targeted repair (see issue
 * #826).
 */
function unregisteredMilestoneGuidance(
  record: UnregisteredMilestoneDrift,
  ctx: DriftContext,
): string {
  const dir = resolveMilestonePath(ctx.basePath, record.milestoneId);
  const dirHint = dir ?? `the .gsd directory for ${record.milestoneId}`;
  return (
    `Milestone ${record.milestoneId} exists only as markdown projection ` +
    "(on-disk ROADMAP/CONTEXT/SUMMARY with no authoritative DB row). " +
    "Runtime reconciliation will not import markdown into the DB. Choose one:\n" +
    `  • Rename: if this directory is the same milestone under an old ID (e.g. a unique_milestone_ids rename), move \`${dirHint}\` to the current ID's directory and re-run.\n` +
    `  • Discard: if this milestone is no longer relevant, delete \`${dirHint}\` and re-run.\n` +
    "  • Last resort: `/gsd recover --confirm` performs a destructive full DB clear-and-reimport — it does NOT do a targeted import and can replace or duplicate existing DB milestones."
  );
}

/**
 * Terminal blocker for an unregistered milestone. The project-root DB is
 * authoritative at runtime; markdown-only milestones must be reconciled through
 * an explicit, operator-controlled action so operators opt into changing
 * canonical state. Exposing this as a `blocker` (matching the `artifact-db`
 * convention) surfaces the drift as a pause-with-hint that gates dispatch,
 * instead of a guaranteed repair throw that escalates auto-mode health to red
 * (see issue #1281).
 */
export function describeUnregisteredMilestoneBlocker(
  record: UnregisteredMilestoneDrift,
  ctx: DriftContext,
): string {
  return unregisteredMilestoneGuidance(record, ctx);
}

/**
 * Repair intentionally fails closed. Retained as a defensive fallback for the
 * reconciliation engine; in practice `blocker` short-circuits this drift into a
 * non-fatal pause before repair is ever attempted.
 */
export function repairUnregisteredMilestone(
  record: UnregisteredMilestoneDrift,
  ctx: DriftContext,
): void {
  throw new Error(unregisteredMilestoneGuidance(record, ctx));
}

export const unregisteredMilestoneHandler: DriftHandler<UnregisteredMilestoneDrift> = {
  kind: "unregistered-milestone",
  detect: detectUnregisteredMilestoneDrift,
  blocker: describeUnregisteredMilestoneBlocker,
  repair: repairUnregisteredMilestone,
};
