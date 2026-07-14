// Project/App: gsd-pi
// File Purpose: Executable contract for replay-safe Task recovery Domain Operations.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { recordFailureObservation } from "../db/writers/task-recovery.ts";
import {
  currentHostTechnicalCriterionId,
  insertHostTechnicalVerdict,
} from "../db/writers/task-verification.ts";
import {
  appendTaskWorkCheckpoint,
  cancelTask,
  grantTaskWaiver,
  readPendingTaskRecoveryContext,
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
  recordTaskRequirementDisposition,
  reopenTask,
  resumeTaskRecovery,
  resolveTaskBlocker,
  terminateTaskWaiver,
} from "../task-recovery-domain-operation.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { buildExecuteTaskPrompt, buildTaskRecoveryReplanPrompt } from "../auto-prompts.ts";
import { buildCustomEngineIterationData } from "../auto/workflow-custom-engine-iteration.ts";
import { handleReplanTask } from "../tools/replan-task.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import { verifyExpectedArtifact } from "../artifact-verification.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`).count ?? 0);
}

function invocation(key: string, actorType = "agent"): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType,
    actorId: actorType === "user" ? "user-1" : "recovery-agent",
    traceId: `trace:${key}`,
    turnId: `turn:${key}`,
  };
}

function seedFailedAttempt(): {
  basePath: string;
  dbPath: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-recovery-operation-"));
  tempDirs.add(dir);
  const dbPath = join(dir, ".gsd", "gsd.db");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(dbPath), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Recovery', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Recover atomically', 'pending');
    INSERT INTO requirements (id, class, status, description)
    VALUES
      ('R001', 'primary-user-loop', 'active', 'Recovery remains bounded'),
      ('R002', 'quality-attribute', 'active', 'Waiver ownership remains exact');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'dispatch-trace', 'dispatch-turn', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/task/ready",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/settle"),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });
  const current = row(`
    SELECT lifecycle.lifecycle_id, checkpoint.kernel_checkpoint_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
    WHERE lifecycle.task_id = 'T01' AND checkpoint.next_stage = 'route'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `);
  return {
    basePath: dir,
    dbPath,
    lifecycleId: String(current.lifecycle_id),
    attemptId: claim.attemptId,
    resultId: settlement.resultId,
    kernelCheckpointId: String(current.kernel_checkpoint_id),
  };
}

for (const recoveryCase of [
  { failureKind: "tool-unavailable" as const, action: "retry" },
  { failureKind: "worktree-invalid" as const, action: "repair" },
  { failureKind: "verification-failed" as const, action: "remediate" },
]) {
  test(`custom-engine ${recoveryCase.action} derives its execution prompt from durable recovery`, async () => {
    const scope = seedFailedAttempt();
    db().prepare(`
      UPDATE tasks
      SET description = 'Repair the canonical database contract',
          estimate = '45m',
          files = '["src/canonical-recovery.ts"]',
          verify = 'pnpm test canonical-recovery',
          inputs = '["durable failure evidence"]',
          expected_output = '["recovered execution"]'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    const routed = recordFailureAndSelectRecovery({
      invocation: invocation(`recovery/custom-engine/${recoveryCase.action}`),
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      owner: "agent",
      classification: { failureKind: recoveryCase.failureKind },
      summary: `${recoveryCase.action} must use durable failure evidence`,
      evidence: { source: "durable-recovery-test", action: recoveryCase.action },
      rationale: `The ${recoveryCase.action} action governs the next execution.`,
    });
    assert.equal(routed.action, recoveryCase.action);

    closeDatabase();
    assert.equal(openDatabase(scope.dbPath), true);
    const staleEnginePrompt = `Repeat the stale engine plan for ${recoveryCase.action}.`;
    const adapted = await buildCustomEngineIterationData({
      step: {
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: staleEnginePrompt,
      },
      basePath: scope.basePath,
      canonicalProjectRoot: scope.basePath,
      currentMilestoneId: "M001",
      deriveState: async () => ({
        activeMilestone: { id: "M001", title: "Recovery" },
        activeSlice: { id: "S01", title: "Recovery operation" },
        activeTask: { id: "T01", title: "Recover atomically" },
        phase: "executing",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [],
      }),
      logPostDerive: () => {},
    });

    assert.notEqual(adapted.prompt, staleEnginePrompt);
    assert.match(adapted.prompt, new RegExp(`Required action:\\*\\* ${recoveryCase.action}`));
    assert.match(adapted.prompt, new RegExp(`${recoveryCase.action} must use durable failure evidence`));
    assert.match(adapted.prompt, /Repair the canonical database contract/);
    assert.match(adapted.prompt, /src\/canonical-recovery\.ts/);
    assert.match(adapted.prompt, /pnpm test canonical-recovery/);
    assert.match(adapted.prompt, /Non-authoritative Custom Engine Context/);
    assert.match(adapted.prompt, new RegExp(`Repeat the stale engine plan for ${recoveryCase.action}`));
  });
}

test("replan recovery durably carries its evidence into restart-safe dispatch context", async () => {
  const scope = seedFailedAttempt();
  const staleEnginePrompt = "Run the stale custom engine implementation step without the migration boundary.";
  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("recovery/replan/context"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent",
    classification: { failureKind: "plan-invalid" },
    summary: "Task plan omitted the required migration boundary",
    evidence: { failedCheck: "migration contract", source: "host-verification" },
    rationale: "Supersede the invalid plan before another execution attempt.",
  });

  assert.equal(routed.action, "replan");
  assert.ok(routed.workCheckpointId);
  assert.deepEqual(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), {
    action: "replan",
    recoveryActionId: routed.recoveryActionId,
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    failureKind: "plan-invalid",
    summary: "Task plan omitted the required migration boundary",
    evidence: { failedCheck: "migration contract", source: "host-verification" },
    rationale: "Supersede the invalid plan before another execution attempt.",
    replanCompleted: false,
    checkpoint: {
      checkpointId: routed.workCheckpointId,
      confirmedContext: "Task plan omitted the required migration boundary",
      unresolvedSummary: "plan-invalid",
      evidenceSummary: '{"failedCheck":"migration contract","source":"host-verification"}',
      suggestedNextAction: "Replan the Task before implementation, then execute the replacement plan.",
    },
  });
  assert.equal(count("replan_history"), 0, "routing must not fabricate completed replan history");

  const retryDispatchId = insertClaimedDispatch(2);
  assert.throws(() => claimTaskAttempt({
    invocation: invocation("recovery/replan/premature-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: retryDispatchId,
    retryOfAttemptId: scope.attemptId,
  }), /requires a later durable Task replan before retry claim/);

  closeDatabase();
  assert.equal(openDatabase(scope.dbPath), true);
  const recoveryPrompt = await buildTaskRecoveryReplanPrompt(
    "M001", "S01", "Recovery operation", "T01", "Recover atomically", scope.basePath,
  );
  assert.match(recoveryPrompt, /planning-only recovery unit/i);
  assert.match(recoveryPrompt, /Task plan omitted the required migration boundary/);
  assert.match(recoveryPrompt, /migration contract/);
  assert.match(recoveryPrompt, new RegExp(routed.recoveryActionId));
  assert.match(recoveryPrompt, new RegExp(String(routed.workCheckpointId)));
  assert.match(recoveryPrompt, /call `gsd_replan_task`/i);
  assert.match(recoveryPrompt, /do not call `gsd_task_complete`/i);
  const milestoneDir = join(scope.basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# Recovery context\n");
  writeFileSync(join(milestoneDir, "M001-RESEARCH.md"), "# Recovery research\n");
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# Recovery\n\n- [ ] **S01: Recovery operation**\n");
  writeFileSync(join(sliceDir, "S01-CONTEXT.md"), "# Slice context\n");
  writeFileSync(join(sliceDir, "S01-RESEARCH.md"), "# Slice research\n");
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Recover atomically**\n");
  const state = {
    activeMilestone: { id: "M001", title: "Recovery" },
    activeSlice: { id: "S01", title: "Recovery operation" },
    activeTask: { id: "T01", title: "Recover atomically" },
    phase: "executing" as const,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
  const preparation = await resolveDispatch({
    basePath: scope.basePath,
    mid: "M001",
    midTitle: "Recovery",
    state,
    prefs: undefined,
  });
  assert.equal(preparation.action, "dispatch");
  assert.ok(preparation.action === "dispatch");
  assert.equal(preparation.unitType, "replan-task");
  assert.match(preparation.prompt, /planning-only recovery unit/i);
  assert.equal(
    verifyExpectedArtifact("replan-task", "M001/S01/T01", scope.basePath),
    false,
    "the preparation unit cannot complete before a durable Task replan",
  );

  const customPreparation = await buildCustomEngineIterationData({
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: staleEnginePrompt,
    },
    basePath: scope.basePath,
    canonicalProjectRoot: scope.basePath,
    currentMilestoneId: "M001",
    deriveState: async () => state,
    logPostDerive: () => {},
  });
  assert.equal(customPreparation.unitType, "replan-task");
  assert.equal(customPreparation.unitId, "M001/S01/T01");
  assert.equal(customPreparation.customEnginePreparation, "task-replan");
  assert.match(customPreparation.prompt, /planning-only recovery unit/i);
  assert.match(customPreparation.prompt, /call `gsd_replan_task`/i);
  assert.doesNotMatch(customPreparation.prompt, /stale custom engine implementation step/i);

  const taskDir = join(scope.basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "T01-PLAN.md"), "# T01: Recover atomically\n\nOld invalid plan.\n");
  const replanned = await handleReplanTask({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    title: "Recover atomically",
    description: "Honor the migration boundary before execution.",
    estimate: "1h",
    files: ["src/recovery.ts"],
    verify: "pnpm test",
    inputs: ["migration contract"],
    expectedOutput: ["durable recovery"],
    triggerReason: "durable recovery replan",
  }, scope.basePath, invocation("recovery/replan/replace"));
  assert.ok(!("error" in replanned), "the canonical Task replan must persist a replacement plan");
  assert.equal(count("replan_history"), 1);
  assert.equal(
    verifyExpectedArtifact("replan-task", "M001/S01/T01", scope.basePath),
    true,
    "the durable Task replan is the preparation unit's completion artifact",
  );
  assert.equal(row(`
    SELECT description FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).description, "Honor the migration boundary before execution.");
  assert.equal(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  })?.replanCompleted, true);

  closeDatabase();
  assert.equal(openDatabase(scope.dbPath), true);

  const execution = await resolveDispatch({
    basePath: scope.basePath,
    mid: "M001",
    midTitle: "Recovery",
    state,
    prefs: undefined,
  });
  assert.equal(execution.action, "dispatch");
  assert.ok(execution.action === "dispatch");
  assert.equal(execution.unitType, "execute-task");
  assert.match(execution.prompt, /Required action:\*\* replan/);
  assert.match(execution.prompt, /replacement Task plan is durable/i);
  assert.match(execution.prompt, /Honor the migration boundary before execution/);

  const customExecution = await buildCustomEngineIterationData({
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: staleEnginePrompt,
    },
    basePath: scope.basePath,
    canonicalProjectRoot: scope.basePath,
    currentMilestoneId: "M001",
    deriveState: async () => state,
    logPostDerive: () => {},
  });
  assert.equal(customExecution.unitType, "execute-task");
  assert.equal(customExecution.customEnginePreparation, undefined);
  assert.notEqual(customExecution.prompt, staleEnginePrompt);
  assert.match(customExecution.prompt, /Durable Task Recovery/);
  assert.match(customExecution.prompt, /replacement Task plan is durable/i);
  assert.match(customExecution.prompt, /Canonical Task Plan \(Database Authority\)/);
  assert.match(customExecution.prompt, /Honor the migration boundary before execution/);
  assert.match(customExecution.prompt, /migration contract/);
  assert.match(customExecution.prompt, /Non-authoritative Custom Engine Context/);
  assert.match(customExecution.prompt, /stale custom engine implementation step/i);

  const retryClaim = claimTaskAttempt({
    invocation: invocation("recovery/replan/claim-after-plan"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: retryDispatchId,
    retryOfAttemptId: scope.attemptId,
  });
  assert.equal(retryClaim.attemptNumber, 2);

  closeDatabase();
  assert.equal(openDatabase(scope.dbPath), true);
  assert.equal(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), null, "the claimed replacement Attempt supersedes predecessor recovery context");

  const normalCustomExecution = await buildCustomEngineIterationData({
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: staleEnginePrompt,
    },
    basePath: scope.basePath,
    canonicalProjectRoot: scope.basePath,
    currentMilestoneId: "M001",
    deriveState: async () => state,
    logPostDerive: () => {},
  });
  assert.equal(normalCustomExecution.prompt, staleEnginePrompt);
});

function seedRetryFailure(
  priorAttemptId: string,
  attemptNumber: number,
): { attemptId: string; resultId: string } {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', :attempt_n, :started_at
    )
  `).run({
    ":trace_id": `dispatch-trace-${attemptNumber}`,
    ":turn_id": `dispatch-turn-${attemptNumber}`,
    ":attempt_n": attemptNumber,
    ":started_at": new Date(Date.parse("2026-07-13T00:00:00.000Z") + attemptNumber).toISOString(),
  });
  const dispatchId = Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/claim/${attemptNumber}`),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId: priorAttemptId,
  });
  const settlement = settleTaskAttempt({
    invocation: invocation(`fixture/settle/${attemptNumber}`),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface unavailable",
    output: {},
  });
  return { attemptId: claim.attemptId, resultId: settlement.resultId };
}

function seedReadyTask(): { lifecycleId: string; dispatchId: number } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-lifecycle-operation-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Recovery', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Lifecycle recovery', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'lifecycle-trace-1', 'lifecycle-turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  let lifecycleId = "";
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/lifecycle-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    lifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    }).lifecycleId;
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/task/lifecycle-ready",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return { lifecycleId, dispatchId: Number(row("SELECT id FROM unit_dispatches").id) };
}

interface VerificationFailureScope {
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
  verdictId: string;
}

function seedSucceededVerificationFailure(
  technicalVerdict: "fail" | "inconclusive" = "fail",
): VerificationFailureScope {
  const seeded = seedReadyTask();
  const claim = claimTaskAttempt({
    invocation: invocation("current-head/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: seeded.dispatchId,
  });
  const settled = settleTaskAttempt({
    invocation: invocation("current-head/settle"),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor produced its result",
    output: { changedFiles: ["src/task.ts"] },
  });
  const verdict = recordTaskTechnicalVerdict({
    invocation: invocation("current-head/verdict"),
    attemptId: claim.attemptId,
    testedSourceRevision: "git:current-head",
    verdict: technicalVerdict,
    rationale: "Host test failed after successful execution.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "npm test",
      workingDirectory: "/tmp/project",
      startedAt: "2026-07-13T01:00:00.000Z",
      endedAt: "2026-07-13T01:00:01.000Z",
      exitCode: 1,
      observation: technicalVerdict === "fail" ? "failed" : "inconclusive",
      durableOutputRef: "db://host-verification/current-head",
      environment: { runner: "node-test", platform: "test" },
    },
  });
  const checkpoint = row(`
    SELECT kernel_checkpoint_id
    FROM workflow_kernel_checkpoints
    WHERE attempt_id = :attempt_id AND next_stage = 'route'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
      )
  `, { ":attempt_id": claim.attemptId });
  return {
    lifecycleId: seeded.lifecycleId,
    attemptId: claim.attemptId,
    resultId: settled.resultId,
    kernelCheckpointId: String(checkpoint.kernel_checkpoint_id),
    verdictId: verdict.verdictId,
  };
}

function supersedeFailedVerdict(scope: VerificationFailureScope): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "attempt.verify",
    idempotencyKey: "current-head/supersede-verdict",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    sourceTransport: "internal",
    payload: { attemptId: scope.attemptId, supersedesVerdictId: scope.verdictId },
  }, (context) => {
    const criterionId = currentHostTechnicalCriterionId(context.projectId, scope.lifecycleId);
    assert.ok(criterionId);
    const attempt = row(`
      SELECT settle_project_revision FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
    `, { ":attempt_id": scope.attemptId });
    insertHostTechnicalVerdict(context, {
      scope: {
        projectId: context.projectId,
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        settleProjectRevision: Number(attempt.settle_project_revision),
      },
      criterionId,
      testedSourceRevision: "git:current-head",
      verdict: "pass",
      rationale: "Human review confirmed the delivered behavior.",
      evidence: {
        evidenceClass: "command",
        commandOrTool: "human review",
        workingDirectory: "/tmp/project",
        startedAt: "2026-07-13T01:00:02.000Z",
        endedAt: "2026-07-13T01:00:03.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "db://host-verification/current-head/pass",
        environment: { reviewer: "user-1" },
      },
      createdAt: "2026-07-13T01:00:03.000Z",
      supersedesVerdictId: scope.verdictId,
    });
    return {
      events: [{ eventType: "test.verdict.superseded", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/verdict/superseded", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function recordNewerSourcePass(scope: VerificationFailureScope): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "attempt.verify",
    idempotencyKey: "current-head/newer-source-pass",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    sourceTransport: "internal",
    payload: { attemptId: scope.attemptId, testedSourceRevision: "git:newer-source" },
  }, (context) => {
    const criterionId = currentHostTechnicalCriterionId(context.projectId, scope.lifecycleId);
    assert.ok(criterionId);
    const attempt = row(`
      SELECT settle_project_revision FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
    `, { ":attempt_id": scope.attemptId });
    insertHostTechnicalVerdict(context, {
      scope: {
        projectId: context.projectId,
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        settleProjectRevision: Number(attempt.settle_project_revision),
      },
      criterionId,
      testedSourceRevision: "git:newer-source",
      verdict: "pass",
      rationale: "The newer source revision passed verification.",
      evidence: {
        evidenceClass: "command",
        commandOrTool: "npm test",
        workingDirectory: "/tmp/project",
        startedAt: "2026-07-13T01:00:02.000Z",
        endedAt: "2026-07-13T01:00:03.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "db://host-verification/newer-source/pass",
        environment: { runner: "node-test" },
      },
      createdAt: "2026-07-13T01:00:03.000Z",
    });
    return {
      events: [{ eventType: "test.verdict.newer-source", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/verdict/newer-source", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function recordNewerSourcePassWithoutEvidence(scope: VerificationFailureScope): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "attempt.verify",
    idempotencyKey: "current-head/newer-source-pass-without-evidence",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "user",
    sourceTransport: "internal",
    payload: { attemptId: scope.attemptId, testedSourceRevision: "git:newer-source" },
  }, (context) => {
    const criterionId = currentHostTechnicalCriterionId(context.projectId, scope.lifecycleId);
    assert.ok(criterionId);
    db().prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES (
        'verdict-newer-without-evidence', :project_id, :criterion_id, :lifecycle_id, :attempt_id,
        'git:newer-source', 'pass', 'gsd-host-verification', '1', 'Orphan newer verdict',
        :created_at, :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":criterion_id": criterionId,
      ":lifecycle_id": scope.lifecycleId,
      ":attempt_id": scope.attemptId,
      ":created_at": "2026-07-13T01:00:03.000Z",
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    return {
      events: [{ eventType: "test.verdict.orphan", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/verdict/orphan", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function removeVerificationEvidence(verdictId: string): void {
  db().exec("DROP TRIGGER trg_workflow_evidence_immutable_delete");
  db().prepare(`
    DELETE FROM workflow_verification_evidence WHERE verdict_id = :verdict_id
  `).run({ ":verdict_id": verdictId });
}

function supersedeHostCriterion(scope: VerificationFailureScope): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.criterion.supersede",
    idempotencyKey: "current-head/supersede-criterion",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { lifecycleId: scope.lifecycleId },
  }, (context) => {
    const result = db().prepare(`
      INSERT INTO workflow_acceptance_criteria (
        criterion_id, criterion_key, project_id, lifecycle_id,
        criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at, operation_id, project_revision, authority_epoch
      )
      SELECT 'criterion-current-head-successor', criterion_key, project_id, lifecycle_id,
             criterion_kind, evidence_class, required, 'Updated host verification criterion',
             criterion_id, :created_at, :operation_id, :project_revision, :authority_epoch
      FROM workflow_acceptance_criteria criterion
      WHERE criterion.project_id = :project_id
        AND criterion.lifecycle_id = :lifecycle_id
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
    `).run({
      ":created_at": "2026-07-13T01:00:02.000Z",
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":project_id": context.projectId,
      ":lifecycle_id": scope.lifecycleId,
    });
    assert.equal(Number((result as { changes?: number }).changes ?? 0), 1);
    return {
      events: [{ eventType: "test.criterion.superseded", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/criterion/superseded", projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function recoveryInput(
  scope: VerificationFailureScope,
  key: string,
): Parameters<typeof recordFailureAndSelectRecovery>[0] {
  return {
    invocation: invocation(key),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent" as const,
    classification: { failureKind: "verification-failed" as const },
    summary: "host verification failed after successful execution",
    evidence: { verdict: "fail", testedSourceRevision: "git:current-head" },
    rationale: "must use only the current verification head",
  };
}

function completeTaskWithHistory(): { lifecycleId: string; attemptId: string } {
  const seeded = seedReadyTask();
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/completed/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: seeded.dispatchId,
  });
  settleTaskAttempt({
    invocation: invocation("fixture/completed/settle"),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Task completed",
    output: { summary: "durable history" },
  });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.complete",
    idempotencyKey: "fixture/completed/closeout",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-07-13T01:00:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
    return {
      events: [{ eventType: "test.task.complete", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/task/complete", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return { lifecycleId: seeded.lifecycleId, attemptId: claim.attemptId };
}

function insertClaimedDispatch(attemptNumber: number): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', :attempt_n, :started_at
    )
  `).run({
    ":trace_id": `lifecycle-trace-${attemptNumber}`,
    ":turn_id": `lifecycle-turn-${attemptNumber}`,
    ":attempt_n": attemptNumber,
    ":started_at": `2026-07-13T02:00:0${attemptNumber}.000Z`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("durable budget use survives retries and exhausts to agent abort", async () => {
  const firstFailure = seedFailedAttempt();
  const summaries = [
    "Request 481 failed at /private/tmp/run-1: provider reported tool surface unavailable",
    "Request 902 failed at /tmp/run-2: upstream wording says the tool surface is unavailable",
    "Request 1337 failed at /workspace/run-3: another provider message for the same unavailable tool surface",
  ];
  const route = (
    key: string,
    failure: { attemptId: string; resultId: string },
    summary: string,
  ) =>
    recordFailureAndSelectRecovery({
      invocation: invocation(key),
      ...failure,
      owner: "agent",
      classification: { failureKind: "tool-unavailable" },
      summary,
      evidence: { source: "executor", diagnostic: summary },
      rationale: "apply the durable recovery policy",
    });

  const first = route("recovery/budget/1", firstFailure, summaries[0]);
  closeDatabase();
  assert.equal(openDatabase(firstFailure.dbPath), true);
  const secondFailure = seedRetryFailure(firstFailure.attemptId, 2);
  const second = route("recovery/budget/2", secondFailure, summaries[1]);
  const thirdFailure = seedRetryFailure(secondFailure.attemptId, 3);
  const third = route("recovery/budget/3", thirdFailure, summaries[2]);

  assert.equal(first.action, "retry");
  assert.equal(second.action, "retry");
  assert.equal(second.recoveryBudgetId, first.recoveryBudgetId);
  assert.equal(third.action, "abort");
  assert.equal(readTaskRecoveryRoute(thirdFailure.attemptId)?.resumeAuthorized, false);
  assert.equal(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), null, "an unresumed abort must not become executable prompt context");
  assert.equal(third.recoveryBudgetId, undefined);
  assert.equal(count("workflow_recovery_budgets"), 1);
  assert.equal(count("workflow_recovery_actions"), 3);
  assert.deepEqual(
    db().prepare(`
      SELECT summary, evidence_json FROM workflow_failure_observations
      ORDER BY project_revision
    `).all(),
    summaries.map((summary) => ({
      summary,
      evidence_json: JSON.stringify({ diagnostic: summary, source: "executor" }),
    })),
  );

  assert.throws(() => resumeTaskRecovery({
    invocation: invocation("recovery/resume/missing-evidence"),
    recoveryActionId: third.recoveryActionId,
    repairSummary: "Claim the fault was repaired without proof.",
    evidence: {},
  }), /evidence must be a non-empty object/i);
  assert.equal(Number(row(`
    SELECT COUNT(*) AS count
    FROM workflow_domain_events
    WHERE event_type = 'task.recovery.resumed'
  `).count), 0);

  const resumed = resumeTaskRecovery({
    invocation: invocation("recovery/resume/1"),
    recoveryActionId: third.recoveryActionId,
    repairSummary: "The missing tool surface was restored in the executor runtime.",
    evidence: { fix: "open-gsd/gsd-pi#1457", verification: "focused recovery tests passed" },
  });
  const replayed = resumeTaskRecovery({
    invocation: invocation("recovery/resume/1"),
    recoveryActionId: third.recoveryActionId,
    repairSummary: "The missing tool surface was restored in the executor runtime.",
    evidence: { fix: "open-gsd/gsd-pi#1457", verification: "focused recovery tests passed" },
  });

  assert.equal(resumed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, resumed.operationId);
  assert.equal(resumed.recoveryActionId, third.recoveryActionId);

  const resumeOperation = row(`
    SELECT project_id, resulting_revision, resulting_authority_epoch
    FROM workflow_operations WHERE operation_id = :operation_id
  `, { ":operation_id": resumed.operationId });
  db().exec(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T02', 'Unrelated recovery', 'pending');
  `);
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'life-unrelated-resume', :project_id, 'task', 'M001', 'S01', 'T02',
      'ready', '', '', :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":project_id": resumeOperation.project_id,
    ":operation_id": resumed.operationId,
    ":project_revision": resumeOperation.resulting_revision,
    ":authority_epoch": resumeOperation.resulting_authority_epoch,
  });
  db().prepare(`
    INSERT INTO workflow_work_checkpoints (
      checkpoint_id, project_id, scope_key, lifecycle_id,
      checkpoint_kind, sequence, confirmed_context, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      'checkpoint-unrelated-resume', :project_id, 'task:m001/s01/t02',
      'life-unrelated-resume', 'correction', 1, 'Unrelated repair', '',
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":project_id": resumeOperation.project_id,
    ":operation_id": resumed.operationId,
    ":project_revision": resumeOperation.resulting_revision,
    ":authority_epoch": resumeOperation.resulting_authority_epoch,
  });
  const resumeEvent = row(`
    SELECT event_id, payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'task.recovery.resumed'
  `, { ":operation_id": resumed.operationId });
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`
    UPDATE workflow_domain_events
    SET payload_json = json_set(payload_json, '$.workCheckpointId', 'checkpoint-unrelated-resume')
    WHERE event_id = :event_id
  `).run({ ":event_id": resumeEvent.event_id });
  const crossLifecycleFence = readDomainOperationFence();
  assert.throws(() => executeDomainOperation({
    operationType: "attempt.claim",
    idempotencyKey: "recovery/resume/cross-lifecycle-checkpoint",
    expectedRevision: crossLifecycleFence.revision,
    expectedAuthorityEpoch: crossLifecycleFence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { retryOfAttemptId: thirdFailure.attemptId },
  }, (context) => {
    db().prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number,
        retry_of_attempt_id, attempt_state, claimed_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch
      ) VALUES (
        'attempt-cross-lifecycle-resume', :project_id, :lifecycle_id, 4,
        :retry_of_attempt_id, 'claimed', '',
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":project_id": context.projectId,
      ":lifecycle_id": resumed.lifecycleId,
      ":retry_of_attempt_id": thirdFailure.attemptId,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    return {
      events: [{
        eventType: "test.recovery.cross-lifecycle-claim",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/recovery/cross-lifecycle-claim",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  }), /current causal recovery authority/i);
  assert.equal(readTaskRecoveryRoute(thirdFailure.attemptId)?.resumeAuthorized, false);
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = :payload_json WHERE event_id = :event_id
  `).run({ ":payload_json": resumeEvent.payload_json, ":event_id": resumeEvent.event_id });

  assert.equal(readTaskRecoveryRoute(thirdFailure.attemptId)?.resumeAuthorized, true);
  assert.equal(
    route("recovery/budget/3", thirdFailure, summaries[2]).resumeAuthorized,
    true,
  );
  assert.deepEqual(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), {
    action: "resume",
    recoveryActionId: third.recoveryActionId,
    attemptId: thirdFailure.attemptId,
    resultId: thirdFailure.resultId,
    failureKind: "tool-unavailable",
    summary: summaries[2],
    evidence: { diagnostic: summaries[2], source: "executor" },
    rationale: "apply the durable recovery policy",
    replanCompleted: false,
    checkpoint: {
      checkpointId: resumed.workCheckpointId,
      confirmedContext: "The missing tool surface was restored in the executor runtime.",
      unresolvedSummary: "",
      evidenceSummary: '{"fix":"open-gsd/gsd-pi#1457","verification":"focused recovery tests passed"}',
      suggestedNextAction: "Claim one new Task Attempt using the recorded repair evidence.",
    },
  });

  const milestoneDir = join(firstFailure.basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const taskDir = join(sliceDir, "tasks");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# Recovery context\n");
  writeFileSync(join(milestoneDir, "M001-RESEARCH.md"), "# Recovery research\n");
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# Recovery\n\n- [ ] **S01: Recovery operation**\n");
  writeFileSync(join(sliceDir, "S01-CONTEXT.md"), "# Slice context\n");
  writeFileSync(join(sliceDir, "S01-RESEARCH.md"), "# Slice research\n");
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Recover atomically**\n");
  writeFileSync(join(taskDir, "T01-PLAN.md"), "# T01: Recover atomically\n");
  const builtInPrompt = await buildExecuteTaskPrompt(
    "M001", "S01", "Recovery operation", "T01", "Recover atomically", firstFailure.basePath,
  );
  const customPrompt = (await buildCustomEngineIterationData({
    step: {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "Repeat the stale engine plan.",
    },
    basePath: firstFailure.basePath,
    canonicalProjectRoot: firstFailure.basePath,
    currentMilestoneId: "M001",
    deriveState: async () => ({
      activeMilestone: { id: "M001", title: "Recovery" },
      activeSlice: { id: "S01", title: "Recovery operation" },
      activeTask: { id: "T01", title: "Recover atomically" },
      phase: "executing",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
    }),
    logPostDerive: () => {},
  })).prompt;
  for (const prompt of [builtInPrompt, customPrompt]) {
    assert.match(prompt, /Required action:\*\* resume/);
    assert.match(prompt, new RegExp(summaries[2]));
    assert.match(prompt, /The missing tool surface was restored in the executor runtime/);
    assert.match(prompt, /open-gsd\/gsd-pi#1457/);
    assert.match(prompt, /focused recovery tests passed/);
    assert.match(prompt, /apply and verify the explicitly authorized repair evidence/i);
  }
  assert.match(customPrompt, /Non-authoritative Custom Engine Context/);
  assert.deepEqual(row(`
    SELECT event_type, payload_json
    FROM workflow_domain_events
    WHERE operation_id = :operation_id
  `, { ":operation_id": resumed.operationId }), {
    event_type: "task.recovery.resumed",
    payload_json: JSON.stringify({
      attemptId: thirdFailure.attemptId,
      evidence: { fix: "open-gsd/gsd-pi#1457", verification: "focused recovery tests passed" },
      lifecycleId: resumed.lifecycleId,
      recoveryActionId: third.recoveryActionId,
      repairSummary: "The missing tool surface was restored in the executor runtime.",
      resultId: thirdFailure.resultId,
      workCheckpointId: resumed.workCheckpointId,
    }),
  });

  assert.throws(() => resumeTaskRecovery({
    invocation: invocation("recovery/resume/duplicate"),
    recoveryActionId: third.recoveryActionId,
    repairSummary: "Try to record a second authorization.",
    evidence: { source: "duplicate" },
  }), /current agent-owned abort/i);

  const fourthFailure = seedRetryFailure(thirdFailure.attemptId, 4);
  assert.ok(fourthFailure.attemptId);
  assert.equal(
    route("recovery/budget/3", thirdFailure, summaries[2]).resumeAuthorized,
    false,
  );
  assert.equal(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), null, "the successor claim must consume resumed-abort prompt authority");
  assert.throws(() => resumeTaskRecovery({
    invocation: invocation("recovery/resume/stale"),
    recoveryActionId: third.recoveryActionId,
    repairSummary: "Try to reuse stale authorization.",
    evidence: { source: "stale" },
  }), /current agent-owned abort/i);
  assert.throws(() => resumeTaskRecovery({
    invocation: invocation("recovery/resume/non-abort"),
    recoveryActionId: first.recoveryActionId,
    repairSummary: "Try to resume a retry action.",
    evidence: { source: "invalid" },
  }), /current agent-owned abort/i);
});

test("a pre-commit fault leaves no recovery residue and the same request retries cleanly", () => {
  const scope = seedFailedAttempt();
  const input = {
    invocation: invocation("recovery/fault/1"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent" as const,
    classification: { failureKind: "tool-unavailable" as const },
    summary: "tool surface unavailable",
    evidence: { source: "executor" },
    rationale: "retry after the transaction fault",
  };

  _setDomainOperationFaultForTest("after-mutation");
  assert.throws(() => recordFailureAndSelectRecovery(input), /domain operation fault/);
  assert.equal(count("workflow_failure_observations"), 0);
  assert.equal(count("workflow_recovery_budgets"), 0);
  assert.equal(count("workflow_recovery_actions"), 0);

  _setDomainOperationFaultForTest(null);
  assert.equal(recordFailureAndSelectRecovery(input).status, "committed");
  assert.equal(count("workflow_recovery_actions"), 1);
});

test("recordFailureAndSelectRecovery atomically selects and replays one bounded agent action", () => {
  const scope = seedFailedAttempt();
  const input = {
    invocation: invocation("recovery/agent/1"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent" as const,
    classification: { failureKind: "tool-unavailable" as const },
    summary: "tool surface unavailable at 2026-07-13T01:00:00.000Z",
    evidence: { source: "executor" },
    rationale: "retry the transient tool failure",
  };

  const first = recordFailureAndSelectRecovery(input);
  const replay = recordFailureAndSelectRecovery(input);

  assert.equal(first.status, "committed");
  assert.equal(replay.status, "replayed");
  assert.deepEqual({ ...replay, status: "committed" }, first);
  assert.equal(first.action, "retry");
  assert.ok(first.recoveryBudgetId);
  assert.equal(first.blockerId, undefined);
  assert.equal(count("workflow_failure_observations"), 1);
  assert.equal(count("workflow_recovery_budgets"), 1);
  assert.equal(count("workflow_recovery_actions"), 1);
  assert.throws(() => recordFailureAndSelectRecovery({
    ...input,
    invocation: invocation("recovery/agent/duplicate"),
  }), /already has a recovery/);
  assert.equal(count("workflow_failure_observations"), 1);
});

test("failed Technical Verdict routes one durable recovery action for a succeeded Attempt and replays", () => {
  const scope = seedSucceededVerificationFailure();
  const input = recoveryInput(scope, "verification-recovery/route");

  const committed = recordFailureAndSelectRecovery(input);
  const replayed = recordFailureAndSelectRecovery(input);

  assert.equal(committed.status, "committed");
  assert.equal(committed.action, "remediate");
  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assert.equal(count("workflow_technical_verdicts"), 1);
  assert.equal(count("workflow_failure_observations"), 1);
  assert.equal(count("workflow_recovery_actions"), 1);
  assert.deepEqual(row(`
    SELECT result.outcome, checkpoint.next_stage
    FROM workflow_attempt_results result
    JOIN workflow_kernel_checkpoints checkpoint ON checkpoint.attempt_id = result.attempt_id
    WHERE result.result_id = :result_id
    ORDER BY checkpoint.sequence DESC LIMIT 1
  `, { ":result_id": scope.resultId }), { outcome: "succeeded", next_stage: "route" });
});

test("successor claim revalidates a retained route when its verification authority becomes stale", () => {
  const scope = seedSucceededVerificationFailure();
  const routed = recordFailureAndSelectRecovery(recoveryInput(scope, "current-head/claim/route"));
  assert.equal(routed.action, "remediate");
  supersedeFailedVerdict(scope);
  assert.equal(readPendingTaskRecoveryContext({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  }), null);
  const dispatchId = insertClaimedDispatch(2);
  db().exec("DROP TRIGGER IF EXISTS trg_workflow_attempt_route_authority_v39");
  const revision = Number(row("SELECT revision FROM project_authority WHERE singleton = 1").revision);
  const operationCount = count("workflow_operations");
  const eventCount = count("workflow_domain_events");
  const checkpointCount = count("workflow_kernel_checkpoints");

  assert.throws(() => claimTaskAttempt({
    invocation: invocation("current-head/claim/stale-route"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId: scope.attemptId,
  }), /current causal recovery authority/i);

  assert.equal(Number(row("SELECT revision FROM project_authority WHERE singleton = 1").revision), revision);
  assert.equal(count("workflow_operations"), operationCount);
  assert.equal(count("workflow_domain_events"), eventCount);
  assert.equal(count("workflow_kernel_checkpoints"), checkpointCount);
  assert.equal(count("workflow_execution_attempts"), 1);
  assert.equal(row(`SELECT status FROM unit_dispatches WHERE id = ${dispatchId}`).status, "claimed");
  assert.equal(count("workflow_failure_observations"), 1);
  assert.equal(count("workflow_recovery_actions"), 1);
});

test("recovery Domain Operation rejects a superseded failed Technical Verdict", () => {
  const scope = seedSucceededVerificationFailure();
  supersedeFailedVerdict(scope);

  assert.throws(
    () => recordFailureAndSelectRecovery(recoveryInput(scope, "current-head/route/superseded-verdict")),
    /current execute or verification failure route head/,
  );
  assert.equal(count("workflow_failure_observations"), 0);
});

for (const verdict of ["fail", "inconclusive"] as const) {
  test(`recovery Domain Operation rejects an evidence-less ${verdict} Technical Verdict`, () => {
    const scope = seedSucceededVerificationFailure(verdict);
    removeVerificationEvidence(scope.verdictId);

    assert.throws(
      () => recordFailureAndSelectRecovery(recoveryInput(scope, `current-head/route/evidence-less-${verdict}`)),
      /current execute or verification failure route head/,
    );
    assert.equal(count("workflow_failure_observations"), 0);
  });
}

test("recovery Domain Operation ignores an evidence-less newer verdict", () => {
  const scope = seedSucceededVerificationFailure();
  recordNewerSourcePassWithoutEvidence(scope);

  const routed = recordFailureAndSelectRecovery(
    recoveryInput(scope, "current-head/route/evidence-less-newer"),
  );

  assert.equal(routed.action, "remediate");
  assert.equal(count("workflow_failure_observations"), 1);
});

test("recovery Domain Operation rejects a failed verdict on a superseded criterion", () => {
  const scope = seedSucceededVerificationFailure();
  supersedeHostCriterion(scope);

  assert.throws(
    () => recordFailureAndSelectRecovery(recoveryInput(scope, "current-head/route/superseded-criterion")),
    /current execute or verification failure route head/,
  );
  assert.equal(count("workflow_failure_observations"), 0);
});

test("recovery Domain Operation rejects an older failed verdict after a newer source passes", () => {
  const scope = seedSucceededVerificationFailure();
  recordNewerSourcePass(scope);
  // Schema enforcement has its own tests; isolate the Domain Operation lookup.
  db().exec("DROP TRIGGER trg_workflow_failure_result_scope");

  assert.throws(
    () => recordFailureAndSelectRecovery(recoveryInput(scope, "current-head/route/newer-source-pass")),
    /current execute or verification failure route head/,
  );
  assert.equal(count("workflow_failure_observations"), 0);
});

for (const staleHead of [
  { label: "superseded verdict", prepare: supersedeFailedVerdict },
  { label: "superseded criterion", prepare: supersedeHostCriterion },
  { label: "stale verdict for another source revision", prepare: recordNewerSourcePass },
] as const) {
  test(`recovery writer rejects a ${staleHead.label} as route authority`, () => {
    const scope = seedSucceededVerificationFailure();
    staleHead.prepare(scope);
    // Schema current-head enforcement has its own tests; isolate this writer guard.
    db().exec("DROP TRIGGER trg_workflow_failure_result_scope");
    const fence = readDomainOperationFence();

    assert.throws(() => executeDomainOperation({
      operationType: "attempt.route",
      idempotencyKey: `current-head/writer/${staleHead.label.replace(" ", "-")}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { attemptId: scope.attemptId, resultId: scope.resultId },
    }, (context) => {
      recordFailureObservation(context, {
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        resultId: scope.resultId,
        kernelCheckpointId: scope.kernelCheckpointId,
        boundaryStage: "verify",
        recoveryOwner: "agent",
        failureKind: "verification-failed",
        failureFingerprint: "verification-failed:current-head",
        summary: "stale verification must not authorize recovery",
        evidence: {},
      });
      return {
        events: [{ eventType: "test.recovery.stale", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: "test/recovery/stale", projectionKind: "test", rendererVersion: "1" }],
      };
    }), /current route head/);
    assert.equal(count("workflow_failure_observations"), 0);
  });
}

for (const verdict of ["fail", "inconclusive"] as const) {
  test(`recovery writer rejects an evidence-less ${verdict} Technical Verdict`, () => {
    const scope = seedSucceededVerificationFailure(verdict);
    removeVerificationEvidence(scope.verdictId);
    db().exec("DROP TRIGGER trg_workflow_failure_result_scope");
    const fence = readDomainOperationFence();

    assert.throws(() => executeDomainOperation({
      operationType: "attempt.route",
      idempotencyKey: `current-head/writer/evidence-less-${verdict}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { attemptId: scope.attemptId, resultId: scope.resultId },
    }, (context) => {
      recordFailureObservation(context, {
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        resultId: scope.resultId,
        kernelCheckpointId: scope.kernelCheckpointId,
        boundaryStage: "verify",
        recoveryOwner: "agent",
        failureKind: "verification-failed",
        failureFingerprint: "verification-failed:current-head",
        summary: "evidence-less verification must not authorize recovery",
        evidence: {},
      });
      return {
        events: [{ eventType: "test.recovery.evidence-less", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: "test/recovery/evidence-less", projectionKind: "test", rendererVersion: "1" }],
      };
    }), /current route head/);
    assert.equal(count("workflow_failure_observations"), 0);
  });
}

test("recovery writer ignores an evidence-less newer verdict", () => {
  const scope = seedSucceededVerificationFailure();
  recordNewerSourcePassWithoutEvidence(scope);
  db().exec("DROP TRIGGER trg_workflow_failure_result_scope");
  const fence = readDomainOperationFence();

  executeDomainOperation({
    operationType: "attempt.route",
    idempotencyKey: "current-head/writer/evidence-less-newer",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { attemptId: scope.attemptId, resultId: scope.resultId },
  }, (context) => {
    recordFailureObservation(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      kernelCheckpointId: scope.kernelCheckpointId,
      boundaryStage: "verify",
      recoveryOwner: "agent",
      failureKind: "verification-failed",
      failureFingerprint: "verification-failed:current-head",
      summary: "the older evidence-backed failure remains current",
      evidence: {},
    });
    return {
      events: [{ eventType: "test.recovery.evidence-backed", entityType: "task", entityId: "M001/S01/T01", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/recovery/evidence-backed", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  assert.equal(count("workflow_failure_observations"), 1);
});

test("an orphan observation prevents a second recovery bundle for the same Result", () => {
  const scope = seedFailedAttempt();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "attempt.route",
    idempotencyKey: "recovery/orphan/fixture",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { resultId: scope.resultId },
  }, (context) => {
    recordFailureObservation(context, {
      ...scope,
      recoveryOwner: "agent",
      failureKind: "tool-unavailable",
      failureFingerprint: "orphan-observation",
      summary: "the prior router stopped before selecting an action",
      evidence: {},
    });
    return {
      events: [{
        eventType: "test.recovery.orphan",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/recovery/orphan",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });

  assert.throws(() => recordFailureAndSelectRecovery({
    invocation: invocation("recovery/orphan/duplicate"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent",
    classification: { failureKind: "tool-unavailable" },
    summary: "the prior router stopped before selecting an action",
    evidence: {},
    rationale: "must not create a second observation",
  }), /already has a recovery observation/);
  assert.equal(count("workflow_failure_observations"), 1);
  assert.equal(count("workflow_recovery_actions"), 0);
});

test("genuine user recovery opens one Blocker and resolution appends a checkpoint", () => {
  const scope = seedFailedAttempt();
  const routed = recordFailureAndSelectRecovery({
    invocation: invocation("recovery/user/1"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "user",
    blocker: {
      blockerKind: "missing_access",
      description: "deployment access is unavailable",
      requestedAction: "Provide deployment access",
    },
    classification: { failureKind: "provider" },
    summary: "deployment access is required",
    evidence: { provider: "deployment" },
    rationale: "the user owns account access",
  });
  assert.equal(routed.action, "pause");
  assert.ok(routed.blockerId);

  assert.throws(() => resolveTaskBlocker({
    invocation: invocation("recovery/user/wrong-owner"),
    blockerId: routed.blockerId!,
    disposition: "resolved",
    resolution: "an agent cannot claim the user's resolution",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: "",
      unresolvedSummary: "deployment access remains unavailable",
      evidenceSummary: "no user resolution exists",
      suggestedNextAction: "wait for the user",
    },
  }), /resolution owner/);

  const resolved = resolveTaskBlocker({
    invocation: invocation("recovery/user/resolve", "user"),
    blockerId: routed.blockerId!,
    disposition: "resolved",
    resolution: "deployment access was provided",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: "deployment access is available",
      unresolvedSummary: "",
      evidenceSummary: "the user confirmed access",
      suggestedNextAction: "retry the Task",
    },
  });
  const replay = resolveTaskBlocker({
    invocation: invocation("recovery/user/resolve", "user"),
    blockerId: routed.blockerId!,
    disposition: "resolved",
    resolution: "deployment access was provided",
    checkpoint: {
      checkpointKind: "answer",
      confirmedContext: "deployment access is available",
      unresolvedSummary: "",
      evidenceSummary: "the user confirmed access",
      suggestedNextAction: "retry the Task",
    },
  });

  assert.equal(resolved.status, "committed");
  assert.equal(replay.status, "replayed");
  assert.equal(count("workflow_work_checkpoints"), 2);
  assert.equal(row(`SELECT blocker_status FROM workflow_blockers`).blocker_status, "resolved");

  assert.throws(() => recordFailureAndSelectRecovery({
    invocation: invocation("recovery/user/chain"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "user",
    supersedesResolvedBlockerId: routed.blockerId,
    blocker: {
      blockerKind: "missing_access",
      description: "must not replace a closed pause with another pause",
      requestedAction: "Provide access again",
    },
    classification: { failureKind: "provider" },
    summary: "must not chain user-owned recovery on one Result",
    evidence: { provider: "deployment" },
    rationale: "only the agent policy may resume after blocker closure",
  }), /already has a recovery observation/);

  const rerouted = recordFailureAndSelectRecovery({
    invocation: invocation("recovery/user/reroute"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent",
    supersedesResolvedBlockerId: routed.blockerId,
    classification: { failureKind: "tool-unavailable" },
    summary: "deployment access is available now",
    evidence: { blockerId: routed.blockerId, accessCheck: "passed" },
    rationale: "resume through the bounded agent recovery policy",
  });
  assert.equal(rerouted.action, "retry");
});

test("a dismissed external blocker may be superseded only by agent recovery", () => {
  const scope = seedFailedAttempt();
  const paused = recordFailureAndSelectRecovery({
    invocation: invocation("recovery/external/pause"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "external",
    blocker: {
      blockerKind: "external_dependency",
      description: "the external deployment gate is unavailable",
      requestedAction: "Restore the gate or approve the local route",
    },
    classification: { failureKind: "tool-unavailable" },
    summary: "the external deployment gate cannot be reached",
    evidence: { provider: "deployment" },
    rationale: "the dependency owner must select the next route",
  });
  assert.equal(paused.action, "pause");
  const blockerId = paused.blockerId;
  assert.ok(blockerId);

  resolveTaskBlocker({
    invocation: invocation("recovery/external/dismiss", "external"),
    blockerId,
    disposition: "dismissed",
    resolution: "the accepted local route does not require the external gate",
    checkpoint: {
      checkpointKind: "correction",
      confirmedContext: "the local route is authoritative",
      unresolvedSummary: "",
      evidenceSummary: "the dependency owner dismissed the obsolete gate",
      suggestedNextAction: "reroute through agent recovery",
    },
  });

  const rerouted = recordFailureAndSelectRecovery({
    invocation: invocation("recovery/external/reroute"),
    attemptId: scope.attemptId,
    resultId: scope.resultId,
    owner: "agent",
    supersedesResolvedBlockerId: blockerId,
    classification: { failureKind: "tool-unavailable" },
    summary: "the accepted local route is now available",
    evidence: { blockerId, route: "local" },
    rationale: "resume through the bounded agent recovery policy",
  });
  assert.equal(rerouted.action, "retry");
});

test("waiver operations preserve grant, disposition, and termination revision ordering", () => {
  const scope = seedFailedAttempt();
  assert.throws(() => grantTaskWaiver({
    invocation: invocation("waiver/fabricated-user"),
    lifecycleId: scope.lifecycleId,
    requirementId: "R001",
    scope: "M001/S01/T01 verification",
    rationale: "an agent cannot fabricate user authority",
    grantedByActorType: "user",
    grantedByActorId: "invented-user",
  }), /invocation.*user|user.*invocation/i);
  const grant = grantTaskWaiver({
    invocation: invocation("waiver/grant", "user"),
    lifecycleId: scope.lifecycleId,
    requirementId: "R001",
    scope: "M001/S01/T01 verification",
    rationale: "the user approved a temporary exception",
    grantedByActorType: "user",
    grantedByActorId: "user-1",
  });
  const waived = recordTaskRequirementDisposition({
    invocation: invocation("waiver/disposition", "user"),
    requirementId: "R001",
    disposition: "waived",
    waiverId: grant.waiverId,
    rationale: "the active waiver authorizes omission",
  });
  const unrelatedGrant = grantTaskWaiver({
    invocation: invocation("waiver/unrelated", "user"),
    lifecycleId: scope.lifecycleId,
    requirementId: "R002",
    scope: "M001/S01/T01 unrelated requirement",
    rationale: "a separate user-approved exception",
    grantedByActorType: "user",
    grantedByActorId: "user-1",
  });
  assert.throws(() => terminateTaskWaiver({
    invocation: invocation("waiver/cross-head", "user"),
    waiverId: unrelatedGrant.waiverId,
    requirementId: "R001",
    disposition: "revoked",
    successorDisposition: "unsatisfied",
    supersedesDispositionId: waived.dispositionId,
    rationale: "must not terminate a Waiver through another Waiver's head",
  }), /matching current waived disposition|waiver.*head/i);
  const terminated = terminateTaskWaiver({
    invocation: invocation("waiver/terminate", "user"),
    waiverId: grant.waiverId,
    requirementId: "R001",
    disposition: "revoked",
    successorDisposition: "unsatisfied",
    supersedesDispositionId: waived.dispositionId,
    rationale: "the exception ended and the requirement is unsatisfied again",
  });

  assert.ok(grant.resultingRevision < waived.resultingRevision);
  assert.ok(waived.resultingRevision < terminated.resultingRevision);
  assert.equal(row(`SELECT waiver_status FROM workflow_waivers`).waiver_status, "revoked");
  assert.deepEqual(db().prepare(`
    SELECT disposition FROM workflow_requirement_dispositions ORDER BY project_revision
  `).all(), [{ disposition: "waived" }, { disposition: "unsatisfied" }]);
  assert.equal(terminateTaskWaiver({
    invocation: invocation("waiver/terminate", "user"),
    waiverId: grant.waiverId,
    requirementId: "R001",
    disposition: "revoked",
    successorDisposition: "unsatisfied",
    supersedesDispositionId: waived.dispositionId,
    rationale: "the exception ended and the requirement is unsatisfied again",
  }).status, "replayed");
});

test("appendTaskWorkCheckpoint extends one current head with a replay-safe receipt", () => {
  const scope = seedFailedAttempt();
  const input = {
    invocation: invocation("checkpoint/handoff"),
    lifecycleId: scope.lifecycleId,
    checkpointKind: "handoff" as const,
    confirmedContext: "the failure was classified",
    unresolvedSummary: "routing remains pending",
    evidenceSummary: "the failed Attempt is durable",
    suggestedNextAction: "route the failure",
  };
  const first = appendTaskWorkCheckpoint(input);
  const replay = appendTaskWorkCheckpoint(input);
  assert.equal(first.sequence, 1);
  assert.equal(first.status, "committed");
  assert.equal(replay.status, "replayed");
  assert.equal(count("workflow_work_checkpoints"), 1);
});

test("reopenTask moves completed work to ready and pending without erasing history", () => {
  const completed = completeTaskWithHistory();
  const before = {
    attempts: count("workflow_execution_attempts"),
    results: count("workflow_attempt_results"),
    checkpoints: count("workflow_kernel_checkpoints"),
  };
  const input = {
    invocation: invocation("task/reopen/completed"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "fresh verification found a regression",
  };

  const first = reopenTask(input);
  const replay = reopenTask(input);

  assert.equal(first.status, "committed");
  assert.equal(replay.status, "replayed");
  assert.deepEqual({ ...replay, status: "committed" }, first);
  assert.deepEqual(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = :lifecycle_id
  `, { ":lifecycle_id": completed.lifecycleId }), { lifecycle_status: "ready" });
  assert.deepEqual(row(`
    SELECT status, completed_at FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `), { status: "pending", completed_at: null });
  assert.deepEqual({
    attempts: count("workflow_execution_attempts"),
    results: count("workflow_attempt_results"),
    checkpoints: count("workflow_kernel_checkpoints"),
  }, before);

  const dispatchId = insertClaimedDispatch(2);
  assert.equal(count("workflow_execution_attempts"), 1, "reopen itself must not claim work");
  const claimed = claimTaskAttempt({
    invocation: invocation("task/reopen/later-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId: completed.attemptId,
  });
  assert.equal(claimed.attemptNumber, 2);
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "in_progress");
});

test("reopenTask maps cancelled and skipped work to ready and pending", () => {
  const seeded = seedReadyTask();
  cancelTask({
    invocation: invocation("task/cancel/ready-for-reopen"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "the work is intentionally omitted",
  });
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "cancelled");
  assert.equal(row(`SELECT status FROM tasks`).status, "skipped");

  reopenTask({
    invocation: invocation("task/reopen/cancelled"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "the omitted work is required again",
  });
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = :lifecycle_id
  `, { ":lifecycle_id": seeded.lifecycleId }).lifecycle_status, "ready");
  assert.equal(row(`SELECT status FROM tasks`).status, "pending");
});

test("cancelTask atomically interrupts running work before cancelling its lifecycle", () => {
  const seeded = seedReadyTask();
  const claim = claimTaskAttempt({
    invocation: invocation("task/cancel/running-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: seeded.dispatchId,
  });
  const beforeRevision = Number(row(`SELECT revision FROM project_authority`).revision);

  const cancelled = cancelTask({
    invocation: invocation("task/cancel/running"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "the user withdrew this work",
  });

  assert.equal(cancelled.resultingRevision, beforeRevision + 1);
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "cancelled");
  assert.equal(row(`SELECT status FROM tasks`).status, "skipped");
  assert.deepEqual(row(`
    SELECT attempt.attempt_state, result.outcome
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
    WHERE attempt.attempt_id = :attempt_id
  `, { ":attempt_id": claim.attemptId }), {
    attempt_state: "settled",
    outcome: "interrupted",
  });
  assert.equal(row(`
    SELECT next_stage FROM workflow_kernel_checkpoints
    WHERE attempt_id = :attempt_id ORDER BY sequence DESC LIMIT 1
  `, { ":attempt_id": claim.attemptId }).next_stage, "route");
  assert.equal(row(`
    SELECT status FROM unit_dispatches WHERE id = :dispatch_id
  `, { ":dispatch_id": seeded.dispatchId }).status, "canceled");
});

test("cancelTask terminates an abandoned running Attempt after its worker lease expires", () => {
  const seeded = seedReadyTask();
  const claim = claimTaskAttempt({
    invocation: invocation("task/cancel/expired-claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: seeded.dispatchId,
  });
  db().prepare(`
    UPDATE milestone_leases
    SET expires_at = '2020-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001' AND worker_id = 'worker-1'
  `).run();

  const cancelled = cancelTask({
    invocation: invocation("task/cancel/expired-running"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "abandoned work is no longer required",
  });

  assert.equal(cancelled.interruptedAttemptId, claim.attemptId);
  assert.equal(row(`SELECT settle_outcome FROM workflow_execution_attempts`).settle_outcome, "interrupted");
  assert.equal(row(`SELECT status FROM unit_dispatches`).status, "canceled");
  assert.equal(row(`SELECT lifecycle_status FROM workflow_item_lifecycles`).lifecycle_status, "cancelled");
});

test("reopenTask rejects closed parents without changing terminal Task history", () => {
  const completed = completeTaskWithHistory();
  db().prepare(`UPDATE slices SET status = 'complete' WHERE milestone_id = 'M001' AND id = 'S01'`).run();
  const beforeRevision = Number(row(`SELECT revision FROM project_authority`).revision);

  assert.throws(() => reopenTask({
    invocation: invocation("task/reopen/closed-parent"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "must reopen the parent first",
  }), /closed slice/);
  db().prepare(`UPDATE slices SET status = 'deferred' WHERE milestone_id = 'M001' AND id = 'S01'`).run();
  assert.throws(() => reopenTask({
    invocation: invocation("task/reopen/deferred-slice"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "deferred work remains terminal",
  }), /closed slice/);
  db().prepare(`UPDATE slices SET status = 'active' WHERE milestone_id = 'M001' AND id = 'S01'`).run();
  db().prepare(`UPDATE milestones SET status = 'deferred' WHERE id = 'M001'`).run();
  assert.throws(() => reopenTask({
    invocation: invocation("task/reopen/deferred-milestone"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "deferred work remains terminal",
  }), /closed milestone/);
  db().prepare(`UPDATE milestones SET status = 'active' WHERE id = 'M001'`).run();
  db().prepare(`UPDATE slices SET status = 'quarantined' WHERE milestone_id = 'M001' AND id = 'S01'`).run();
  assert.throws(() => reopenTask({
    invocation: invocation("task/reopen/unknown-slice"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "unknown parent state cannot be treated as open",
  }), /unknown status quarantined/);
  assert.equal(Number(row(`SELECT revision FROM project_authority`).revision), beforeRevision);
  assert.equal(row(`
    SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = :lifecycle_id
  `, { ":lifecycle_id": completed.lifecycleId }).lifecycle_status, "completed");
  assert.equal(count("workflow_execution_attempts"), 1);
  assert.equal(count("workflow_attempt_results"), 1);
});
