// Project/App: gsd-pi
// File Purpose: v41 Slice-only ready-to-completed lifecycle transition.

import type { DbAdapter } from "./db-adapter.js";

export function createSliceCompletionSchemaV41(db: DbAdapter): void {
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
          (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled')) OR
          (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled')) OR
          (OLD.item_kind = 'slice' AND OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status = 'completed') OR
          (OLD.lifecycle_status = 'in_progress' AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')) OR
          (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled')) OR
          (OLD.lifecycle_status IN ('completed', 'cancelled') AND NEW.lifecycle_status = 'ready')
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
    END
  `);
}
