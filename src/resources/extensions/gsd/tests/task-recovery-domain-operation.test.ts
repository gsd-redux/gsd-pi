// Project/App: gsd-pi
// File Purpose: Executable contract for replay-safe Task recovery Domain Operations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  appendTaskWorkCheckpoint,
  grantTaskWaiver,
  recordFailureAndSelectRecovery,
  recordTaskRequirementDisposition,
  resolveTaskBlocker,
  terminateTaskWaiver,
} from "../task-recovery-domain-operation.ts";
import { claimTaskAttempt, settleTaskAttempt } from "../task-execution-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

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
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-recovery-operation-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
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
    lifecycleId: String(current.lifecycle_id),
    attemptId: claim.attemptId,
    resultId: settlement.resultId,
    kernelCheckpointId: String(current.kernel_checkpoint_id),
  };
}

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

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("durable budget use survives retries and exhausts to agent abort", () => {
  const firstFailure = seedFailedAttempt();
  const route = (key: string, failure: { attemptId: string; resultId: string }) =>
    recordFailureAndSelectRecovery({
      invocation: invocation(key),
      ...failure,
      owner: "agent",
      classification: { failureKind: "tool-unavailable" },
      summary: "tool surface unavailable",
      evidence: { source: "executor" },
      rationale: "apply the durable recovery policy",
    });

  const first = route("recovery/budget/1", firstFailure);
  const secondFailure = seedRetryFailure(firstFailure.attemptId, 2);
  const second = route("recovery/budget/2", secondFailure);
  const thirdFailure = seedRetryFailure(secondFailure.attemptId, 3);
  const third = route("recovery/budget/3", thirdFailure);

  assert.equal(first.action, "retry");
  assert.equal(second.action, "retry");
  assert.equal(second.recoveryBudgetId, first.recoveryBudgetId);
  assert.equal(third.action, "abort");
  assert.equal(third.recoveryBudgetId, undefined);
  assert.equal(count("workflow_recovery_budgets"), 1);
  assert.equal(count("workflow_recovery_actions"), 3);
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
