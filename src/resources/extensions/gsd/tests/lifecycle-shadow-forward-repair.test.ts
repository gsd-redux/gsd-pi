// Project/App: gsd-pi
// File Purpose: Executable contract for evidence-gated forward lifecycle-shadow repair.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  repairLifecycleShadowStep,
  type CanonicalLifecycleStatus,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
} from "../lifecycle-shadow-repair-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  _setLifecycleShadowRepairBeforeCommitForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function openFixture(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-forward-repair-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Historical milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Historical slice', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M001', 'S01', 'T01', 'Missing terminal shadow', 'complete',
        '2026-07-02T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary'
      ),
      (
        'M001', 'S01', 'T02', 'Ready bootstrap head', 'complete',
        '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T02 summary'
      ),
      (
        'M001', 'S01', 'T03', 'Unsupported evidence', 'complete',
        NULL, '', '', '', ''
      );
  `);
  t.after(closeDatabase);
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "shadow-repair-test",
    traceId: "trace-shadow-repair",
    turnId: "turn-shadow-repair",
  };
}

function task(taskId: string) {
  return {
    itemKind: "task" as const,
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
  };
}

function seedLifecycle(
  item: LifecycleIdentity,
  status: CanonicalLifecycleStatus,
  idempotencyKey: string,
): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  const payload: DomainJsonValue = {
    itemKind: item.itemKind,
    milestoneId: item.milestoneId,
    sliceId: item.sliceId ?? null,
    taskId: item.taskId ?? null,
    status,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.lifecycle.seed",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      ...item,
      lifecycleStatus: status,
    });
    return {
      events: [{
        eventType: "test.lifecycle.seeded",
        entityType: item.itemKind,
        entityId: id,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: idempotencyKey.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function adoptReadyItem(item: LifecycleIdentity): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  seedLifecycle(item, "ready", `test/bootstrap/${item.itemKind}/${id}`);
}

function transitionTask(taskId: string, status: "paused" | "in_progress", key: string): void {
  seedLifecycle(task(taskId), status, key);
}

function rows(table: string): Array<Record<string, unknown>> {
  return db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function authoritySnapshot(): Record<string, unknown> {
  return {
    authority: db().prepare("SELECT revision, authority_epoch FROM project_authority").get(),
    hierarchy: db().prepare(`
      SELECT id, status, completed_at, one_liner, narrative, verification_result
      FROM tasks ORDER BY id
    `).all(),
    lifecycles: rows("workflow_item_lifecycles"),
    attempts: rows("workflow_execution_attempts"),
    results: rows("workflow_attempt_results"),
    operations: rows("workflow_operations"),
    events: rows("workflow_domain_events"),
    projections: rows("workflow_projection_work"),
  };
}

test("adopts a missing historical terminal Task shadow only from durable completion evidence", (t) => {
  openFixture(t);
  const beforeLegacy = db().prepare("SELECT * FROM tasks WHERE id = 'T01'").get();

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/missing/T01"),
    item: task("T01"),
  });

  assert.equal(receipt.status, "committed");
  assert.equal(receipt.disposition, "repaired");
  assert.equal(receipt.beforeStatus, null);
  assert.equal(receipt.targetStatus, "completed");
  assert.equal(receipt.afterStatus, "completed");
  assert.equal(receipt.evidence?.kind, "legacy_completion");
  assert.equal(receipt.evidence?.legacyStatus, "complete");
  assert.equal(receipt.evidence?.completedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(receipt.evidence?.verificationResult, "passed");
  assert.match(receipt.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(db().prepare("SELECT * FROM tasks WHERE id = 'T01'").get(), beforeLegacy);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);

  const event = db().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'lifecycle.shadow.repaired'
  `).get({ ":operation_id": receipt.operationId });
  const payload = JSON.parse(String(event?.["payload_json"]));
  assert.equal(payload.afterStatus, "completed");
  assert.equal(payload.beforeStatus, null);
  assert.equal(payload.disposition, "repaired");
  assert.deepEqual(payload.evidence, receipt.evidence);
  assert.deepEqual(payload.item, task("T01"));
  assert.equal(payload.targetStatus, "completed");
  assert.equal(payload.comparison.kind, "missing_shadow");
  assert.equal(payload.reason, null);
});

test("advances and then completes a ready historical Task through two separate calls", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));

  const advanced = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready/T02/advance"),
    item: task("T02"),
  });
  assert.equal(advanced.disposition, "advanced");
  assert.equal(advanced.beforeStatus, "ready");
  assert.equal(advanced.afterStatus, "in_progress");

  const completed = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready/T02/complete"),
    item: task("T02"),
  });
  assert.equal(completed.disposition, "repaired");
  assert.equal(completed.beforeStatus, "in_progress");
  assert.equal(completed.afterStatus, "completed");
  assert.notEqual(advanced.operationId, completed.operationId);

  const operations = db().prepare(`
    SELECT operation_id, operation_type, resulting_revision
    FROM workflow_operations
    WHERE operation_id IN (:first, :second)
    ORDER BY resulting_revision
  `).all({
    ":first": advanced.operationId,
    ":second": completed.operationId,
  });
  assert.deepEqual(operations.map((row) => row["operation_type"]), [
    "lifecycle.shadow.repair",
    "lifecycle.shadow.repair",
  ]);
  assert.equal(Number(operations[1]?.["resulting_revision"]), Number(operations[0]?.["resulting_revision"]) + 1);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("does not complete an in-progress Task whose current head is not its advance receipt", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));
  const advanced = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-current/T02/advance"),
    item: task("T02"),
  });
  assert.equal(advanced.disposition, "advanced");
  transitionTask("T02", "paused", "test/non-current/T02/paused");
  transitionTask("T02", "in_progress", "test/non-current/T02/in-progress");

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-current/T02/complete"),
    item: task("T02"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "in_progress");
  assert.equal(receipt.afterStatus, "in_progress");
});

test("exact replay returns the stored repair receipt and changed key reuse conflicts", (t) => {
  openFixture(t);
  const input = {
    invocation: invocation("shadow-repair/replay"),
    item: task("T01"),
  };
  const committed = repairLifecycleShadowForward(input);
  const afterCommit = authoritySnapshot();
  const replayed = repairLifecycleShadowForward(input);

  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(authoritySnapshot(), afterCommit);
  assert.throws(() => repairLifecycleShadowForward({
    ...input,
    item: task("T02"),
  }), /idempotency conflict/i);
  assert.deepEqual(authoritySnapshot(), afterCommit);
});

test("unsupported historical evidence commits an actionable unresolved receipt without lifecycle mutation", (t) => {
  openFixture(t);
  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/unresolved/T03"),
    item: task("T03"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, null);
  assert.equal(receipt.targetStatus, null);
  assert.equal(receipt.afterStatus, null);
  assert.match(receipt.reason ?? "", /durable completion evidence/i);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles WHERE task_id = 'T03'
  `).get()?.["count"], 0);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("records an extra canonical shadow as unresolved when its legacy row is missing", (t) => {
  openFixture(t);
  adoptReadyItem(task("T03"));
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare("DELETE FROM tasks WHERE id = 'T03'").run();
  db().exec("PRAGMA foreign_keys = ON");

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/extra/T03"),
    item: task("T03"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "ready");
  assert.equal(receipt.afterStatus, "ready");
  assert.equal(receipt.targetStatus, null);
  assert.equal(receipt.comparison.kind, "extra_shadow");
  assert.match(receipt.reason ?? "", /legacy hierarchy row is missing/i);
});

test("the repair writer rejects a caller whose expected before status is stale", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));
  const before = authoritySnapshot();
  const fence = readDomainOperationFence();

  assert.throws(() => executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey: "shadow-repair/wrong-before/T02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { item: task("T02") },
  }, (context) => {
    repairLifecycleShadowStep(context, {
      ...task("T02"),
      expectedBeforeStatus: null,
      targetStatus: "completed",
    });
    throw new Error("unreachable");
  }), /current status does not match expected before status/i);
  assert.deepEqual(authoritySnapshot(), before);
});

const unsupportedWriterEdges: Array<{
  name: string;
  item: LifecycleIdentity;
  before: CanonicalLifecycleStatus;
  target: "in_progress" | "completed";
}> = [
  { name: "ready Milestone completion", item: { itemKind: "milestone", milestoneId: "M001" }, before: "ready", target: "completed" },
  { name: "ready Milestone advance", item: { itemKind: "milestone", milestoneId: "M001" }, before: "ready", target: "in_progress" },
  { name: "ready Slice advance", item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, before: "ready", target: "in_progress" },
  { name: "in-progress Slice completion", item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, before: "in_progress", target: "completed" },
  { name: "paused Task advance", item: task("T01"), before: "paused", target: "in_progress" },
  { name: "completed Task same-status repair", item: task("T01"), before: "completed", target: "completed" },
  { name: "cancelled Task completion", item: task("T01"), before: "cancelled", target: "completed" },
  { name: "ready Task direct completion", item: task("T01"), before: "ready", target: "completed" },
];

for (const repairCase of unsupportedWriterEdges) {
  test(`repair writer rejects ${repairCase.name}`, (t) => {
    openFixture(t);
    seedLifecycle(repairCase.item, repairCase.before, `test/invalid-edge/seed/${repairCase.name}`);
    const before = authoritySnapshot();
    const fence = readDomainOperationFence();

    assert.throws(() => executeDomainOperation({
      operationType: "lifecycle.shadow.repair",
      idempotencyKey: `test/invalid-edge/repair/${repairCase.name}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "agent",
      sourceTransport: "test",
      payload: { name: repairCase.name },
    }, (context) => {
      repairLifecycleShadowStep(context, {
        ...repairCase.item,
        expectedBeforeStatus: repairCase.before,
        targetStatus: repairCase.target,
      });
      throw new Error("unreachable");
    }), /unsupported lifecycle shadow repair edge/i);
    assert.deepEqual(authoritySnapshot(), before);
  });
}

test("repairs Slice and Milestone shadows only when every descendant has completion evidence", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary'
    WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-05T00:00:00.000Z'
    WHERE id = 'M001';
  `);

  const slice = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/slice/S01"),
    item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" },
  });
  const milestone = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/milestone/M001"),
    item: { itemKind: "milestone", milestoneId: "M001" },
  });

  assert.equal(slice.afterStatus, "completed");
  assert.equal(milestone.afterStatus, "completed");
  assert.match(slice.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.match(milestone.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("keeps a ready Milestone unresolved even when historical completion evidence is complete", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary';
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-05T00:00:00.000Z';
  `);
  adoptReadyItem({ itemKind: "milestone", milestoneId: "M001" });

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready-milestone/M001"),
    item: { itemKind: "milestone", milestoneId: "M001" },
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "ready");
  assert.equal(receipt.afterStatus, "ready");
  assert.equal(receipt.targetStatus, "completed");
});

test("a changed evidence digest is rejected inside the repair transaction", (t) => {
  openFixture(t);
  _setLifecycleShadowRepairBeforeCommitForTest(() => {
    db().prepare("UPDATE tasks SET full_summary_md = '# changed' WHERE id = 'T01'").run();
  });

  assert.throws(() => repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/stale-evidence"),
    item: task("T01"),
  }), /stable durable completion evidence/i);
  assert.equal(rows("workflow_operations").length, 0);
  assert.equal(rows("workflow_item_lifecycles").length, 0);
});

const precommitFaults: DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

type RepairEdge = "adopt" | "advance" | "complete";

function prepareRepairEdge(edge: RepairEdge, key: string) {
  if (edge === "adopt") {
    return {
      invocation: invocation(key),
      item: task("T01"),
    };
  }
  adoptReadyItem(task("T02"));
  if (edge === "complete") {
    const advanced = repairLifecycleShadowForward({
      invocation: invocation(`${key}/prior-advance`),
      item: task("T02"),
    });
    assert.equal(advanced.disposition, "advanced");
  }
  return {
    invocation: invocation(key),
    item: task("T02"),
  };
}

for (const edge of ["adopt", "advance", "complete"] as const) {
  for (const fault of precommitFaults) {
    test(`${edge} ${fault} fault leaves the exact prior snapshot`, (t) => {
      openFixture(t);
      const input = prepareRepairEdge(edge, `shadow-repair/fault/${edge}/${fault}`);
      const before = authoritySnapshot();
      _setDomainOperationFaultForTest(fault);

      assert.throws(
        () => repairLifecycleShadowForward(input),
        new RegExp(`domain operation fault: ${fault}`, "i"),
      );
      assert.deepEqual(authoritySnapshot(), before);
    });
  }

  test(`${edge} after-commit lost response replays exactly one stored edge`, (t) => {
    openFixture(t);
    const input = prepareRepairEdge(edge, `shadow-repair/fault/${edge}/after-commit`);
    const operationCountBefore = rows("workflow_operations").length;
    _setDomainOperationFaultForTest("after-commit");
    assert.throws(() => repairLifecycleShadowForward(input), /domain operation fault: after-commit/i);
    _setDomainOperationFaultForTest(null);
    const afterCommit = authoritySnapshot();
    assert.equal(rows("workflow_operations").length, operationCountBefore + 1);

    const replayed = repairLifecycleShadowForward(input);
    assert.equal(replayed.status, "replayed");
    assert.deepEqual(authoritySnapshot(), afterCommit);
  });
}
