// Project/App: gsd-pi
// File Purpose: v44 authorization for hierarchy terminal-to-ready reopen transitions.

import type { DbAdapter } from "./db-adapter.js";

export function createMilestoneReopenSchemaV44(db: DbAdapter): void {
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_reopen_authorization");
  db.exec(`
    CREATE TRIGGER trg_workflow_lifecycle_reopen_authorization
    BEFORE UPDATE ON workflow_item_lifecycles
    WHEN OLD.lifecycle_status IN ('completed', 'cancelled')
      AND NEW.lifecycle_status = 'ready'
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_operations operation
        WHERE operation.operation_id = NEW.last_operation_id
          AND operation.project_id = NEW.project_id
          AND operation.resulting_revision = NEW.last_project_revision
          AND operation.resulting_authority_epoch = NEW.last_authority_epoch
          AND (
            (
              NEW.item_kind = 'milestone'
              AND operation.operation_type = 'milestone.reopen'
            )
            OR (
              NEW.item_kind = 'slice'
              AND operation.operation_type IN ('slice.reopen', 'milestone.reopen')
            )
            OR (
              NEW.item_kind = 'task'
              AND operation.operation_type IN (
                'task.reopen', 'slice.reopen', 'milestone.reopen'
              )
            )
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow lifecycle reopen authorization');
    END
  `);
}
