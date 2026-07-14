// Project/App: gsd-pi
// File Purpose: v39 current-head enforcement for verification-caused Task recovery.

import type { DbAdapter } from "./db-adapter.js";

export function createTaskRecoveryCurrentHeadSchemaV39(db: DbAdapter): void {
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
            SELECT 1
            FROM workflow_technical_verdicts verdict
            JOIN workflow_acceptance_criteria criterion
              ON criterion.criterion_id = verdict.criterion_id
             AND criterion.project_id = verdict.project_id
             AND criterion.lifecycle_id = verdict.lifecycle_id
            JOIN workflow_verification_evidence evidence
              ON evidence.verdict_id = verdict.verdict_id
             AND evidence.project_id = verdict.project_id
             AND evidence.attempt_id = verdict.attempt_id
            WHERE verdict.project_id = NEW.project_id
              AND verdict.lifecycle_id = NEW.lifecycle_id
              AND verdict.attempt_id = NEW.attempt_id
              AND verdict.verdict IN ('fail', 'inconclusive')
              AND verdict.project_revision < NEW.project_revision
              AND verdict.authority_epoch <= NEW.authority_epoch
              AND NOT EXISTS (
                SELECT 1 FROM workflow_acceptance_criteria successor
                WHERE successor.supersedes_criterion_id = criterion.criterion_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM workflow_technical_verdicts successor
                WHERE successor.supersedes_verdict_id = verdict.verdict_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM workflow_technical_verdicts newer
                JOIN workflow_verification_evidence newer_evidence
                  ON newer_evidence.verdict_id = newer.verdict_id
                 AND newer_evidence.project_id = newer.project_id
                 AND newer_evidence.attempt_id = newer.attempt_id
                WHERE newer.project_id = verdict.project_id
                  AND newer.criterion_id = verdict.criterion_id
                  AND newer.lifecycle_id = verdict.lifecycle_id
                  AND newer.attempt_id = verdict.attempt_id
                  AND newer.project_revision > verdict.project_revision
                  AND NOT EXISTS (
                    SELECT 1 FROM workflow_technical_verdicts successor
                    WHERE successor.supersedes_verdict_id = newer.verdict_id
                  )
              )
          ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'failure observation requires a matching failed or interrupted Result, or a succeeded Result with a current Technical Verdict failure, at its causal Task boundary');
    END;
  `);
}
