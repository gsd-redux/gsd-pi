// Project/App: gsd-pi
// File Purpose: v38 authorization for recovery observations caused by host verification verdicts.

import type { DbAdapter } from "./db-adapter.js";

export function createTaskVerificationRecoverySchemaV38(db: DbAdapter): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_failure_result_scope;
    CREATE TRIGGER trg_workflow_failure_result_scope
    BEFORE INSERT ON workflow_failure_observations
    WHEN NEW.result_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM workflow_attempt_results result
      JOIN workflow_execution_attempts attempt ON attempt.attempt_id = result.attempt_id
      WHERE result.result_id = NEW.result_id
        AND result.project_id = NEW.project_id
        AND result.lifecycle_id = NEW.lifecycle_id
        AND result.attempt_id = NEW.attempt_id
        AND result.project_revision < NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND (
          (NEW.boundary_stage = 'execute' AND result.outcome IN ('failed', 'interrupted')) OR
          (NEW.boundary_stage = 'verify' AND result.outcome = 'succeeded' AND EXISTS (
            SELECT 1 FROM workflow_technical_verdicts verdict
            WHERE verdict.project_id = NEW.project_id
              AND verdict.lifecycle_id = NEW.lifecycle_id
              AND verdict.attempt_id = NEW.attempt_id
              AND verdict.verdict IN ('fail', 'inconclusive')
              AND verdict.project_revision < NEW.project_revision
              AND verdict.authority_epoch <= NEW.authority_epoch
          ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'failure observation requires a matching failed or interrupted Result, or a succeeded Result with a failed or inconclusive verification verdict, at its causal Task boundary');
    END;
  `);
}
