// Project/App: gsd-pi
// File Purpose: GSD state contract v1 projection (.gsd/state.json) for external readers like GSD Workbench.
//
// The contract (gsd-workbench docs/state-contract/v1.md) is a small, stable
// JSON surface: readers accept any 1.x and ignore unknown fields. The skills
// own the file; readers never write it. It deliberately tracks the state-
// manifest write boundary: every skill step boundary funnels through
// writeManifest/writeManifestAndFlush. Placeholder milestone inserts, queue-
// order reconciliation, and out-of-band edits that bypass that boundary
// refresh on the next skill run, as tolerated by contract v1 rule 2 and
// ADR-0004. `next` is an approximate hint, not the dependency-aware dispatch
// decision — that stays in state/derive/from-db.ts.

import type { MilestoneRow } from "./db-milestone-artifact-rows.js";
import type { SliceRow } from "./db-task-slice-rows.js";
import { isSkippedForDispatch, toStatus } from "./status-guards.js";

export interface StateContractPhase {
  number: number;
  name: string;
  status: "complete" | "in_progress" | "pending";
}

export interface StateContractNext {
  command: string;
  label: string;
  reason: string;
}

export interface StateContractV1 {
  contract: "1.0.0";
  flavor: "pi";
  milestone: string | null;
  phases: StateContractPhase[];
  next: StateContractNext;
  updated_at: string;
}

function phaseStatus(raw: string): StateContractPhase["status"] {
  const status = toStatus(raw);
  if (status === "complete" || status === "skipped") return "complete";
  return status === "active" || status === "in_progress" ? "in_progress" : "pending";
}

// Same rule as workflow-projections.stripIdPrefix — duplicated here because
// importing it would cycle (workflow-projections → workflow-manifest → here).
function stripIdPrefix(title: string, id: string): string {
  const prefix = `${id}: `;
  let result = title;
  while (result.startsWith(prefix)) result = result.slice(prefix.length);
  return result.trim() || title;
}

function routeNext(active: MilestoneRow | null, phases: StateContractPhase[]): StateContractNext {
  const auto = (label: string, reason: string): StateContractNext => ({ command: "/gsd auto", label, reason });
  if (!active) {
    return { command: "/gsd", label: "Start next milestone", reason: "No active milestone" };
  }
  if (phases.length === 0) {
    return auto(`Plan ${active.id}`, "Active milestone has no slices yet");
  }
  const inProgress = phases.find((p) => p.status === "in_progress");
  if (inProgress) return auto(`Continue ${inProgress.name}`, `Slice ${inProgress.number} in progress`);
  const pending = phases.find((p) => p.status === "pending");
  if (pending) return auto(`Start ${pending.name}`, `Slice ${pending.number} is next`);
  return auto(`Complete ${active.id}`, "All slices closed");
}

/**
 * Build the state contract document from manifest snapshot rows.
 * Pure — callers pass the already-snapshotted milestones/slices so the
 * contract file is always consistent with the manifest written beside it.
 * Rows must be ordered (snapshotState orders both by sequence).
 * Active milestone follows dispatch ordering: the first milestone in queue
 * order for which isSkippedForDispatch returns false. This is the rule
 * reflected by the contract's phases and next hint.
 */
export function buildStateContract(
  milestones: MilestoneRow[],
  slices: SliceRow[],
  updatedAt: string,
): StateContractV1 {
  const active = milestones.find((m) => !isSkippedForDispatch(m.status)) ?? null;

  const phases: StateContractPhase[] = active
    ? slices
        .filter((s) => s.milestone_id === active.id)
        .map((s, i) => ({
          number: s.sequence > 0 ? s.sequence : i + 1,
          name: stripIdPrefix(s.title, s.id),
          status: phaseStatus(s.status),
        }))
    : [];

  const title = active ? stripIdPrefix(active.title, active.id) : "";
  return {
    contract: "1.0.0",
    flavor: "pi",
    milestone: active ? (title ? `${active.id} — ${title}` : active.id) : null,
    phases,
    next: routeNext(active, phases),
    updated_at: updatedAt,
  };
}
