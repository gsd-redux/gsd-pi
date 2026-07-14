// Project/App: gsd-pi
// File Purpose: v39 current-head enforcement for verification-caused Task recovery.

import type { DbAdapter } from "./db-adapter.js";
import { currentEvidenceBackedFailureVerdictSqlV39 } from "./db/sql-constants.js";

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
          (NEW.boundary_stage = 'verify' AND result.outcome = 'succeeded'
            AND ${currentEvidenceBackedFailureVerdictSqlV39("result", "NEW")})
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'failure observation requires a matching failed or interrupted Result, or a succeeded Result with a current Technical Verdict failure, at its causal Task boundary');
    END;

    DROP TRIGGER IF EXISTS trg_workflow_attempt_route_authority_v39;
    CREATE TRIGGER trg_workflow_attempt_route_authority_v39
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.retry_of_attempt_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM workflow_kernel_checkpoints checkpoint
        WHERE checkpoint.project_id = NEW.project_id
          AND checkpoint.lifecycle_id = NEW.lifecycle_id
          AND checkpoint.attempt_id = NEW.retry_of_attempt_id
          AND checkpoint.next_stage = 'route'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_kernel_checkpoints successor
            WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_recovery_actions action
        JOIN workflow_failure_observations observation
          ON observation.failure_observation_id = action.failure_observation_id
         AND observation.project_id = action.project_id
         AND observation.lifecycle_id = action.lifecycle_id
        JOIN workflow_attempt_results result
          ON result.result_id = observation.result_id
         AND result.project_id = observation.project_id
         AND result.lifecycle_id = observation.lifecycle_id
         AND result.attempt_id = observation.attempt_id
        WHERE action.project_id = NEW.project_id
          AND action.lifecycle_id = NEW.lifecycle_id
          AND observation.attempt_id = NEW.retry_of_attempt_id
          AND observation.recovery_owner = 'agent'
          AND action.project_revision < NEW.claim_project_revision
          AND action.authority_epoch <= NEW.claim_authority_epoch
          AND (
            (
              action.action IN ('retry', 'repair', 'remediate', 'replan')
              AND action.target_lifecycle_id = NEW.lifecycle_id
              AND (
                action.action != 'replan' OR EXISTS (
                  SELECT 1
                  FROM workflow_domain_events replanned
                  JOIN workflow_item_lifecycles target
                    ON target.project_id = action.project_id
                   AND target.lifecycle_id = action.lifecycle_id
                  WHERE replanned.project_id = action.project_id
                    AND replanned.event_type = 'workflow.task.replanned'
                    AND replanned.entity_type = 'task'
                    AND replanned.entity_id = target.milestone_id || '/' || target.slice_id || '/' || target.task_id
                    AND replanned.project_revision > action.project_revision
                    AND replanned.project_revision < NEW.claim_project_revision
                    AND replanned.authority_epoch <= NEW.claim_authority_epoch
                )
              )
            ) OR (
              action.action = 'abort' AND EXISTS (
                SELECT 1
                FROM workflow_domain_events resumed
                JOIN workflow_item_lifecycles target
                  ON target.project_id = action.project_id
                 AND target.lifecycle_id = action.lifecycle_id
                JOIN workflow_work_checkpoints checkpoint
                  ON checkpoint.project_id = resumed.project_id
                 AND checkpoint.operation_id = resumed.operation_id
                 AND checkpoint.checkpoint_id = json_extract(resumed.payload_json, '$.workCheckpointId')
                 AND checkpoint.lifecycle_id = action.lifecycle_id
                WHERE resumed.project_id = action.project_id
                  AND resumed.event_type = 'task.recovery.resumed'
                  AND resumed.entity_type = 'task'
                  AND resumed.entity_id = target.milestone_id || '/' || target.slice_id || '/' || target.task_id
                  AND json_extract(resumed.payload_json, '$.recoveryActionId') = action.recovery_action_id
                  AND json_extract(resumed.payload_json, '$.lifecycleId') = action.lifecycle_id
                  AND json_extract(resumed.payload_json, '$.attemptId') = observation.attempt_id
                  AND json_extract(resumed.payload_json, '$.resultId') = observation.result_id
                  AND resumed.project_revision > action.project_revision
                  AND resumed.project_revision < NEW.claim_project_revision
                  AND resumed.authority_epoch <= NEW.claim_authority_epoch
              )
            )
          )
          AND (
            (observation.boundary_stage = 'execute' AND result.outcome IN ('failed', 'interrupted')) OR
            (observation.boundary_stage = 'verify' AND result.outcome = 'succeeded'
              AND ${currentEvidenceBackedFailureVerdictSqlV39("result")})
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'route-head retry requires current causal recovery authority');
    END;
  `);
}
