// Project/App: gsd-pi
// File Purpose: Executable contract for context-bound Task recovery and Blocker writers.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  appendRecoveryWorkCheckpoint,
  createOrReadRecoveryBudget,
  grantRecoveryWaiver,
  openRecoveryBlocker,
  recordFailureObservation,
  recordRequirementDisposition,
  recordRecoveryAction,
  resolveRecoveryBlocker,
  terminateRecoveryWaiver,
} from "../db/writers/task-recovery.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";

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

function runOperation(
  operationType: string,
  idempotencyKey: string,
  mutation: Parameters<typeof executeDomainOperation>[1],
): void {
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "task-recovery-writer-test",
    sourceTransport: "test",
    payload: { operationType },
  }, mutation);
}

function operationMutation() {
  return {
    events: [{
      eventType: "test.task.recovery",
      entityType: "task",
      entityId: "M001/S01/T01",
      payload: {},
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: "test/task/recovery",
      projectionKind: "task-recovery",
      rendererVersion: "1",
    }],
  };
}

function seedFailedAttempt(): {
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-recovery-writers-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Recovery', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Recovery writers', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Recover deterministically', 'pending');
    INSERT INTO requirements (id, class, status, description)
    VALUES ('R001', 'primary-user-loop', 'active', 'Recovery remains automatic');
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
      'trace-1', 'turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  runOperation("test.task.ready", "fixture/task-ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return operationMutation();
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture/attempt-claim",
      sourceTransport: "internal",
      actorType: "agent",
    },
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  const settled = settleTaskAttempt({
    invocation: {
      idempotencyKey: "fixture/attempt-settle",
      sourceTransport: "internal",
      actorType: "agent",
    },
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "tool-unavailable",
    summary: "tool surface was temporarily unavailable",
    output: {},
  });
  const scope = row(`
    SELECT lifecycle.lifecycle_id, checkpoint.kernel_checkpoint_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
    WHERE lifecycle.task_id = 'T01'
      AND checkpoint.next_stage = 'route'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `);
  return {
    lifecycleId: String(scope.lifecycle_id),
    attemptId: claim.attemptId,
    resultId: settled.resultId,
    kernelCheckpointId: String(scope.kernel_checkpoint_id),
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("agent failure, fixed budget, and selected action share one current route head", () => {
  const scope = seedFailedAttempt();
  runOperation("attempt.route", "route/agent/1", (context) => {
    const observation = recordFailureObservation(context, {
      ...scope,
      recoveryOwner: "agent",
      failureKind: "tool-unavailable",
      failureFingerprint: "tool-unavailable:surface-pending",
      summary: "tool surface is pending registration",
      evidence: { source: "executor" },
    });
    const budget = createOrReadRecoveryBudget(context, {
      lifecycleId: scope.lifecycleId,
      failureKind: "tool-unavailable",
      failureFingerprint: "tool-unavailable:surface-pending",
      policyClass: "transient-execution",
      maxUses: 2,
      policyVersion: "task-recovery-v1",
    });
    assert.equal(createOrReadRecoveryBudget(context, {
      lifecycleId: scope.lifecycleId,
      failureKind: "tool-unavailable",
      failureFingerprint: "tool-unavailable:surface-pending",
      policyClass: "transient-execution",
      maxUses: 2,
      policyVersion: "task-recovery-v1",
    }).recoveryBudgetId, budget.recoveryBudgetId);
    const action = recordRecoveryAction(context, {
      lifecycleId: scope.lifecycleId,
      failureObservationId: observation.failureObservationId,
      action: "retry",
      recoveryBudgetId: budget.recoveryBudgetId,
      targetLifecycleId: scope.lifecycleId,
      rationale: "the temporary tool failure has retry budget",
      policyVersion: "task-recovery-v1",
    });
    assert.equal(action.action, "retry");
    return operationMutation();
  });

  assert.equal(count("workflow_failure_observations"), 1);
  assert.equal(count("workflow_recovery_budgets"), 1);
  assert.equal(count("workflow_recovery_actions"), 1);
  assert.deepEqual(row(`
    SELECT recovery_owner, blocker_id FROM workflow_failure_observations
  `), { recovery_owner: "agent", blocker_id: null });
});

test("human recovery requires an exact open blocker and resolves causally", () => {
  const scope = seedFailedAttempt();
  let blockerId = "";
  runOperation("attempt.route", "route/user/1", (context) => {
    const blocker = openRecoveryBlocker(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      kernelCheckpointId: scope.kernelCheckpointId,
      blockerKind: "missing_access",
      resolutionOwner: "user",
      description: "deployment credentials are unavailable",
      requestedAction: "Provide deployment access",
    });
    blockerId = blocker.blockerId;
    const observation = recordFailureObservation(context, {
      ...scope,
      blockerId,
      recoveryOwner: "user",
      failureKind: "provider",
      failureFingerprint: "provider:missing-access",
      summary: "deployment access is required",
      evidence: { provider: "deployment" },
    });
    recordRecoveryAction(context, {
      lifecycleId: scope.lifecycleId,
      failureObservationId: observation.failureObservationId,
      action: "pause",
      blockerId,
      rationale: "only the user can provide account access",
      policyVersion: "task-recovery-v1",
    });
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: scope.lifecycleId,
      scopeKey: "task:m001/s01/t01",
      checkpointKind: "pause",
      confirmedContext: "execution requires deployment access",
      unresolvedSummary: "waiting for the user to provide access",
      evidenceSummary: "provider rejected deployment without credentials",
      suggestedNextAction: "resume after access is available",
    });
    assert.equal(checkpoint.sequence, 1);
    return operationMutation();
  });
  runOperation("task.blocker.resolve", "blocker/resolve/1", (context) => {
    const resolved = resolveRecoveryBlocker(context, {
      blockerId,
      resolution: "deployment access was provided",
      disposition: "resolved",
    });
    assert.equal(resolved.blockerStatus, "resolved");
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: scope.lifecycleId,
      scopeKey: "task:m001/s01/t01",
      checkpointKind: "answer",
      confirmedContext: "deployment access is now available",
      unresolvedSummary: "",
      evidenceSummary: "the user confirmed access",
      suggestedNextAction: "retry the affected task",
    });
    assert.equal(checkpoint.sequence, 2);
    return operationMutation();
  });

  assert.deepEqual(row(`
    SELECT blocker_status, resolution FROM workflow_blockers WHERE blocker_id = :blocker_id
  `, { ":blocker_id": blockerId }), {
    blocker_status: "resolved",
    resolution: "deployment access was provided",
  });
  assert.deepEqual(db().prepare(`
    SELECT checkpoint_kind, sequence FROM workflow_work_checkpoints ORDER BY sequence
  `).all(), [
    { checkpoint_kind: "pause", sequence: 1 },
    { checkpoint_kind: "answer", sequence: 2 },
  ]);
});

test("writers reject stale route heads, invalid blocker ownership, and calls outside a Domain Operation", () => {
  const scope = seedFailedAttempt();
  const fakeContext = {
    operationId: "missing-operation",
    projectId: String(row("SELECT project_id FROM project_authority").project_id),
    resultingRevision: 99,
    resultingAuthorityEpoch: 0,
  };
  assert.throws(() => recordFailureObservation(fakeContext, {
    ...scope,
    recoveryOwner: "agent",
    failureKind: "tool-unavailable",
    failureFingerprint: "tool-unavailable:outside-operation",
    summary: "outside operation",
    evidence: {},
  }), /active Domain Operation context/);

  const before = count("workflow_blockers");
  assert.throws(() => runOperation("attempt.route", "route/invalid-owner/1", (context) => {
    openRecoveryBlocker(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      kernelCheckpointId: scope.kernelCheckpointId,
      blockerKind: "external_dependency",
      resolutionOwner: "user",
      description: "invalid owner",
      requestedAction: "wait",
    });
    return operationMutation();
  }), /external_dependency recovery requires an external owner/);
  assert.throws(() => runOperation("attempt.route", "route/stale/1", (context) => {
    openRecoveryBlocker(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      kernelCheckpointId: "stale-checkpoint",
      blockerKind: "external_dependency",
      resolutionOwner: "external",
      description: "stale route head",
      requestedAction: "wait",
    });
    return operationMutation();
  }), /current route head/);
  assert.equal(count("workflow_blockers"), before);
});

test("waiver grant, waived disposition, and termination preserve ordered current heads", () => {
  const scope = seedFailedAttempt();
  let waiverId = "";
  runOperation("task.waiver.grant", "waiver/grant/1", (context) => {
    const waiver = grantRecoveryWaiver(context, {
      lifecycleId: scope.lifecycleId,
      requirementId: "R001",
      scope: "M001/S01/T01 objective verification",
      rationale: "temporary policy waiver approved by the user",
      grantedByActorType: "user",
      grantedByActorId: "user-1",
    });
    waiverId = waiver.waiverId;
    return operationMutation();
  });

  let waivedDispositionId = "";
  runOperation("task.disposition.record", "disposition/waived/1", (context) => {
    const disposition = recordRequirementDisposition(context, {
      requirementId: "R001",
      disposition: "waived",
      waiverId,
      rationale: "the active waiver temporarily satisfies this requirement",
    });
    waivedDispositionId = disposition.dispositionId;
    return operationMutation();
  });

  assert.throws(() => runOperation("task.waiver.terminate", "waiver/invalid-terminate/1", (context) => {
    terminateRecoveryWaiver(context, {
      waiverId,
      disposition: "revoked",
    });
    return operationMutation();
  }), /supersede|waiver termination/i);
  assert.equal(row(`
    SELECT waiver_status FROM workflow_waivers WHERE waiver_id = :waiver_id
  `, { ":waiver_id": waiverId }).waiver_status, "active");

  runOperation("task.waiver.terminate", "waiver/terminate/1", (context) => {
    recordRequirementDisposition(context, {
      requirementId: "R001",
      disposition: "unsatisfied",
      supersedesDispositionId: waivedDispositionId,
      rationale: "revocation restores the requirement to unsatisfied",
    });
    terminateRecoveryWaiver(context, {
      waiverId,
      disposition: "revoked",
    });
    return operationMutation();
  });

  assert.deepEqual(row(`
    SELECT waiver_status, ended_operation_id IS NOT NULL AS ended
    FROM workflow_waivers WHERE waiver_id = :waiver_id
  `, { ":waiver_id": waiverId }), { waiver_status: "revoked", ended: 1 });
  assert.deepEqual(db().prepare(`
    SELECT disposition, supersedes_disposition_id
    FROM workflow_requirement_dispositions
    WHERE requirement_id = 'R001'
    ORDER BY project_revision
  `).all(), [
    { disposition: "waived", supersedes_disposition_id: null },
    { disposition: "unsatisfied", supersedes_disposition_id: waivedDispositionId },
  ]);
});

test("waived dispositions require a prior active waiver and the exact current head", () => {
  const scope = seedFailedAttempt();
  let waiverId = "";
  assert.throws(() => runOperation("task.disposition.record", "disposition/no-waiver/1", (context) => {
    recordRequirementDisposition(context, {
      requirementId: "R001",
      disposition: "waived",
      waiverId: "missing-waiver",
      rationale: "must fail without authority",
    });
    return operationMutation();
  }), /waiver|foreign key/i);

  runOperation("task.waiver.grant", "waiver/grant/2", (context) => {
    waiverId = grantRecoveryWaiver(context, {
      lifecycleId: scope.lifecycleId,
      requirementId: "R001",
      scope: "M001/S01/T01",
      rationale: "policy waiver",
      grantedByActorType: "policy",
    }).waiverId;
    return operationMutation();
  });
  let headId = "";
  runOperation("task.disposition.record", "disposition/head/1", (context) => {
    headId = recordRequirementDisposition(context, {
      requirementId: "R001",
      disposition: "waived",
      waiverId,
      rationale: "active policy waiver",
    }).dispositionId;
    return operationMutation();
  });
  assert.throws(() => runOperation("task.disposition.record", "disposition/stale/1", (context) => {
    recordRequirementDisposition(context, {
      requirementId: "R001",
      disposition: "satisfied",
      rationale: "missing current head",
    });
    return operationMutation();
  }), /current head|supersede/i);
  assert.equal(row(`
    SELECT disposition_id FROM workflow_requirement_dispositions
    WHERE requirement_id = 'R001'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_requirement_dispositions successor
        WHERE successor.supersedes_disposition_id = workflow_requirement_dispositions.disposition_id
      )
  `).disposition_id, headId);
});
