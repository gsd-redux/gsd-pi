// Project/App: gsd-pi
// File Purpose: Canonical Milestone validation lifecycle, replay, and rollback contracts.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import {
  prepareMilestoneValidation,
  recordMilestoneValidation,
  settleMilestoneValidation,
} from "../milestone-validation-domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";

let basePath: string | undefined;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string): number {
  const result = db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(result?.["count"] ?? 0);
}

function invoke(idempotencyKey: string) {
  return {
    idempotencyKey,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "milestone-validation-test",
  };
}

function setup(): void {
  basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-validation-core-"));
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Canonical validation", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "fixture/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("Milestone validation stores objective criteria, an immutable Result, evidence, and exact replay receipts", () => {
  setup();
  const prepared = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/prepare/1"),
    milestoneId: "M001",
    criteria: [
      {
        criterionKey: "focused-tests",
        evidenceClass: "command",
        description: "Focused tests pass.",
      },
      {
        criterionKey: "rendered-flow",
        evidenceClass: "browser",
        description: "The rendered workflow succeeds.",
      },
    ],
  });
  const prepareReplay = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/prepare/1"),
    milestoneId: "M001",
    criteria: [
      {
        criterionKey: "focused-tests",
        evidenceClass: "command",
        description: "Focused tests pass.",
      },
      {
        criterionKey: "rendered-flow",
        evidenceClass: "browser",
        description: "The rendered workflow succeeds.",
      },
    ],
  });

  assert.equal(prepared.status, "committed");
  assert.equal(prepareReplay.status, "replayed");
  assert.equal(prepareReplay.attemptId, prepared.attemptId);
  assert.deepEqual(prepareReplay.criteria, prepared.criteria);
  assert.equal(count("workflow_execution_attempts"), 1);
  assert.equal(count("workflow_acceptance_criteria"), 2);
  assert.deepEqual(db().prepare(`
    SELECT attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token, started_at
    FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
  `).get({ ":attempt_id": prepared.attemptId }), {
    attempt_state: "claimed",
    coordination_dispatch_id: null,
    worker_id: null,
    milestone_lease_token: null,
    started_at: null,
  });

  const settled = settleMilestoneValidation({
    invocation: invoke("milestone-validation/settle/1"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation checks completed.",
    output: { checks: 2 },
  });
  const settlementReplay = settleMilestoneValidation({
    invocation: invoke("milestone-validation/settle/1"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation checks completed.",
    output: { checks: 2 },
  });
  assert.equal(settlementReplay.status, "replayed");
  assert.equal(settlementReplay.resultId, settled.resultId);
  assert.match(String((settled as { endedAt?: unknown }).endedAt ?? ""), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    (settlementReplay as { endedAt?: unknown }).endedAt,
    (settled as { endedAt?: unknown }).endedAt,
    "replay must return the stored settlement timestamp for stable evidence",
  );
  assert.equal(count("workflow_attempt_results"), 1);

  const criterionResults = prepared.criteria.map((criterion, index) => ({
    criterionId: criterion.criterionId,
    verdict: "pass" as const,
    rationale: `${criterion.criterionKey} passed.`,
    evidence: [{
      evidenceClass: criterion.evidenceClass,
      commandOrTool: index === 0 ? "pnpm test focused" : "browser smoke",
      workingDirectory: "/workspace",
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      exitCode: 0,
      observation: "passed" as const,
      durableOutputRef: `artifact://validation/${criterion.criterionKey}`,
      environment: { runner: index === 0 ? "node-test" : "browser" },
    }],
  }));
  const recorded = recordMilestoneValidation({
    invocation: invoke("milestone-validation/record/1"),
    attemptId: prepared.attemptId,
    testedSourceRevision: "sha256:tested-source",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "All required objective criteria passed.",
    criterionResults,
  });
  const recordReplay = recordMilestoneValidation({
    invocation: invoke("milestone-validation/record/1"),
    attemptId: prepared.attemptId,
    testedSourceRevision: "sha256:tested-source",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "All required objective criteria passed.",
    criterionResults,
  });

  assert.equal(recorded.status, "committed");
  assert.equal(recordReplay.status, "replayed");
  assert.deepEqual(recordReplay.verdicts, recorded.verdicts);
  assert.equal(count("workflow_technical_verdicts"), 2);
  assert.equal(count("workflow_verification_evidence"), 2);
  assert.equal(count("workflow_human_acceptances"), 0);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE operation.operation_type = 'milestone.validate'
      AND event.event_type = 'milestone.validation.recorded'
  `).get()?.["count"], 1);
  const aggregateEvent = db().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id
      AND event_type = 'milestone.validation.recorded'
  `).get({ ":operation_id": recorded.operationId });
  const aggregate = JSON.parse(String(aggregateEvent?.["payload_json"])) as Record<string, unknown>;
  assert.equal(aggregate["overallVerdict"], "pass");
  assert.deepEqual(aggregate["criterionIds"], recorded.verdicts.map((verdict) => verdict.criterionId));
  assert.deepEqual(aggregate["verdictIds"], recorded.verdicts.map((verdict) => verdict.verdictId));
  assert.deepEqual(
    aggregate["evidenceIds"],
    recorded.verdicts.flatMap((verdict) => verdict.evidenceIds),
  );
  assert.deepEqual(aggregate["humanAcceptanceIds"], []);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_projection_work projection
    JOIN workflow_operations operation
      ON operation.operation_id = projection.enqueue_operation_id
    WHERE projection.projection_kind = 'milestone-validation'
      AND operation.operation_type = 'milestone.validate'
  `).get()?.["count"], 1);
});

test("Milestone validation settlement identity includes the tested source", () => {
  setup();
  const prepared = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/source-bound/prepare"),
    milestoneId: "M001",
    criteria: [{
      criterionKey: "focused-tests",
      evidenceClass: "command",
      description: "Focused tests pass.",
    }],
  });
  settleMilestoneValidation({
    invocation: invoke("milestone-validation/source-bound/settle"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation checks completed.",
    output: { testedSourceRevision: "sha256:source-a" },
  });

  assert.throws(() => settleMilestoneValidation({
    invocation: invoke("milestone-validation/source-bound/settle"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation checks completed.",
    output: { testedSourceRevision: "sha256:source-b" },
  }), /idempotency conflict/i);
});

test("Milestone validation preparation retires criteria removed from the current plan", () => {
  setup();
  const first = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/reconcile/prepare-1"),
    milestoneId: "M001",
    criteria: [
      {
        criterionKey: "milestone-validation:aggregate",
        evidenceClass: "artifact",
        description: "Aggregate validation must pass.",
      },
      {
        criterionKey: "milestone-validation:uat",
        evidenceClass: "browser",
        description: "The planned browser UAT must pass.",
      },
    ],
  });
  settleMilestoneValidation({
    invocation: invoke("milestone-validation/reconcile/settle-1"),
    attemptId: first.attemptId,
    outcome: "interrupted",
    failureClass: "plan-changed",
    summary: "The validation plan changed before evidence was recorded.",
    output: { testedSourceRevision: "sha256:source-a" },
  });

  prepareMilestoneValidation({
    invocation: invoke("milestone-validation/reconcile/prepare-2"),
    milestoneId: "M001",
    criteria: [{
      criterionKey: "milestone-validation:aggregate",
      evidenceClass: "artifact",
      description: "Aggregate validation must pass.",
    }],
  });

  assert.deepEqual(db().prepare(`
    SELECT criterion_key, required
    FROM workflow_acceptance_criteria criterion
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_acceptance_criteria successor
      WHERE successor.supersedes_criterion_id = criterion.criterion_id
    )
    ORDER BY criterion_key
  `).all(), [
    { criterion_key: "milestone-validation:aggregate", required: 1 },
    { criterion_key: "milestone-validation:uat", required: 0 },
  ]);
});

test("Milestone validation rolls back when a required current criterion is omitted", () => {
  setup();
  const prepared = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/prepare/rollback"),
    milestoneId: "M001",
    criteria: [
      { criterionKey: "tests", evidenceClass: "command", description: "Tests pass." },
      { criterionKey: "runtime", evidenceClass: "runtime", description: "Runtime passes." },
    ],
  });
  settleMilestoneValidation({
    invocation: invoke("milestone-validation/settle/rollback"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Checks ran.",
    output: {},
  });
  const revisionBefore = Number(db().prepare(`SELECT revision FROM project_authority WHERE singleton = 1`).get()?.["revision"]);
  const testCriterion = prepared.criteria.find((criterion) => criterion.criterionKey === "tests");
  assert.ok(testCriterion);

  assert.throws(() => recordMilestoneValidation({
    invocation: invoke("milestone-validation/record/rollback"),
    attemptId: prepared.attemptId,
    testedSourceRevision: "sha256:tested-source",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "Incomplete evidence must not commit.",
    criterionResults: [{
      criterionId: testCriterion.criterionId,
      verdict: "pass",
      rationale: "Tests passed.",
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "pnpm test focused",
        workingDirectory: "/workspace",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        exitCode: 0,
        observation: "passed",
        durableOutputRef: "artifact://validation/tests",
        environment: { runner: "node-test" },
      }],
    }],
  }), /required current technical criteria/i);

  assert.equal(count("workflow_technical_verdicts"), 0);
  assert.equal(count("workflow_verification_evidence"), 0);
  assert.equal(Number(db().prepare(`SELECT revision FROM project_authority WHERE singleton = 1`).get()?.["revision"]), revisionBefore);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE idempotency_key = 'milestone-validation/record/rollback'
  `).get()?.["count"], 0);
});

test("Milestone validation rejects an aggregate verdict that hides failed evidence", () => {
  setup();
  const prepared = prepareMilestoneValidation({
    invocation: invoke("milestone-validation/prepare/aggregate"),
    milestoneId: "M001",
    criteria: [{
      criterionKey: "tests",
      evidenceClass: "command",
      description: "Tests pass.",
    }],
  });
  settleMilestoneValidation({
    invocation: invoke("milestone-validation/settle/aggregate"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Checks ran.",
    output: {},
  });

  assert.throws(() => recordMilestoneValidation({
    invocation: invoke("milestone-validation/record/aggregate"),
    attemptId: prepared.attemptId,
    testedSourceRevision: "sha256:tested-source",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "A passing aggregate must not hide a failure.",
    criterionResults: [{
      criterionId: prepared.criteria[0]!.criterionId,
      verdict: "fail",
      rationale: "Tests failed.",
      evidence: [{
        evidenceClass: "command",
        commandOrTool: "pnpm test focused",
        workingDirectory: "/workspace",
        startedAt: "2026-07-14T10:00:00.000Z",
        endedAt: "2026-07-14T10:01:00.000Z",
        exitCode: 1,
        observation: "failed",
        durableOutputRef: "artifact://validation/tests-failed",
        environment: { runner: "node-test" },
      }],
    }],
  }), /aggregate verdict/i);

  assert.equal(count("workflow_technical_verdicts"), 0);
  assert.equal(count("workflow_verification_evidence"), 0);
});
