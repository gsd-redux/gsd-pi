// Project/App: gsd-pi
// File Purpose: Additive v36 authorization for fenced Attempt interruption and Kernel stages.

import type { DbAdapter } from "./db-adapter.js";
import { kernelStageTransitionSql } from "./db/kernel-stage-policy.js";
import { createKernelCheckpointChainTrigger } from "./db-projection-import-kernel-closeout-foundation-schema.js";
import { ensureColumn } from "./db-schema-metadata.js";

export function createAttemptSettlementShapeTrigger(
  db: DbAdapter,
  allowTaskCancellation = false,
): void {
  const cancellationAuthorization = allowTaskCancellation
    ? `OR (
        operation.operation_type = 'task.cancel'
        AND OLD.attempt_state = 'running'
        AND NEW.settle_outcome = 'interrupted'
      )`
    : "";
  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_attempt_settlement_shape_v36;
    CREATE TRIGGER trg_workflow_attempt_settlement_shape_v36
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN OLD.attempt_state != 'settled' AND NEW.attempt_state = 'settled' AND (
      NEW.settle_outcome IS NULL OR
      (NEW.recovery_worker_id IS NULL) != (NEW.recovery_milestone_lease_token IS NULL) OR
      (NEW.recovery_worker_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_operations operation
        WHERE operation.operation_id = NEW.settle_operation_id
          AND operation.project_id = NEW.project_id
          AND (
            operation.operation_type = 'attempt.settle'
            ${cancellationAuthorization}
          )
      )) OR
      (NEW.recovery_worker_id IS NOT NULL AND (
        NEW.settle_outcome != 'interrupted' OR
        NEW.recovery_milestone_lease_token <= OLD.milestone_lease_token OR
        NOT EXISTS (
          SELECT 1 FROM workflow_operations operation
          WHERE operation.operation_id = NEW.settle_operation_id
            AND operation.project_id = NEW.project_id
            AND operation.operation_type = 'attempt.interrupt'
        ) OR
        EXISTS (
          SELECT 1
          FROM workflow_item_lifecycles lifecycle
          JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
          WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
            AND lease.worker_id = OLD.worker_id
            AND lease.fencing_token = OLD.milestone_lease_token
            AND lease.status = 'held'
            AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ) OR
        NOT EXISTS (
          SELECT 1
          FROM workflow_item_lifecycles lifecycle
          JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
          WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
            AND lease.worker_id = NEW.recovery_worker_id
            AND lease.fencing_token = NEW.recovery_milestone_lease_token
            AND lease.status = 'held'
            AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow Attempt recovery requires interrupted outcome and complete lease identity');
    END;
  `);
}

export function createAttemptTransitionFencingTrigger(
  db: DbAdapter,
  allowTaskCancellation = false,
): void {
  const cancellationAuthorization = allowTaskCancellation
    ? `OR (
        NEW.attempt_state = 'settled'
        AND NEW.settle_outcome = 'interrupted'
        AND EXISTS (
          SELECT 1 FROM workflow_operations operation
          WHERE operation.operation_id = NEW.settle_operation_id
            AND operation.project_id = NEW.project_id
            AND operation.operation_type = 'task.cancel'
        )
      )`
    : "";
  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_attempt_transition_fencing;
    CREATE TRIGGER trg_workflow_attempt_transition_fencing
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state != OLD.attempt_state
      AND NEW.worker_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
        WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
          AND lease.worker_id = NEW.worker_id
          AND lease.fencing_token = NEW.milestone_lease_token
          AND lease.status = 'held'
          AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      AND NOT (
        (
          NEW.attempt_state = 'settled'
          AND NEW.settle_outcome = 'interrupted'
          AND NEW.recovery_worker_id IS NOT NULL
          AND NEW.recovery_milestone_lease_token > OLD.milestone_lease_token
          AND EXISTS (
            SELECT 1 FROM workflow_operations operation
            WHERE operation.operation_id = NEW.settle_operation_id
              AND operation.project_id = NEW.project_id
              AND operation.operation_type = 'attempt.interrupt'
          )
          AND EXISTS (
            SELECT 1
            FROM workflow_item_lifecycles lifecycle
            JOIN milestone_leases lease ON lease.milestone_id = lifecycle.milestone_id
            WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
              AND lease.worker_id = NEW.recovery_worker_id
              AND lease.fencing_token = NEW.recovery_milestone_lease_token
              AND lease.status = 'held'
              AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          )
        )
        ${cancellationAuthorization}
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow attempt requires the current held lease or current replacement lease');
    END;
  `);
}

export function createAttemptRecoverySchemaV36(db: DbAdapter): void {
  ensureColumn(db, "workflow_execution_attempts", "settle_outcome", `
    ALTER TABLE workflow_execution_attempts
    ADD COLUMN settle_outcome TEXT DEFAULT NULL
      CHECK (settle_outcome IN ('succeeded', 'failed', 'interrupted'))
  `);
  ensureColumn(db, "workflow_execution_attempts", "recovery_worker_id", `
    ALTER TABLE workflow_execution_attempts
    ADD COLUMN recovery_worker_id TEXT DEFAULT NULL REFERENCES workers(worker_id)
  `);
  ensureColumn(db, "workflow_execution_attempts", "recovery_milestone_lease_token", `
    ALTER TABLE workflow_execution_attempts
    ADD COLUMN recovery_milestone_lease_token INTEGER DEFAULT NULL
      CHECK (recovery_milestone_lease_token > 0)
  `);

  const allowedKernelTransition = kernelStageTransitionSql();

  db.exec(`
    DROP TRIGGER IF EXISTS trg_workflow_attempt_terminal_immutable;
    DROP TRIGGER IF EXISTS trg_workflow_attempt_transition;
    UPDATE workflow_execution_attempts
    SET settle_outcome = (
      SELECT result.outcome
      FROM workflow_attempt_results result
      WHERE result.attempt_id = workflow_execution_attempts.attempt_id
        AND result.lifecycle_id = workflow_execution_attempts.lifecycle_id
        AND result.project_id = workflow_execution_attempts.project_id
    )
    WHERE attempt_state = 'settled' AND settle_outcome IS NULL;
  `);

  const incompleteHistory = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_execution_attempts
    WHERE attempt_state = 'settled' AND settle_outcome IS NULL
  `).get() as Record<string, unknown> | undefined;
  if (Number(incompleteHistory?.["count"] ?? 0) > 0) {
    throw new Error("v36 migration cannot derive outcomes for all settled workflow Attempts");
  }

  db.exec("DROP TRIGGER IF EXISTS trg_workflow_kernel_checkpoint_chain");
  createKernelCheckpointChainTrigger(db);

  db.exec(`
    CREATE TRIGGER trg_workflow_attempt_terminal_immutable
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN OLD.attempt_state = 'settled'
    BEGIN
      SELECT RAISE(ABORT, 'settled workflow attempts are immutable');
    END;

    CREATE TRIGGER trg_workflow_attempt_transition
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NOT (
      (OLD.attempt_state = 'claimed' AND NEW.attempt_state IN ('running', 'settled')) OR
      (OLD.attempt_state = 'running' AND NEW.attempt_state = 'settled')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid workflow attempt transition');
    END;

    DROP TRIGGER IF EXISTS trg_workflow_attempt_transition_dispatch_scope;

    CREATE TRIGGER trg_workflow_attempt_transition_dispatch_scope
    BEFORE UPDATE ON workflow_execution_attempts
    WHEN NEW.attempt_state != OLD.attempt_state
      AND NEW.coordination_dispatch_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workflow_item_lifecycles lifecycle
        JOIN unit_dispatches dispatch ON dispatch.id = NEW.coordination_dispatch_id
        WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
          AND dispatch.milestone_id = lifecycle.milestone_id
          AND dispatch.slice_id IS lifecycle.slice_id
          AND dispatch.task_id IS lifecycle.task_id
          AND dispatch.worker_id = NEW.worker_id
          AND dispatch.milestone_lease_token = NEW.milestone_lease_token
          AND dispatch.status IN ('claimed', 'running')
      )
      AND NOT (
        NEW.attempt_state = 'settled'
        AND NEW.settle_outcome = 'interrupted'
        AND NEW.recovery_worker_id IS NOT NULL
        AND NEW.recovery_milestone_lease_token > OLD.milestone_lease_token
        AND EXISTS (
          SELECT 1 FROM workflow_operations operation
          WHERE operation.operation_id = NEW.settle_operation_id
            AND operation.project_id = NEW.project_id
            AND operation.operation_type = 'attempt.interrupt'
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'coordination dispatch does not match workflow attempt scope');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_settlement_insert_shape_v36
    BEFORE INSERT ON workflow_execution_attempts
    WHEN NEW.attempt_state = 'settled' AND (
      NEW.settle_outcome IS NULL OR
      NEW.recovery_worker_id IS NOT NULL OR
      NEW.recovery_milestone_lease_token IS NOT NULL OR
      NOT EXISTS (
        SELECT 1 FROM workflow_operations operation
        WHERE operation.operation_id = NEW.settle_operation_id
          AND operation.project_id = NEW.project_id
          AND operation.operation_type = 'attempt.settle'
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow Attempt settlement requires authorized operation and complete lease identity');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_attempt_result_outcome_v36
    BEFORE INSERT ON workflow_attempt_results
    WHEN NEW.outcome IN ('succeeded', 'failed', 'interrupted') AND NOT EXISTS (
      SELECT 1 FROM workflow_execution_attempts attempt
      WHERE attempt.attempt_id = NEW.attempt_id
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.settle_outcome = NEW.outcome
    )
    BEGIN
      SELECT RAISE(ABORT, 'Attempt Result outcome must match its settlement');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_stage_transition_v36
    BEFORE INSERT ON workflow_kernel_checkpoints
    WHEN NEW.previous_kernel_checkpoint_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM workflow_kernel_checkpoints previous
        WHERE previous.kernel_checkpoint_id = NEW.previous_kernel_checkpoint_id
          AND previous.attempt_id = NEW.attempt_id
          AND NOT (${allowedKernelTransition})
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Kernel stage transition');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_kernel_execute_result_v36
    BEFORE INSERT ON workflow_kernel_checkpoints
    WHEN NEW.previous_kernel_checkpoint_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints previous
        WHERE previous.kernel_checkpoint_id = NEW.previous_kernel_checkpoint_id
          AND previous.attempt_id = NEW.attempt_id
          AND previous.next_stage = 'execute'
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_attempt_results result
        WHERE result.attempt_id = NEW.attempt_id
          AND result.lifecycle_id = NEW.lifecycle_id
          AND result.project_id = NEW.project_id
          AND result.operation_id = NEW.operation_id
          AND result.project_revision = NEW.project_revision
          AND result.authority_epoch = NEW.authority_epoch
          AND (
            (NEW.next_stage = 'verify' AND result.outcome = 'succeeded') OR
            (NEW.next_stage = 'route' AND result.outcome IN ('failed', 'interrupted'))
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'execute checkpoint exit requires a matching immutable Attempt Result');
    END;
  `);
  createAttemptTransitionFencingTrigger(db);
  createAttemptSettlementShapeTrigger(db);
}
