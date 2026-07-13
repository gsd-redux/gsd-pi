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
  insertTask,
  insertVerificationEvidence,
  transaction,
} from "./gsd-db.js";
import { renderPlanCheckboxes, renderTaskSummary } from "./markdown-renderer.js";
import { clearPathCache, resolveTaskFile } from "./paths.js";
import { settleTaskAttempt } from "./task-execution-domain-operation.js";
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
}

export interface PublishedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  summaryPath: string;
}

interface AttemptRow {
  attempt_id: string;
  lifecycle_id: string;
}

function requireTask(input: TaskCompletionIdentity): TaskRow {
  const task = getTask(input.milestoneId, input.sliceId, input.taskId);
  if (!task) throw new Error("Task completion target is missing");
  return task;
}

function replayAttemptId(idempotencyKey: string): string | undefined {
  const row = getDb().prepare(`
    SELECT result.attempt_id
    FROM workflow_operations operation
    JOIN workflow_attempt_results result
      ON result.operation_id = operation.operation_id
     AND result.project_id = operation.project_id
     AND result.project_revision = operation.resulting_revision
     AND result.authority_epoch = operation.resulting_authority_epoch
    WHERE operation.idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  return row ? String(row["attempt_id"]) : undefined;
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

function resolveStageAttempt(input: StageTaskCompletionInput): string {
  return replayAttemptId(input.invocation.idempotencyKey) ?? runningAttemptId(input.task);
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

async function renderTaskCompletionProjections(
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
    const wrotePlan = await renderPlanCheckboxes(basePath, task.milestoneId, task.sliceId);
    if (!wrotePlan) throw new Error("plan projection write returned false");
  } catch (error) {
    throw new Error(`Task completion projection failed: ${(error as Error).message}`);
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

export async function stageTaskCompletion(
  input: StageTaskCompletionInput,
): Promise<StagedTaskCompletionReceipt> {
  const attemptId = resolveStageAttempt(input);
  const settlement = settleTaskAttempt({
    invocation: input.invocation,
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
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

  const task = requireTask(input.task);
  if (task.status !== "complete" && task.status !== "done") {
    stageLegacyTask(input);
  }
  const summaryPath = await renderTaskCompletionProjections(input.basePath, input.task);
  return {
    status: settlement.status,
    attemptId,
    resultId: settlement.resultId,
    summaryPath,
  };
}

function loadSucceededAttempt(input: PublishVerifiedTaskCompletionInput): AttemptRow {
  const attempt = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.lifecycle_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = attempt.lifecycle_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND result.outcome = 'succeeded'
  `).get({
    ":attempt_id": input.attemptId,
    ":milestone_id": input.task.milestoneId,
    ":slice_id": input.task.sliceId,
    ":task_id": input.task.taskId,
  }) as unknown as AttemptRow | undefined;
  if (!attempt) throw new Error("Verified Task publication requires a succeeded canonical Attempt Result");
  return attempt;
}

function kernelHead(attemptId: string): Record<string, unknown> {
  const head = getDb().prepare(`
    SELECT kernel_checkpoint_id
    FROM workflow_kernel_checkpoints
    WHERE attempt_id = :attempt_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
      )
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!head) throw new Error("Verified Task publication requires a current Kernel checkpoint");
  return head;
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

    let previousCheckpointId = String(kernelHead(attempt.attempt_id)["kernel_checkpoint_id"]);
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

export async function publishVerifiedTaskCompletion(
  input: PublishVerifiedTaskCompletionInput,
): Promise<PublishedTaskCompletionReceipt> {
  const status = publishCanonicalCompletion(input);
  const summaryPath = await renderTaskCompletionProjections(input.basePath, input.task);
  return {
    status,
    attemptId: input.attemptId,
    summaryPath,
  };
}
