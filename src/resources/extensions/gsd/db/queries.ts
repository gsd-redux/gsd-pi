// Project/App: gsd-pi
// File Purpose: Query Module — the read-only seam of the DB layer.
// SELECT-only wrappers, read through the shared engine handle (getDbOrNull()).
// Contains NO write SQL (asserted by tests/single-writer-invariant.test.ts).
// Read-only callers (forensics, dashboard, doctor) depend on this seam, not on
// the single-writer surface.
import { getDbOrNull } from "./engine.js";
import { isClosedStatus } from "../status-guards.js";
import { getGateIdsForTurn, type OwnerTurn } from "../gate-registry.js";
import type { Decision, Requirement, GateRow, GateScope } from "../types.js";
import {
  emptyTaskStatusCounts,
  rowToActiveTaskSummary,
  rowToIdStatusSummary,
  rowToTaskStatusCounts,
  rowsToStringColumn,
  type ActiveTaskSummary,
  type IdStatusSummary,
  type TaskStatusCounts,
} from "../db-lightweight-query-rows.js";
import {
  rowToActiveDecision,
  rowToActiveRequirement,
  rowToDecision,
  rowToRequirement,
  rowsToRequirementCounts,
} from "../db-decision-requirement-rows.js";
import { rowToGate } from "../db-gate-rows.js";
import { rowToArtifact, rowToMilestone, type ArtifactRow, type MilestoneRow } from "../db-milestone-artifact-rows.js";
import { rowToSlice, rowToTask, type SliceRow, type TaskRow } from "../db-task-slice-rows.js";


function parseStringArrayColumn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === "string");
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
    if (typeof parsed === "string") return [parsed];
  } catch {
    return trimmed.split(",");
  }
  return [];
}

function normalizeRepoPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function getDecisionById(id: string): Decision | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!row) return null;
  return rowToDecision(row);
}

export function getActiveDecisions(): Decision[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM active_decisions").all();
  return rows.map(rowToActiveDecision);
}

export function getRequirementById(id: string): Requirement | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
  if (!row) return null;
  return rowToRequirement(row);
}

export function getActiveRequirements(): Requirement[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM active_requirements").all();
  return rows.map(rowToActiveRequirement);
}

export function getRequirementCounts(): {
  active: number;
  validated: number;
  deferred: number;
  outOfScope: number;
  blocked: number;
  total: number;
} {
  if (!getDbOrNull()!) {
    return { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 };
  }
  const rows = getDbOrNull()!
    .prepare("SELECT lower(status) as status, COUNT(*) as count FROM requirements GROUP BY lower(status)")
    .all();
  return rowsToRequirementCounts(rows);
}

/**
 * ADR-017 raw primitive: returns slice IDs in a milestone whose is_sketch flag
 * is still 1. The stale-sketch-flag drift handler at
 * `state-reconciliation/drift/sketch-flag.ts` composes this with PLAN.md
 * existence checks to detect drift, then writes via `setSliceSketchFlag`.
 */
export function getSketchedSliceIds(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT id FROM slices WHERE milestone_id = :mid AND is_sketch = 1`,
  ).all({ ":mid": milestoneId }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function getSlice(milestoneId: string, sliceId: string): SliceRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid").get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}

export function getTask(milestoneId: string, sliceId: string, taskId: string): TaskRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}

export function getSliceTasks(milestoneId: string, sliceId: string): TaskRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}

export function getCompletedMilestoneTaskFileHints(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT files, key_files
     FROM tasks
     WHERE milestone_id = :mid AND status IN ('complete', 'done')`,
  ).all({ ":mid": milestoneId }) as Array<Record<string, unknown>>;

  const hints = new Set<string>();
  for (const row of rows) {
    for (const raw of [row["files"], row["key_files"]]) {
      for (const file of parseStringArrayColumn(raw)) {
        const normalized = normalizeRepoPath(file);
        if (normalized) hints.add(normalized);
      }
    }
  }
  return [...hints];
}

/** Find the most recent resolved-but-unapplied escalation override in a slice. */
export function findUnappliedEscalationOverride(
  milestoneId: string, sliceId: string,
): { taskId: string; artifactPath: string } | null {
  if (!getDbOrNull()!) return null;
  // Filter BOTH flags: escalation_pending=0 AND escalation_awaiting_review=0
  // ensures we only claim overrides the user has explicitly resolved.
  // Without the awaiting_review filter, continueWithDefault=true artifacts
  // (not yet responded to) would be prematurely claimed, causing the override
  // to be lost when the user later resolves (#ADR-011 Phase 2 peer-review Bug 2).
  const row = getDbOrNull()!.prepare(
    `SELECT id, escalation_artifact_path AS path
       FROM tasks
      WHERE milestone_id = :mid AND slice_id = :sid
        AND escalation_artifact_path IS NOT NULL
        AND escalation_override_applied_at IS NULL
        AND escalation_pending = 0
        AND escalation_awaiting_review = 0
      ORDER BY sequence DESC, id DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId }) as
    | { id: string; path: string | null }
    | undefined;
  if (!row || !row.path) return null;
  return { taskId: row.id, artifactPath: row.path };
}

/** List tasks with active escalation artifacts across a milestone (for /gsd escalate list). */
export function listEscalationArtifacts(milestoneId: string, includeResolved: boolean = false): TaskRow[] {
  if (!getDbOrNull()!) return [];
  const filter = includeResolved
    ? "escalation_artifact_path IS NOT NULL"
    : "(escalation_pending = 1 OR escalation_awaiting_review = 1) AND escalation_artifact_path IS NOT NULL";
  const rows = getDbOrNull()!.prepare(
    `SELECT * FROM tasks WHERE milestone_id = :mid AND ${filter} ORDER BY slice_id, sequence, id`,
  ).all({ ":mid": milestoneId });
  return rows.map(rowToTask);
}

export interface VerificationEvidenceRow {
  id: number;
  task_id: string;
  slice_id: string;
  milestone_id: string;
  command: string;
  exit_code: number;
  verdict: string;
  duration_ms: number;
  created_at: string;
}

export function getVerificationEvidence(milestoneId: string, sliceId: string, taskId: string): VerificationEvidenceRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid ORDER BY id",
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  return rows as unknown as VerificationEvidenceRow[];
}

export function getAllMilestones(): MilestoneRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT * FROM milestones ORDER BY CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, id",
  ).all();
  return rows.map(rowToMilestone);
}

export function getMilestone(id: string): MilestoneRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}

export function getActiveMilestoneFromDb(): MilestoneRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT * FROM milestones WHERE status NOT IN ('complete', 'done', 'skipped', 'closed', 'parked') ORDER BY id LIMIT 1",
  ).get();
  if (!row) return null;
  return rowToMilestone(row);
}

export function getActiveSliceFromDb(milestoneId: string): SliceRow | null {
  if (!getDbOrNull()!) return null;

  // Single query: find the first non-complete slice whose dependencies are all satisfied.
  // Uses json_each() to expand the JSON depends array and checks each dep is complete.
  const row = getDbOrNull()!.prepare(
    `SELECT s.* FROM slices s
     WHERE s.milestone_id = :mid
       AND s.status NOT IN ('complete', 'done', 'skipped')
       AND NOT EXISTS (
         SELECT 1 FROM json_each(s.depends) AS dep
         WHERE dep.value NOT IN (
           SELECT id FROM slices WHERE milestone_id = :mid AND status IN ('complete', 'done', 'skipped')
         )
       )
     ORDER BY s.sequence, s.id
     LIMIT 1`,
  ).get({ ":mid": milestoneId });
  if (!row) return null;
  return rowToSlice(row);
}

export function getActiveTaskFromDb(milestoneId: string, sliceId: string): TaskRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1",
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToTask(row);
}

export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}

/**
 * Load slices for many milestones in a single query. Returns a Map keyed by
 * milestone_id, preserving `ORDER BY sequence, id` within each bucket.
 */
export function getSlicesByMilestoneIds(milestoneIds: readonly string[]): Map<string, SliceRow[]> {
  const db = getDbOrNull();
  if (!db || milestoneIds.length === 0) return new Map();
  const idList = [...milestoneIds];
  const placeholders = idList.map((_, i) => `:mid${i}`).join(",");
  const params: Record<string, unknown> = {};
  idList.forEach((id, i) => {
    params[`:mid${i}`] = id;
  });
  const rows = db
    .prepare(`SELECT * FROM slices WHERE milestone_id IN (${placeholders}) ORDER BY milestone_id, sequence, id`)
    .all(params) as Record<string, unknown>[];
  const byMilestone = new Map<string, SliceRow[]>();
  for (const row of rows) {
    const slice = rowToSlice(row);
    const bucket = byMilestone.get(slice.milestone_id);
    if (bucket) {
      bucket.push(slice);
    } else {
      byMilestone.set(slice.milestone_id, [slice]);
    }
  }
  return byMilestone;
}

/** Dispatch-eligibility shape consumed by decision-path callers (ADR-017). */
export interface MilestoneSliceSummary {
  id: string;
  title: string;
  /** Closed per the canonical status vocabulary (complete/done/skipped/closed). */
  done: boolean;
  depends: string[];
}

/**
 * Consolidated DB read for dispatch/gate/completion decisions (ADR-017).
 * `done` uses the canonical closed-status predicate (`isClosedStatus`) — the
 * same vocabulary the SQL terminal-status fragment derives from. Decision
 * paths must consume this instead of parsing `.gsd/*.md` projections.
 * Rows keep `getMilestoneSlices` ordering (sequence, then id).
 */
export function getMilestoneSliceSummaries(milestoneId: string): MilestoneSliceSummary[] {
  return getMilestoneSlices(milestoneId).map((s) => ({
    id: s.id,
    title: s.title,
    done: isClosedStatus(s.status),
    depends: s.depends ?? [],
  }));
}

/**
 * Ids of slices closed per the canonical status vocabulary (ADR-017), in
 * milestone order. Thin wrapper over `getMilestoneSliceSummaries` for the
 * common "which slices are done?" decision-path read.
 */
export function getClosedSliceIds(milestoneId: string): string[] {
  return getMilestoneSliceSummaries(milestoneId)
    .filter((s) => s.done)
    .map((s) => s.id);
}

export function getArtifact(path: string): ArtifactRow | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}

/** Fast milestone status check — avoids deserializing JSON planning fields. */
export function getActiveMilestoneIdFromDb(): IdStatusSummary | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT id, status FROM milestones WHERE status NOT IN ('complete', 'done', 'skipped', 'closed', 'parked') ORDER BY id LIMIT 1",
  ).get();
  if (!row) return null;
  return rowToIdStatusSummary(row);
}

/** Fast slice status check — avoids deserializing JSON depends/planning fields. */
export function getSliceStatusSummary(milestoneId: string): IdStatusSummary[] {
  if (!getDbOrNull()!) return [];
  return getDbOrNull()!.prepare(
    "SELECT id, status FROM slices WHERE milestone_id = :mid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId }).map(rowToIdStatusSummary);
}

/** Fast task status check — avoids deserializing JSON arrays and large text fields. */
export function getActiveTaskIdFromDb(milestoneId: string, sliceId: string): ActiveTaskSummary | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    "SELECT id, status, title FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1",
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToActiveTaskSummary(row);
}

/** Count tasks by status for a slice — useful for progress reporting without full row load. */
export function getSliceTaskCounts(milestoneId: string, sliceId: string): TaskStatusCounts {
  if (!getDbOrNull()!) return emptyTaskStatusCounts();
  const row = getDbOrNull()!.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status IN ('complete', 'done') THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status NOT IN ('complete', 'done') THEN 1 ELSE 0 END) as pending
     FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return rowToTaskStatusCounts(row);
}

/** Get all slices that depend on a given slice. */
export function getDependentSlices(milestoneId: string, sliceId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    "SELECT slice_id FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rowsToStringColumn(rows, "slice_id");
}

export function getReplanHistory(milestoneId: string, sliceId?: string): Array<Record<string, unknown>> {
  if (!getDbOrNull()!) return [];
  if (sliceId) {
    return getDbOrNull()!.prepare(
      `SELECT * FROM replan_history WHERE milestone_id = :mid AND slice_id = :sid ORDER BY created_at DESC`,
    ).all({ ":mid": milestoneId, ":sid": sliceId });
  }
  return getDbOrNull()!.prepare(
    `SELECT * FROM replan_history WHERE milestone_id = :mid ORDER BY created_at DESC`,
  ).all({ ":mid": milestoneId });
}

export function getAssessment(path: string): Record<string, unknown> | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM assessments WHERE path = :path`,
  ).get({ ":path": path });
  return row ?? null;
}

export function getLatestAssessmentByScope(
  milestoneId: string,
  scope: string,
): Record<string, unknown> | null {
  if (!getDbOrNull()!) return null;
  const row = getDbOrNull()!.prepare(
    `SELECT * FROM assessments
      WHERE milestone_id = :mid AND scope = :scope
      ORDER BY created_at DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":scope": scope });
  return row ?? null;
}

export function getPendingGates(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!getDbOrNull()!) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope AND status = 'pending'`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

export function getGateResults(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!getDbOrNull()!) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

export function getPendingSliceGateCount(milestoneId: string, sliceId: string): number {
  if (!getDbOrNull()!) return 0;
  const row = getDbOrNull()!.prepare(
    `SELECT COUNT(*) as cnt FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'slice' AND status = 'pending'`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return row ? (row["cnt"] as number) : 0;
}

/**
 * Return pending gate rows owned by a specific workflow turn.
 *
 * Unlike `getPendingGates(..., scope)`, this filters by the registry's
 * `ownerTurn` metadata so callers can distinguish Q3/Q4 (owned by
 * gate-evaluate) from Q8 (owned by complete-slice) even though both are
 * scope:"slice". Pass `taskId` to narrow task-scoped results to one task.
 */
export function getPendingGatesForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
  taskId?: string,
): GateRow[] {
  if (!getDbOrNull()!) return [];
  const ids = getGateIdsForTurn(turn);
  if (ids.size === 0) return [];
  const idList = [...ids];
  const placeholders = idList.map((_, i) => `:gid${i}`).join(",");
  const params: Record<string, unknown> = {
    ":mid": milestoneId,
    ":sid": sliceId,
  };
  idList.forEach((id, i) => {
    params[`:gid${i}`] = id;
  });
  let sql =
    `SELECT * FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid
       AND status = 'pending'
       AND gate_id IN (${placeholders})`;
  if (taskId !== undefined) {
    sql += ` AND task_id = :tid`;
    params[":tid"] = taskId;
  }
  return getDbOrNull()!.prepare(sql).all(params).map(rowToGate);
}

/**
 * Count pending gates for a turn. Convenience wrapper used by state
 * derivation to decide whether a phase transition should pause.
 */
export function getPendingGateCountForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
): number {
  return getPendingGatesForTurn(milestoneId, sliceId, turn).length;
}

export function getMilestoneCommitAttributionShas(milestoneId: string): string[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare(
    `SELECT commit_sha
     FROM milestone_commit_attributions
     WHERE milestone_id = :mid
     ORDER BY created_at, commit_sha`,
  ).all({ ":mid": milestoneId }) as Array<Record<string, unknown>>;
  return rows
    .map((row) => typeof row["commit_sha"] === "string" ? row["commit_sha"] : "")
    .filter(Boolean);
}
