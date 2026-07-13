// Project/App: gsd-pi
// File Purpose: Replay-safe semantic Domain Operations for Task recovery history.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  appendRecoveryWorkCheckpoint,
  createOrReadRecoveryBudget,
  grantRecoveryWaiver,
  openRecoveryBlocker,
  recordFailureObservation,
  recordRecoveryAction,
  recordRequirementDisposition,
  resolveRecoveryBlocker,
  terminateRecoveryWaiver,
  type AppendRecoveryWorkCheckpointInput,
  type GrantRecoveryWaiverInput,
  type RecordRequirementDispositionInput,
} from "./db/writers/task-recovery.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  normalizeFailureFingerprint,
  selectRecoveryDecision,
  type HumanBlockerKind,
  type RecoveryDecision,
  type RecoveryPolicyInput,
  type TaskFailureKind,
} from "./recovery-policy.js";

type AgentClassification = Extract<RecoveryPolicyInput, { owner: "agent" }>["classification"];
type ReceiptStatus = DomainOperationResult["status"];

interface TaskScope {
  lifecycleId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface FailedAttemptScope extends TaskScope {
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
}

type RouteFailureInput = {
  invocation: ExecutionInvocation;
  attemptId: string;
  resultId: string;
  summary: string;
  evidence: DomainJsonValue;
  rationale: string;
  targetLifecycleId?: string;
} & (
  | { owner: "agent"; classification: AgentClassification }
  | {
      owner: "user" | "external";
      classification: { failureKind: TaskFailureKind };
      blocker: {
        blockerKind: HumanBlockerKind;
        description: string;
        requestedAction: string;
      };
    }
);

export interface TaskRecoveryReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  failureObservationId: string;
  recoveryActionId: string;
  action: RecoveryDecision["action"];
  recoveryBudgetId?: string;
  blockerId?: string;
  workCheckpointId?: string;
}

export interface BlockerResolutionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  blockerId: string;
  blockerStatus: "resolved" | "dismissed";
  workCheckpointId: string;
}

export interface WaiverReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  waiverId: string;
  waiverStatus: "active" | "revoked" | "expired";
  dispositionId?: string;
}

export interface RequirementDispositionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  dispositionId: string;
  disposition: "unsatisfied" | "satisfied" | "waived";
}

export interface WorkCheckpointReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  workCheckpointId: string;
  sequence: number;
}

function operationRequest(
  operationType: string,
  invocation: ExecutionInvocation,
  payload: DomainJsonValue,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  };
}

function mutation(
  eventType: string,
  entityId: string,
  payload: DomainJsonValue,
): DomainOperationMutation {
  return {
    events: [{
      eventType,
      entityType: "task",
      entityId,
      payload,
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `${eventType}/${entityId}`.toLowerCase(),
      projectionKind: "task-recovery",
      rendererVersion: "1",
    }],
  };
}

function taskEntity(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `${scope.milestoneId}/${scope.sliceId}/${scope.taskId}`;
}

function checkpointScope(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `task:${taskEntity(scope)}`.toLowerCase();
}

function loadFailedAttemptScope(attemptId: string, resultId: string): FailedAttemptScope {
  const scope = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, lifecycle.milestone_id, lifecycle.slice_id,
           lifecycle.task_id, attempt.attempt_id, result.result_id,
           checkpoint.kernel_checkpoint_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND result.result_id = :result_id
      AND attempt.attempt_state = 'settled'
      AND result.outcome IN ('failed', 'interrupted')
      AND checkpoint.next_stage = 'route'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({ ":attempt_id": attemptId, ":result_id": resultId }) as Record<string, unknown> | undefined;
  if (!scope) throw new Error("Task recovery requires the current failed or interrupted Result route head");
  return {
    lifecycleId: String(scope["lifecycle_id"]),
    milestoneId: String(scope["milestone_id"]),
    sliceId: String(scope["slice_id"]),
    taskId: String(scope["task_id"]),
    attemptId: String(scope["attempt_id"]),
    resultId: String(scope["result_id"]),
    kernelCheckpointId: String(scope["kernel_checkpoint_id"]),
  };
}

function requireUnroutedResult(resultId: string): void {
  const routed = getDb().prepare(`
    SELECT observation.failure_observation_id
    FROM workflow_failure_observations observation
    WHERE observation.result_id = :result_id
  `).get({ ":result_id": resultId });
  if (routed) throw new Error("Task Result already has a recovery observation");
}

function recoveryUseCounts(
  lifecycleId: string,
  failureKind: string,
  fingerprint: string,
  policyClass?: string,
): { budgetUses: number; replanUses: number } {
  const budgetUses = policyClass
    ? Number((getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM workflow_recovery_actions action
        JOIN workflow_recovery_budgets budget
          ON budget.recovery_budget_id = action.recovery_budget_id
        WHERE budget.lifecycle_id = :lifecycle_id
          AND budget.failure_kind = :failure_kind
          AND budget.failure_fingerprint = :fingerprint
          AND budget.policy_class = :policy_class
      `).get({
        ":lifecycle_id": lifecycleId,
        ":failure_kind": failureKind,
        ":fingerprint": fingerprint,
        ":policy_class": policyClass,
      }) as Record<string, unknown> | undefined)?.["count"] ?? 0)
    : 0;
  const replanUses = Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    WHERE observation.lifecycle_id = :lifecycle_id
      AND observation.failure_kind = :failure_kind
      AND observation.failure_fingerprint = :fingerprint
      AND action.action = 'replan'
  `).get({
    ":lifecycle_id": lifecycleId,
    ":failure_kind": failureKind,
    ":fingerprint": fingerprint,
  }) as Record<string, unknown> | undefined)?.["count"] ?? 0);
  return { budgetUses, replanUses };
}

function selectAgentDecision(
  input: Extract<RouteFailureInput, { owner: "agent" }>,
  scope: FailedAttemptScope,
  failureKind: string,
  fingerprint: string,
): RecoveryDecision {
  const preview = selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    budgetUses: 0,
    replanUses: 0,
  });
  const counts = recoveryUseCounts(
    scope.lifecycleId,
    failureKind,
    fingerprint,
    preview.owner === "agent" ? preview.budget?.policyClass : undefined,
  );
  return selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    ...counts,
  });
}

function loadTaskRecoveryReceipt(
  operation: DomainOperationResult,
): TaskRecoveryReceipt {
  const stored = getDb().prepare(`
    SELECT observation.lifecycle_id, observation.attempt_id, observation.result_id,
           observation.failure_observation_id, action.recovery_action_id,
           action.action, action.recovery_budget_id, action.blocker_id,
           checkpoint.checkpoint_id
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    LEFT JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = action.operation_id
     AND checkpoint.lifecycle_id = observation.lifecycle_id
    WHERE action.operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Task recovery receipt is missing its Observation or Action");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(stored["lifecycle_id"]),
    attemptId: String(stored["attempt_id"]),
    resultId: String(stored["result_id"]),
    failureObservationId: String(stored["failure_observation_id"]),
    recoveryActionId: String(stored["recovery_action_id"]),
    action: String(stored["action"]) as RecoveryDecision["action"],
    ...(stored["recovery_budget_id"]
      ? { recoveryBudgetId: String(stored["recovery_budget_id"]) }
      : {}),
    ...(stored["blocker_id"] ? { blockerId: String(stored["blocker_id"]) } : {}),
    ...(stored["checkpoint_id"]
      ? { workCheckpointId: String(stored["checkpoint_id"]) }
      : {}),
  };
}

export function recordFailureAndSelectRecovery(
  input: RouteFailureInput,
): TaskRecoveryReceipt {
  const operation = executeDomainOperation(operationRequest(
    "attempt.route",
    input.invocation,
    {
      attemptId: input.attemptId,
      resultId: input.resultId,
      owner: input.owner,
      classification: input.classification,
      summary: input.summary,
      evidence: input.evidence,
      rationale: input.rationale,
      targetLifecycleId: input.targetLifecycleId ?? null,
      ...(input.owner === "agent" ? {} : { blocker: input.blocker }),
    },
  ), (context) => {
    const scope = loadFailedAttemptScope(input.attemptId, input.resultId);
    requireUnroutedResult(input.resultId);
    const failureKind = input.classification.failureKind.trim().toLowerCase();
    const fingerprint = normalizeFailureFingerprint(failureKind, input.summary);
    const decision = input.owner === "agent"
      ? selectAgentDecision(input, scope, failureKind, fingerprint)
      : selectRecoveryDecision({ owner: input.owner, blockerKind: input.blocker.blockerKind });

    let blockerId: string | undefined;
    if (input.owner !== "agent") {
      blockerId = openRecoveryBlocker(context, {
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        kernelCheckpointId: scope.kernelCheckpointId,
        blockerKind: input.blocker.blockerKind,
        resolutionOwner: input.owner,
        description: input.blocker.description,
        requestedAction: input.blocker.requestedAction,
      }).blockerId;
    }
    const observation = recordFailureObservation(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      kernelCheckpointId: scope.kernelCheckpointId,
      ...(blockerId ? { blockerId } : {}),
      recoveryOwner: decision.owner,
      failureKind,
      failureFingerprint: fingerprint,
      summary: input.summary,
      evidence: input.evidence,
    });
    const budget = decision.owner === "agent" && decision.budget
      ? createOrReadRecoveryBudget(context, {
          lifecycleId: scope.lifecycleId,
          failureKind,
          failureFingerprint: fingerprint,
          policyClass: decision.budget.policyClass,
          maxUses: decision.budget.maxUses,
          policyVersion: decision.policyVersion,
        })
      : undefined;
    const targetLifecycleId = decision.owner === "agent" &&
        ["retry", "repair", "replan", "remediate"].includes(decision.action)
      ? input.targetLifecycleId ?? scope.lifecycleId
      : undefined;
    const action = recordRecoveryAction(context, {
      lifecycleId: scope.lifecycleId,
      failureObservationId: observation.failureObservationId,
      action: decision.action,
      ...(budget ? { recoveryBudgetId: budget.recoveryBudgetId } : {}),
      ...(targetLifecycleId ? { targetLifecycleId } : {}),
      ...(blockerId ? { blockerId } : {}),
      rationale: input.rationale,
      policyVersion: decision.policyVersion,
    });
    if (decision.owner !== "agent") {
      const humanInput = input as Extract<RouteFailureInput, { owner: "user" | "external" }>;
      appendRecoveryWorkCheckpoint(context, {
        lifecycleId: scope.lifecycleId,
        scopeKey: checkpointScope(scope),
        checkpointKind: "pause",
        confirmedContext: input.summary,
        unresolvedSummary: humanInput.blocker.description,
        evidenceSummary: input.rationale,
        suggestedNextAction: humanInput.blocker.requestedAction,
      });
    }
    return mutation("task.recovery.routed", taskEntity(scope), {
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      failureObservationId: observation.failureObservationId,
      recoveryActionId: action.recoveryActionId,
      action: decision.action,
    });
  });
  return loadTaskRecoveryReceipt(operation);
}

function loadTaskIdentity(lifecycleId: string): TaskScope {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, milestone_id, slice_id, task_id
    FROM workflow_item_lifecycles
    WHERE lifecycle_id = :lifecycle_id AND item_kind = 'task'
  `).get({ ":lifecycle_id": lifecycleId }) as Record<string, unknown> | undefined;
  if (!lifecycle) throw new Error("Task lifecycle is missing");
  return {
    lifecycleId: String(lifecycle["lifecycle_id"]),
    milestoneId: String(lifecycle["milestone_id"]),
    sliceId: String(lifecycle["slice_id"]),
    taskId: String(lifecycle["task_id"]),
  };
}

export function resolveTaskBlocker(input: {
  invocation: ExecutionInvocation;
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  checkpoint: Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">;
}): BlockerResolutionReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.blocker.resolve",
    input.invocation,
    {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
      checkpoint: input.checkpoint,
    },
  ), (context) => {
    const blocker = getDb().prepare(`
      SELECT lifecycle_id, resolution_owner FROM workflow_blockers
      WHERE blocker_id = :blocker_id AND blocker_status = 'open'
    `).get({ ":blocker_id": input.blockerId }) as Record<string, unknown> | undefined;
    if (!blocker) throw new Error("Recovery Blocker must be the current open Blocker");
    if (input.invocation.actorType !== blocker["resolution_owner"]) {
      throw new Error("Recovery Blocker may only be closed by its resolution owner");
    }
    const scope = loadTaskIdentity(String(blocker["lifecycle_id"]));
    resolveRecoveryBlocker(context, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
    });
    appendRecoveryWorkCheckpoint(context, {
      ...input.checkpoint,
      lifecycleId: scope.lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.blocker.resolved", taskEntity(scope), {
      blockerId: input.blockerId,
      disposition: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT blocker.blocker_id, blocker.blocker_status, checkpoint.checkpoint_id
    FROM workflow_blockers blocker
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = blocker.resolved_operation_id
     AND checkpoint.lifecycle_id = blocker.lifecycle_id
    WHERE blocker.resolved_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Blocker resolution receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    blockerId: String(stored["blocker_id"]),
    blockerStatus: String(stored["blocker_status"]) as "resolved" | "dismissed",
    workCheckpointId: String(stored["checkpoint_id"]),
  };
}

export function grantTaskWaiver(
  input: { invocation: ExecutionInvocation } & GrantRecoveryWaiverInput,
): WaiverReceipt {
  const { invocation, ...waiver } = input;
  if (waiver.grantedByActorType === "user" &&
      (invocation.actorType !== "user" || invocation.actorId !== waiver.grantedByActorId)) {
    throw new Error("A user-granted Waiver requires the matching user invocation identity");
  }
  if (waiver.grantedByActorType === "policy" &&
      invocation.actorType !== "agent" && invocation.actorType !== "policy") {
    throw new Error("A policy-granted Waiver requires an agent or policy invocation");
  }
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.grant",
    invocation,
    waiver as unknown as DomainJsonValue,
  ), (context) => {
    const stored = grantRecoveryWaiver(context, waiver);
    const scope = loadTaskIdentity(waiver.lifecycleId);
    return mutation("task.waiver.granted", taskEntity(scope), { waiverId: stored.waiverId });
  });
  const stored = getDb().prepare(`
    SELECT waiver_id, waiver_status FROM workflow_waivers
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver grant receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: "active",
  };
}

export function recordTaskRequirementDisposition(
  input: { invocation: ExecutionInvocation } & RecordRequirementDispositionInput,
): RequirementDispositionReceipt {
  const { invocation, ...disposition } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.disposition.record",
    invocation,
    disposition as unknown as DomainJsonValue,
  ), (context) => {
    const stored = recordRequirementDisposition(context, disposition);
    return mutation("task.requirement.disposition.recorded", disposition.requirementId, {
      dispositionId: stored.dispositionId,
      disposition: stored.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT disposition_id, disposition
    FROM workflow_requirement_dispositions
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Requirement Disposition receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    dispositionId: String(stored["disposition_id"]),
    disposition: String(stored["disposition"]) as RequirementDispositionReceipt["disposition"],
  };
}

export function terminateTaskWaiver(input: {
  invocation: ExecutionInvocation;
  waiverId: string;
  requirementId: string;
  disposition: "revoked" | "expired";
  successorDisposition: "unsatisfied" | "satisfied";
  supersedesDispositionId: string;
  rationale: string;
}): WaiverReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.terminate",
    input.invocation,
    {
      waiverId: input.waiverId,
      requirementId: input.requirementId,
      disposition: input.disposition,
      successorDisposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    },
  ), (context) => {
    const currentWaivedHead = getDb().prepare(`
      SELECT disposition.disposition_id
      FROM workflow_waivers waiver
      JOIN workflow_requirement_dispositions disposition
        ON disposition.waiver_id = waiver.waiver_id
       AND disposition.requirement_id = waiver.requirement_id
      WHERE waiver.waiver_id = :waiver_id
        AND waiver.requirement_id = :requirement_id
        AND waiver.waiver_status = 'active'
        AND disposition.disposition_id = :disposition_id
        AND disposition.disposition = 'waived'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_requirement_dispositions successor
          WHERE successor.supersedes_disposition_id = disposition.disposition_id
        )
    `).get({
      ":waiver_id": input.waiverId,
      ":requirement_id": input.requirementId,
      ":disposition_id": input.supersedesDispositionId,
    });
    if (!currentWaivedHead) {
      throw new Error("Waiver termination requires its matching current waived disposition head");
    }
    const successor = recordRequirementDisposition(context, {
      requirementId: input.requirementId,
      disposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    });
    terminateRecoveryWaiver(context, {
      waiverId: input.waiverId,
      disposition: input.disposition,
    });
    return mutation("task.waiver.terminated", input.requirementId, {
      waiverId: input.waiverId,
      dispositionId: successor.dispositionId,
      status: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT waiver.waiver_id, waiver.waiver_status, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_requirement_dispositions disposition
      ON disposition.operation_id = waiver.ended_operation_id
     AND disposition.requirement_id = waiver.requirement_id
    WHERE waiver.ended_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver termination receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: String(stored["waiver_status"]) as "revoked" | "expired",
    dispositionId: String(stored["disposition_id"]),
  };
}

export function appendTaskWorkCheckpoint(input: {
  invocation: ExecutionInvocation;
  lifecycleId: string;
} & Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">): WorkCheckpointReceipt {
  const { invocation, lifecycleId, ...checkpoint } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.checkpoint.append",
    invocation,
    { lifecycleId, ...checkpoint } as unknown as DomainJsonValue,
  ), (context) => {
    const scope = loadTaskIdentity(lifecycleId);
    const stored = appendRecoveryWorkCheckpoint(context, {
      ...checkpoint,
      lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.checkpoint.appended", taskEntity(scope), {
      checkpointId: stored.checkpointId,
      sequence: stored.sequence,
    });
  });
  const stored = getDb().prepare(`
    SELECT checkpoint_id, sequence FROM workflow_work_checkpoints
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Work Checkpoint receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    workCheckpointId: String(stored["checkpoint_id"]),
    sequence: Number(stored["sequence"]),
  };
}
