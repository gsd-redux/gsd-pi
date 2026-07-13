// Project/App: gsd-pi
// File Purpose: Immutable canonical host-verification verdict and evidence Domain Operation.

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  appendKernelCheckpoint,
  readDomainOperationFence,
} from "./db/writers/lifecycle-commands.js";
import {
  currentHostTechnicalCriterionId,
  ensureHostTechnicalCriterion,
  insertHostTechnicalVerdict,
} from "./db/writers/task-verification.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export { ensureHostTechnicalCriterion };

export interface RecordTaskTechnicalVerdictInput {
  invocation: ExecutionInvocation;
  attemptId: string;
  testedSourceRevision: string;
  verdict: "pass" | "fail" | "inconclusive";
  rationale: string;
  evidence: {
    evidenceClass: "command";
    commandOrTool: string;
    workingDirectory: string;
    startedAt: string;
    endedAt: string;
    exitCode?: number;
    observation: "passed" | "failed" | "inconclusive";
    durableOutputRef: string;
    environment: { [key: string]: DomainJsonValue };
  };
}

export interface TaskTechnicalVerdictReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  verdictId: string;
  evidenceId: string;
  nextStage: "verify" | "route";
}

export interface TaskTechnicalVerdictSnapshot {
  attemptId: string;
  verdictId: string;
  evidenceId: string;
  verdict: RecordTaskTechnicalVerdictInput["verdict"];
  testedSourceRevision: string;
  nextStage: "verify" | "route";
  operationId: string;
  resultingRevision: number;
}

interface AttemptScope {
  project_id: string;
  lifecycle_id: string;
  milestone_id: string;
  slice_id: string;
  task_id: string;
  settle_project_revision: number;
  kernel_checkpoint_id: string;
}

interface StoredVerdict {
  verdict_id: string;
  evidence_id: string;
  verdict: RecordTaskTechnicalVerdictInput["verdict"];
}

function requireAttemptScope(attemptId: string): AttemptScope {
  const attempt = getDb().prepare(`
    SELECT attempt.project_id, attempt.lifecycle_id, lifecycle.milestone_id,
           lifecycle.slice_id, lifecycle.task_id, attempt.settle_project_revision,
           checkpoint.kernel_checkpoint_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND attempt.attempt_state = 'settled'
      AND result.outcome = 'succeeded'
      AND checkpoint.next_stage = 'verify'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({ ":attempt_id": attemptId }) as unknown as AttemptScope | undefined;
  if (!attempt) throw new Error("Host verification requires a settled succeeded Attempt at the verify stage");
  return attempt;
}

function loadStoredVerdict(operationId: string): StoredVerdict {
  const verdict = getDb().prepare(`
    SELECT verdict.verdict_id, evidence.evidence_id, verdict.verdict
    FROM workflow_technical_verdicts verdict
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE verdict.operation_id = :operation_id
  `).get({ ":operation_id": operationId }) as unknown as StoredVerdict | undefined;
  if (!verdict) throw new Error("Host verification receipt is missing its verdict or evidence");
  return verdict;
}

export function readTaskTechnicalVerdict(attemptId: string): TaskTechnicalVerdictSnapshot | null {
  const stored = getDb().prepare(`
    SELECT verdict.verdict_id, evidence.evidence_id, verdict.verdict,
           verdict.tested_source_revision, verdict.operation_id,
           verdict.project_revision
    FROM workflow_technical_verdicts verdict
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = verdict.criterion_id
     AND criterion.project_id = verdict.project_id
     AND criterion.lifecycle_id = verdict.lifecycle_id
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.project_id = verdict.project_id
     AND evidence.attempt_id = verdict.attempt_id
    WHERE verdict.attempt_id = :attempt_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
    ORDER BY verdict.project_revision DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  const verdict = String(stored["verdict"]) as RecordTaskTechnicalVerdictInput["verdict"];
  return {
    attemptId,
    verdictId: String(stored["verdict_id"]),
    evidenceId: String(stored["evidence_id"]),
    verdict,
    testedSourceRevision: String(stored["tested_source_revision"]),
    nextStage: verdict === "pass" ? "verify" : "route",
    operationId: String(stored["operation_id"]),
    resultingRevision: Number(stored["project_revision"]),
  };
}

export function recordTaskTechnicalVerdict(
  input: RecordTaskTechnicalVerdictInput,
): TaskTechnicalVerdictReceipt {
  if (Object.keys(input.evidence.environment).length === 0) {
    throw new Error("Host verification evidence environment must not be empty");
  }
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let recorded: StoredVerdict | undefined;
  const operation = executeDomainOperation({
    operationType: "attempt.verify",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      attemptId: input.attemptId,
      testedSourceRevision: input.testedSourceRevision,
      verdict: input.verdict,
      rationale: input.rationale,
      evidence: input.evidence,
    },
  }, (context) => {
    const scope = requireAttemptScope(input.attemptId);
    if (readTaskTechnicalVerdict(input.attemptId)) {
      throw new Error("Task Attempt already has an authoritative host Technical Verdict");
    }
    const now = new Date().toISOString();
    const criterionId = currentHostTechnicalCriterionId(scope.project_id, scope.lifecycle_id);
    if (!criterionId) throw new Error("Host verification criterion is missing from the Task claim");
    const inserted = insertHostTechnicalVerdict(context, {
      scope: {
        projectId: scope.project_id,
        lifecycleId: scope.lifecycle_id,
        attemptId: input.attemptId,
        settleProjectRevision: scope.settle_project_revision,
      },
      criterionId,
      testedSourceRevision: input.testedSourceRevision,
      verdict: input.verdict,
      rationale: input.rationale,
      evidence: input.evidence,
      createdAt: now,
    });
    const { verdictId, evidenceId } = inserted;
    if (input.verdict !== "pass") {
      appendKernelCheckpoint(context, {
        lifecycleId: scope.lifecycle_id,
        attemptId: input.attemptId,
        nextStage: "route",
        previousKernelCheckpointId: scope.kernel_checkpoint_id,
      });
    }
    recorded = { verdict_id: verdictId, evidence_id: evidenceId, verdict: input.verdict };
    return {
      events: [{
        eventType: `task.verification.${input.verdict}`,
        entityType: "task",
        entityId: `${scope.milestone_id}/${scope.slice_id}/${scope.task_id}`,
        payload: { attemptId: input.attemptId, verdictId, evidenceId, verdict: input.verdict },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `verification/${scope.milestone_id}/${scope.slice_id}/${scope.task_id}`.toLowerCase(),
        projectionKind: "task-verification",
        rendererVersion: "1",
      }],
    };
  });
  const stored = recorded ?? loadStoredVerdict(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    verdictId: stored.verdict_id,
    evidenceId: stored.evidence_id,
    nextStage: stored.verdict === "pass" ? "verify" : "route",
  };
}
