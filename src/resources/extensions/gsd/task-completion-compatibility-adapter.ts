// Project/App: gsd-pi
// File Purpose: Stage canonical Task results and publish verified legacy completion projections.

import type { TaskRow } from "./db-task-slice-rows.js";
import { executeDomainOperation } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  completeLegacyTaskForVerifiedAttempt,
  readDomainOperationFence,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  getTask,
  getSlice,
  insertTask,
  insertVerificationEvidence,
  transaction,
} from "./gsd-db.js";
import { renderPlanCheckboxes, renderTaskSummary } from "./markdown-renderer.js";
import { clearPathCache, resolveTaskFile } from "./paths.js";
import { settleTaskAttempt } from "./task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  captureVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
} from "./verification-source-integrity.js";
import { renderSummaryContent } from "./workflow-projections.js";

export interface TaskCompletionIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface StagedVerificationEvidence {
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
}

export interface StageTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskCompletionIdentity;
  completion: {
    oneLiner: string;
    narrative: string;
    verification: string;
    deviations: string;
    knownIssues: string;
    keyFiles: string[];
    keyDecisions: string[];
    blockerDiscovered: boolean;
    verificationEvidence: StagedVerificationEvidence[];
  };
}

export interface PublishVerifiedTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskCompletionIdentity;
  attemptId: string;
}

export interface StagedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  resultId: string;
  summaryPath: string;
  nextStage: "verify" | "route";
}

export interface PublishedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  summaryPath: string;
}

interface AttemptRow {
  attempt_id: string;
  lifecycle_id: string;
  kernel_checkpoint_id: string;
}

export type TaskCompletionAuthority = "canonical" | "legacy";

function requireTask(input: TaskCompletionIdentity): TaskRow {
  const task = getTask(input.milestoneId, input.sliceId, input.taskId);
  if (!task) throw new Error("Task completion target is missing");
  return task;
}

function replayAttemptId(
  idempotencyKey: string,
  task: TaskCompletionIdentity,
): string | undefined {
  const row = getDb().prepare(`
    SELECT result.attempt_id
    FROM workflow_operations operation
    JOIN workflow_attempt_results result
      ON result.operation_id = operation.operation_id
     AND result.project_id = operation.project_id
     AND result.project_revision = operation.resulting_revision
     AND result.authority_epoch = operation.resulting_authority_epoch
    JOIN workflow_execution_attempts attempt
      ON attempt.attempt_id = result.attempt_id
     AND attempt.lifecycle_id = result.lifecycle_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE operation.idempotency_key = :idempotency_key
      AND lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
  `).get({
    ":idempotency_key": idempotencyKey,
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  return row ? String(row["attempt_id"]) : undefined;
}

export function resolveTaskCompletionAuthority(
  task: TaskCompletionIdentity,
  idempotencyKey?: string,
): TaskCompletionAuthority {
  if (idempotencyKey && replayAttemptId(idempotencyKey, task)) return "canonical";
  if (idempotencyKey) {
    const conflictingOperation = getDb().prepare(`
      SELECT 1 AS present FROM workflow_operations
      WHERE idempotency_key = :idempotency_key
    `).get({ ":idempotency_key": idempotencyKey });
    if (conflictingOperation) {
      throw new Error("Task completion idempotency identity belongs to a different canonical operation");
    }
  }

  const lifecycle = getDb().prepare(`
    SELECT lifecycle.lifecycle_id,
           EXISTS (
             SELECT 1 FROM workflow_execution_attempts attempt
             WHERE attempt.lifecycle_id = lifecycle.lifecycle_id
               AND attempt.project_id = lifecycle.project_id
               AND attempt.attempt_state = 'running'
           ) AS has_running_attempt
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;

  if (!lifecycle) {
    if (idempotencyKey) {
      throw new Error("Canonical Task completion lifecycle is missing for private invocation");
    }
    return "legacy";
  }
  if (Number(lifecycle["has_running_attempt"]) === 1) return "canonical";
  throw new Error("Canonical Task completion requires a running or replay-matched Attempt");
}

function runningAttemptId(task: TaskCompletionIdentity): string {
  const attempt = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND attempt.attempt_state = 'running'
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!attempt) throw new Error("Task completion requires a running canonical Attempt");
  return String(attempt["attempt_id"]);
}

function stageLegacyTask(input: StageTaskCompletionInput): void {
  const existing = requireTask(input.task);
  const values = {
    id: input.task.taskId,
    sliceId: input.task.sliceId,
    milestoneId: input.task.milestoneId,
    title: existing.title,
    status: "in_progress",
    oneLiner: input.completion.oneLiner,
    narrative: input.completion.narrative,
    verificationResult: input.completion.verification,
    blockerDiscovered: input.completion.blockerDiscovered,
    deviations: input.completion.deviations,
    knownIssues: input.completion.knownIssues,
    keyFiles: input.completion.keyFiles,
    keyDecisions: input.completion.keyDecisions,
    sequence: existing.sequence,
  };

  transaction(() => {
    insertTask(values);
    const staged = requireTask(input.task);
    const summary = renderSummaryContent(
      staged,
      input.task.sliceId,
      input.task.milestoneId,
      input.completion.verificationEvidence,
    );
    insertTask({ ...values, fullSummaryMd: summary });
    for (const evidence of input.completion.verificationEvidence) {
      insertVerificationEvidence({ ...input.task, ...evidence });
    }
  });
}

async function renderTaskSummaryProjection(
  basePath: string,
  task: TaskCompletionIdentity,
): Promise<string> {
  try {
    const wroteSummary = await renderTaskSummary(
      basePath,
      task.milestoneId,
      task.sliceId,
      task.taskId,
    );
    if (!wroteSummary) throw new Error("summary projection write returned false");
  } catch (error) {
    throw new Error(`Task completion summary projection failed: ${(error as Error).message}`);
  }

  clearPathCache();
  const summaryPath = resolveTaskFile(
    basePath,
    task.milestoneId,
    task.sliceId,
    task.taskId,
    "SUMMARY",
  );
  if (!summaryPath) throw new Error("Task completion projection failed: summary path is missing");
  return summaryPath;
}

async function renderPublishedTaskCompletionProjections(
  basePath: string,
  task: TaskCompletionIdentity,
): Promise<string> {
  const summaryPath = await renderTaskSummaryProjection(basePath, task);
  try {
    const wrotePlan = await renderPlanCheckboxes(basePath, task.milestoneId, task.sliceId);
    if (!wrotePlan) throw new Error("plan projection write returned false");
  } catch (error) {
    throw new Error(`Task completion PLAN projection failed: ${(error as Error).message}`);
  }
  return summaryPath;
}

export async function stageTaskCompletion(
  input: StageTaskCompletionInput,
): Promise<StagedTaskCompletionReceipt> {
  const replayAttempt = replayAttemptId(input.invocation.idempotencyKey, input.task);
  const task = requireTask(input.task);
  const legacyClosed = task.status === "complete" || task.status === "done";
  if (legacyClosed && !replayAttempt) {
    throw new Error("A newly committed Task settlement cannot target an already-complete legacy Task");
  }
  const attemptId = replayAttempt ?? runningAttemptId(input.task);
  const blocked = input.completion.blockerDiscovered;
  if (!legacyClosed) {
    stageLegacyTask(input);
  }
  const settlement = settleTaskAttempt({
    invocation: input.invocation,
    attemptId,
    outcome: blocked ? "failed" : "succeeded",
    failureClass: blocked ? "blocker-discovered" : "none",
    summary: input.completion.oneLiner,
    output: {
      narrative: input.completion.narrative,
      verification: input.completion.verification,
      verificationEvidence: input.completion.verificationEvidence.map((evidence) => ({
        command: evidence.command,
        exitCode: evidence.exitCode,
        verdict: evidence.verdict,
        durationMs: evidence.durationMs,
      })),
      blockerDiscovered: input.completion.blockerDiscovered,
      deviations: input.completion.deviations,
      knownIssues: input.completion.knownIssues,
      keyFiles: input.completion.keyFiles,
      keyDecisions: input.completion.keyDecisions,
    },
  });

  const summaryPath = await renderTaskSummaryProjection(input.basePath, input.task);
  return {
    status: settlement.status,
    attemptId,
    resultId: settlement.resultId,
    summaryPath,
    nextStage: settlement.nextStage,
  };
}

function loadSucceededAttempt(input: PublishVerifiedTaskCompletionInput): AttemptRow {
  const attempt = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.lifecycle_id, checkpoint.kernel_checkpoint_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = attempt.lifecycle_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = attempt.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = attempt.lifecycle_id
     AND criterion.project_id = attempt.project_id
     AND criterion.criterion_key = 'host-technical-verification'
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.lifecycle_id = attempt.lifecycle_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.project_id = attempt.project_id
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND lifecycle.lifecycle_status = 'in_progress'
      AND attempt.attempt_state = 'settled'
      AND result.outcome = 'succeeded'
      AND checkpoint.next_stage = 'verify'
      AND verdict.verdict = 'pass'
      AND evidence.observation = 'passed'
      AND evidence.source_revision = verdict.tested_source_revision
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts successor
        WHERE successor.supersedes_verdict_id = verdict.verdict_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts other
        WHERE other.attempt_id = attempt.attempt_id
          AND other.project_id = attempt.project_id
          AND other.verdict_id != verdict.verdict_id
      )
  `).get({
    ":attempt_id": input.attemptId,
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
    ":task_id": input.task.taskId,
  }) as unknown as AttemptRow | undefined;
  if (!attempt) {
    throw new Error("Verified Task publication requires a succeeded Attempt with passing host Technical Verdict evidence");
  }
  return attempt;
}

function publishCanonicalCompletion(
  input: PublishVerifiedTaskCompletionInput,
): "committed" | "replayed" {
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  const operation = executeDomainOperation({
    operationType: "task.completion.publish",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      task: {
        milestoneId: input.task.milestoneId,
        sliceId: input.task.sliceId,
        taskId: input.task.taskId,
      },
      attemptId: input.attemptId,
    },
  }, (context) => {
    const attempt = loadSucceededAttempt(input);
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      lifecycleStatus: "completed",
    });

    let previousCheckpointId = attempt.kernel_checkpoint_id;
    for (const nextStage of ["route", "closeout", "settled"] as const) {
      const checkpoint = appendKernelCheckpoint(context, {
        lifecycleId: attempt.lifecycle_id,
        attemptId: attempt.attempt_id,
        nextStage,
        previousKernelCheckpointId: previousCheckpointId,
      });
      previousCheckpointId = checkpoint.kernelCheckpointId;
    }

    completeLegacyTaskForVerifiedAttempt(context, input.task);

    const entityId = `${input.task.milestoneId}/${input.task.sliceId}/${input.task.taskId}`;
    return {
      events: [{
        eventType: "task.completion.published",
        entityType: "task",
        entityId,
        payload: { attemptId: input.attemptId },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `execution/${entityId}`.toLowerCase(),
        projectionKind: "task-execution",
        rendererVersion: "1",
      }],
    };
  });
  return operation.status;
}

function requireCurrentVerifiedSource(input: PublishVerifiedTaskCompletionInput): void {
  if (readDomainOperationFence(input.invocation.idempotencyKey).replay) return;

  const verdict = readTaskTechnicalVerdict(input.attemptId);
  if (!verdict || verdict.verdict !== "pass") {
    throw new Error("Verified Task publication requires a passing host Technical Verdict");
  }
  const preferences = loadEffectiveGSDPreferences(input.basePath)?.preferences;
  const task = getTask(input.task.milestoneId, input.task.sliceId, input.task.taskId);
  const slice = getSlice(input.task.milestoneId, input.task.sliceId);
  const resolved = resolveVerificationRepositoryTargets(input.basePath, preferences, task, slice);
  if (resolved.explicitTargetsRequested && resolved.repositories.length === 0) {
    throw new Error("Verified Task publication cannot resolve its verification target repositories");
  }
  const targets = resolved.repositories.length > 0
    ? resolved.repositories.map((repository) => ({ id: repository.id, cwd: repository.root }))
    : [{ id: "root", cwd: input.basePath }];
  const source = captureVerificationSourceSnapshot(targets);
  if (!source.ok) throw new Error(source.error);
  if (source.snapshot.aggregateRevision !== verdict.testedSourceRevision) {
    throw new Error("Verified Task publication source no longer matches its host verification evidence");
  }
}

export async function publishVerifiedTaskCompletion(
  input: PublishVerifiedTaskCompletionInput,
): Promise<PublishedTaskCompletionReceipt> {
  requireCurrentVerifiedSource(input);
  const status = publishCanonicalCompletion(input);
  const summaryPath = await renderPublishedTaskCompletionProjections(input.basePath, input.task);
  return {
    status,
    attemptId: input.attemptId,
    summaryPath,
  };
}
