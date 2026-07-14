// Project/App: gsd-pi
// File Purpose: Status Transition Core (ADR-030) — the single row-level
// chokepoint every generic status write funnels through. Owns the milestone
// closed→open guard and is the one place future row-level status policy lands.
// The update*Status faces in gsd-db.ts delegate here.
//
// Two ADR-030 responsibilities remain deferred for safety:
//   - Write-normalization via toStatus(): workflow-reconcile replays journal
//     events that write raw "done"/"in-progress" and tests assert those exact
//     stored values, so converging on write is a separate, behavior-sensitive
//     change (migrate replay/import to canonical first).
//   - Generalizing the closed→open guard to slices: legitimate reopen callers
//     still move slices to open statuses through the generic face. Generalizing
//     safely needs a sanctioned reopenSliceStatus face first, mirroring the
//     existing milestone updateMilestoneStatus/reopenMilestoneStatus split.
import { getDbOrNull, immediateTransaction } from "../engine.js";
import { compareLifecycleShadow } from "../lifecycle-shadow-comparison.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { isClosedStatus } from "../../status-guards.js";

/**
 * A single row-level status write, discriminated by entity (the faces' arity).
 *
 * preserveCompletion (#1291): when true, an existing non-null completed_at on the
 * row is kept rather than overwritten. Mirrors the task upsert's guard so a
 * markdown re-import cannot re-stamp an already-complete slice/milestone with the
 * current import time — the DB row is strictly richer than the plan.
 */
export type StatusTransition =
  | { entity: "task"; milestoneId: string; sliceId: string; taskId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean }
  | { entity: "slice"; milestoneId: string; sliceId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean }
  | { entity: "milestone"; milestoneId: string; status: string; completedAt?: string | null; preserveCompletion?: boolean };

function requireDb() {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return db;
}

/**
 * Apply a row-level status transition. The single chokepoint for generic status
 * writes — the update*Status faces delegate here so the guard and (future)
 * normalization/journal/cache policy live in one place rather than per face.
 *
 * Closed→open guard: generic updates may close or advance Tasks and milestones,
 * but may not reopen closed rows; callers must use the corresponding semantic
 * reopen operation. Slices are not yet guarded — see the file header.
 */
function applyStatusTransitionLocked(t: StatusTransition): void {
  const db = requireDb();
  const completedAt = t.completedAt ?? null;
  const preserve = t.preserveCompletion ? 1 : 0;

  switch (t.entity) {
    case "task": {
      const row = db.prepare(
        "SELECT status FROM tasks WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id",
      ).get({ ":milestone_id": t.milestoneId, ":slice_id": t.sliceId, ":id": t.taskId });
      const currentStatus = typeof row?.["status"] === "string" ? (row["status"] as string) : null;
      if (currentStatus && isClosedStatus(currentStatus) && !isClosedStatus(t.status)) {
        throw new Error(
          `Cannot update closed task ${t.taskId} from ${currentStatus} to ${t.status}; use gsd_task_reopen for an explicit reopen.`,
        );
      }
      db.prepare(
        `UPDATE tasks SET status = :status,
           completed_at = CASE WHEN :preserve_completion = 1 AND tasks.completed_at IS NOT NULL
                               THEN tasks.completed_at ELSE :completed_at END
         WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
      ).run({
        ":status": t.status,
        ":completed_at": completedAt,
        ":preserve_completion": preserve,
        ":milestone_id": t.milestoneId,
        ":slice_id": t.sliceId,
        ":id": t.taskId,
      });
      return;
    }

    case "slice":
      db.prepare(
        `UPDATE slices SET status = :status,
           completed_at = CASE WHEN :preserve_completion = 1 AND slices.completed_at IS NOT NULL
                               THEN slices.completed_at ELSE :completed_at END
         WHERE milestone_id = :milestone_id AND id = :id`,
      ).run({
        ":status": t.status,
        ":completed_at": completedAt,
        ":preserve_completion": preserve,
        ":milestone_id": t.milestoneId,
        ":id": t.sliceId,
      });
      return;

    case "milestone": {
      const row = db.prepare(`
        SELECT milestone.status, lifecycle.lifecycle_status AS canonical_status
        FROM milestones milestone
        LEFT JOIN workflow_item_lifecycles lifecycle
          ON lifecycle.milestone_id = milestone.id
         AND lifecycle.item_kind = 'milestone'
         AND lifecycle.slice_id IS NULL
         AND lifecycle.task_id IS NULL
         AND lifecycle.project_id = (
           SELECT project_id FROM project_authority WHERE singleton = 1
         )
        WHERE milestone.id = :id
      `).get({ ":id": t.milestoneId });
      const currentStatus = typeof row?.["status"] === "string" ? (row["status"] as string) : null;
      const canonicalStatus = typeof row?.["canonical_status"] === "string"
        ? row["canonical_status"]
        : null;
      if (currentStatus && canonicalStatus) {
        const currentShadow = compareLifecycleShadow(currentStatus, canonicalStatus);
        if (currentShadow.kind !== "match" && currentShadow.kind !== "semantic_match_exact_delta") {
          throw new Error(
            `Cannot update adopted Milestone ${t.milestoneId} while canonical and legacy status mismatch ` +
            `(canonical=${canonicalStatus}, legacy=${currentStatus}).`,
          );
        }
      }
      const closesMilestone = isClosedStatus(t.status);
      if (currentStatus && isClosedStatus(currentStatus) && !closesMilestone) {
        throw new Error(
          `Cannot update closed milestone ${t.milestoneId} from ${currentStatus} to ${t.status}; use gsd_milestone_reopen for an explicit reopen.`,
        );
      }
      if (canonicalStatus) {
        const shadow = compareLifecycleShadow(t.status, canonicalStatus);
        if (shadow.kind !== "match" && shadow.kind !== "semantic_match_exact_delta") {
          throw new Error(
            `Cannot change adopted Milestone ${t.milestoneId} legacy status to ${t.status}; ` +
            `canonical lifecycle is ${canonicalStatus}. Use the canonical lifecycle operation.`,
          );
        }
      }
      db.prepare(
        `UPDATE milestones SET status = :status,
           completed_at = CASE WHEN :preserve_completion = 1 AND milestones.completed_at IS NOT NULL
                               THEN milestones.completed_at ELSE :completed_at END
         WHERE id = :id`,
      ).run({ ":status": t.status, ":completed_at": completedAt, ":preserve_completion": preserve, ":id": t.milestoneId });
      return;
    }
  }
}

export function applyStatusTransition(t: StatusTransition): void {
  if (t.entity === "milestone") {
    immediateTransaction(() => applyStatusTransitionLocked(t));
    return;
  }
  applyStatusTransitionLocked(t);
}
