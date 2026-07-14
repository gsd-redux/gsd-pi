// Project/App: gsd-pi
// File Purpose: Capstone fault convergence for direct Slice lifecycle operations.

import assert from "node:assert/strict";
import test from "node:test";

import {
  _setDomainOperationFaultForTest,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  cancelSlice,
  completeSlice,
  reopenSlice,
  type SliceCompletionCloseout,
} from "../slice-lifecycle-domain-operation.ts";
import { _getAdapter } from "../gsd-db.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

const PRECOMMIT_FAULT_POINTS: readonly DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

type SliceOperationKind = "complete" | "cancel" | "reopen";

interface PreparedOperation {
  run(): { status: "committed" | "replayed" };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "test database must be open");
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function invocation(kind: SliceOperationKind): ExecutionInvocation {
  const idempotencyKey = `slice-convergence/${kind}`;
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "system",
    actorId: "slice-convergence-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function closeout(): SliceCompletionCloseout {
  return {
    sliceTitle: "Fault convergence",
    oneLiner: "The Slice lifecycle operation is atomic.",
    narrative: "Every precommit fault leaves the exact durable state unchanged.",
    verification: "Focused fault matrix",
    uatContent: "## UAT Type\n\n- UAT mode: runtime-executable\n\nPASS",
    operationalReadiness: "Automated rollback and replay checks passed.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    provides: [],
    requires: [],
    affects: [],
    keyFiles: [],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    drillDownPaths: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsSurfaced: [],
    requirementsInvalidated: [],
    filesModified: [],
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    gates: rows("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, gate_id, task_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY item_kind, milestone_id, slice_id, task_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY lifecycle_id, attempt_number"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY lifecycle_id, created_at"),
    criteria: rows("SELECT * FROM workflow_acceptance_criteria ORDER BY lifecycle_id, created_at"),
    verdicts: rows("SELECT * FROM workflow_technical_verdicts ORDER BY lifecycle_id, created_at"),
    evidence: rows("SELECT * FROM workflow_verification_evidence ORDER BY lifecycle_id, created_at"),
    kernelCheckpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY lifecycle_id, sequence"),
    workCheckpoints: rows("SELECT * FROM workflow_work_checkpoints ORDER BY project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
  };
}

function prepareOperation(kind: SliceOperationKind): PreparedOperation {
  if (kind === "complete") {
    seedSliceCompletionAuthority({
      milestoneId: "M001",
      sliceId: "S02",
      completedTaskIds: ["T01"],
      runId: "convergence-complete",
    });
    return {
      run: () => completeSlice({
        invocation: invocation(kind),
        slice: { milestoneId: "M001", sliceId: "S02" },
        closeout: closeout(),
      }),
    };
  }

  if (kind === "cancel") {
    seedSliceCompletionAuthority({
      milestoneId: "M001",
      sliceId: "S02",
      runId: "convergence-cancel",
    });
    return {
      run: () => cancelSlice({
        invocation: invocation(kind),
        slice: { milestoneId: "M001", sliceId: "S02" },
        reason: "The remaining Slice work is no longer required.",
      }),
    };
  }

  seedSliceCompletionAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    completedTaskIds: ["T01"],
    runId: "convergence-reopen",
  });
  return {
    run: () => reopenSlice({
      invocation: invocation(kind),
      slice: { milestoneId: "M001", sliceId: "S01" },
      reason: "The complete Slice must be redone.",
    }),
  };
}

for (const kind of ["complete", "cancel", "reopen"] as const) {
  for (const faultPoint of PRECOMMIT_FAULT_POINTS) {
    test(`${kind} rolls back exactly at ${faultPoint}`, { concurrency: false }, async (t) => {
      const fixture = await createWorkflowAuthorityFixture();
      t.after(() => {
        _setDomainOperationFaultForTest(null);
        fixture.cleanup();
      });
      const operation = prepareOperation(kind);
      const before = durableSnapshot();

      _setDomainOperationFaultForTest(faultPoint);
      assert.throws(operation.run, new RegExp(`domain operation fault: ${faultPoint}`));
      _setDomainOperationFaultForTest(null);

      assert.deepEqual(
        durableSnapshot(),
        before,
        `${kind} must leave exact zero durable residue at ${faultPoint}`,
      );
    });
  }

  test(`${kind} replays one exact receipt after an after-commit lost response`, { concurrency: false }, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    t.after(() => {
      _setDomainOperationFaultForTest(null);
      fixture.cleanup();
    });
    const operation = prepareOperation(kind);

    _setDomainOperationFaultForTest("after-commit");
    assert.throws(operation.run, /domain operation fault: after-commit/);
    _setDomainOperationFaultForTest(null);
    const committed = durableSnapshot();

    const replayed = operation.run();

    assert.equal(replayed.status, "replayed");
    assert.deepEqual(
      durableSnapshot(),
      committed,
      `${kind} retry must not advance authority or duplicate durable lineage`,
    );
  });
}
