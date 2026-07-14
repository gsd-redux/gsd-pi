// Project/App: gsd-pi
// File Purpose: v43 authorization for canonical Milestone completion.

import type { DbAdapter } from "./db-adapter.js";

export function createMilestoneCompletionSchemaV43(db: DbAdapter): void {
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_milestone_completion_insert");
  db.exec(`
    CREATE TRIGGER trg_workflow_lifecycle_milestone_completion_insert
    BEFORE INSERT ON workflow_item_lifecycles
    WHEN NEW.item_kind = 'milestone'
      AND NEW.lifecycle_status = 'completed'
      AND NEW.state_version > 0
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_operations operation
        WHERE operation.operation_id = NEW.last_operation_id
          AND operation.project_id = NEW.project_id
          AND operation.operation_type = 'milestone.complete'
          AND operation.resulting_revision = NEW.last_project_revision
          AND operation.resulting_authority_epoch = NEW.last_authority_epoch
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `);
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_transition");
  db.exec(`
    CREATE TRIGGER trg_workflow_lifecycle_transition
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN NOT (
        NEW.lifecycle_status != OLD.lifecycle_status
        AND (
          NEW.last_project_revision <= OLD.last_project_revision
          OR NEW.last_authority_epoch < OLD.last_authority_epoch
        )
      )
      AND (
        NEW.lifecycle_status = OLD.lifecycle_status
        OR NEW.state_version != OLD.state_version + 1
        OR NEW.updated_at = OLD.updated_at
        OR NOT (
          (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled'))
          OR (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled'))
          OR (OLD.item_kind = 'slice' AND OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status = 'completed')
          OR (
            OLD.item_kind = 'milestone'
            AND OLD.lifecycle_status IN ('ready', 'in_progress')
            AND NEW.lifecycle_status = 'completed'
            AND EXISTS (
              SELECT 1
              FROM workflow_operations operation
              WHERE operation.operation_id = NEW.last_operation_id
                AND operation.project_id = NEW.project_id
                AND operation.operation_type = 'milestone.complete'
                AND operation.resulting_revision = NEW.last_project_revision
                AND operation.resulting_authority_epoch = NEW.last_authority_epoch
            )
          )
          OR (
            OLD.lifecycle_status = 'in_progress'
            AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')
            AND NOT (OLD.item_kind = 'milestone' AND NEW.lifecycle_status = 'completed')
          )
          OR (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled'))
          OR (OLD.lifecycle_status IN ('completed', 'cancelled') AND NEW.lifecycle_status = 'ready')
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `);
}
