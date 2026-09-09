// Project/App: gsd-pi
// File Purpose: Canonical Task completion must honor the blocking rework gate (#2231).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("../tools/workflow-tool-executors.ts", import.meta.url),
);

import {
  _getAdapter,
  closeDatabase,
  getUnresolvedBlockingReworkFindingsForTask,
  openDatabase,
  saveReworkBrief,
} from "../gsd-db.ts";
import { claimTaskAttempt } from "../task-execution-domain-operation.ts";
import { executeTaskComplete } from "../tools/workflow-tool-executors.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: key,
  };
}

function completionParams(): Record<string, unknown> {
  return {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    oneLiner: "Staged the executor result",
    narrative: "The executor result is ready for independent host verification.",
    verification: "Executor reports the focused test passed.",
    deviations: "None.",
    knownIssues: "None.",
    keyFiles: ["src/task.ts"],
    keyDecisions: ["Host verification owns completion."],
    blockerDiscovered: false,
    verificationEvidence: [{
      command: "npm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 10,
    }],
  };
}

function createBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-canonical-rework-gate-"));
  tempDirs.add(basePath);
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Rework gate",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage result** `est:10m`",
    "  - Do: Stage executor output",
    "  - Verify: npm test",
    "",
  ].join("\n"));
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Rework gate', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Rework seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Stage result', 'in_progress', 'npm test', 1);
  `);
  return basePath;
}

function claimCanonicalAttempt(basePath: string): string {
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-12T00:00:00.000Z', 'test',
      '2026-07-12T00:00:00.000Z', 'active', '${basePath.replaceAll("'", "''")}'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-12T00:00:00.000Z',
      '2099-07-12T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-claim', 'turn-claim', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return claim.attemptId;
}

function seedPendingBlockingFindings(findingIds: string[] = ["F1"]): void {
  saveReworkBrief({
    briefId: "RB-001",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    findings: findingIds.map((findingId) => ({
      findingId,
      severity: "blocking" as const,
      description: "Compile regression",
      requiredFix: "Fix compile error",
      verificationCommands: ["pnpm run typecheck:extensions"],
    })),
  });
}

function findingRow(): Record<string, unknown> {
  return db().prepare(
    "SELECT status, evidence, decision_ref FROM rework_brief_findings WHERE brief_id = 'RB-001' AND finding_id = 'F1'",
  ).get() ?? {};
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("canonical completion rejects unresolved blocking rework findings when reworkResolution is empty", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-empty"));

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /unresolved blocking rework finding/i);
  assert.match(String(result.content[0]?.text), /F1/);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
  assert.equal(getUnresolvedBlockingReworkFindingsForTask("M001", "S01", "T01").length, 1);
});

test("canonical completion applies a satisfying rework resolution while staging", async () => {
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [{
      findingId: "F1",
      status: "resolved",
      evidence: "Fixed compile error and reran pnpm run typecheck:extensions.",
    }],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-resolved"));

  assert.equal(result.isError, undefined);
  assert.match(String(result.content[0]?.text), /awaiting host verification/i);
  assert.equal((result.details as Record<string, unknown>).attemptId, attemptId);
  assert.deepEqual(getUnresolvedBlockingReworkFindingsForTask("M001", "S01", "T01"), []);
  assert.deepEqual(findingRow(), {
    status: "resolved",
    evidence: "Fixed compile error and reran pnpm run typecheck:extensions.",
    decision_ref: "",
  });
});

test("canonical completion rejects a rework resolution with empty evidence", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [{
      findingId: "F1",
      status: "resolved",
      evidence: "",
    }],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-no-evidence"));

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /unresolved blocking rework finding/i);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(findingRow().status, "pending");
});

test("canonical completion applies a deferred-with-override rework resolution with evidence and decisionRef", async () => {
  const basePath = createBase();
  const attemptId = claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [{
      findingId: "F1",
      status: "deferred-with-override",
      evidence: "Maintainer accepted temporary deferral.",
      decisionRef: "DEC-2026-07-07-rework-deferral",
    }],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-deferred"));

  assert.equal(result.isError, undefined);
  assert.match(String(result.content[0]?.text), /awaiting host verification/i);
  assert.equal((result.details as Record<string, unknown>).attemptId, attemptId);
  assert.deepEqual(getUnresolvedBlockingReworkFindingsForTask("M001", "S01", "T01"), []);
  assert.deepEqual(findingRow(), {
    status: "deferred-with-override",
    evidence: "Maintainer accepted temporary deferral.",
    decision_ref: "DEC-2026-07-07-rework-deferral",
  });
});

test("canonical completion rejects a deferred-with-override rework resolution with whitespace-only decisionRef", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [{
      findingId: "F1",
      status: "deferred-with-override",
      evidence: "Maintainer accepted temporary deferral.",
      decisionRef: "   ",
    }],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-blank-decision-ref"));

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /unresolved blocking rework finding/i);
  assert.match(String(result.content[0]?.text), /F1/);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(findingRow().status, "pending");
});

test("canonical completion rejects a pending blocking finding when reworkResolution is omitted", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings();

  const result = await executeTaskComplete(
    completionParams() as never,
    basePath,
    invocation("pi:gsd_task_complete:rework-omitted"),
  );

  assert.equal(result.isError, true);
  assert.match(String(result.content[0]?.text), /unresolved blocking rework finding/i);
  assert.match(String(result.content[0]?.text), /F1/);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.equal(getUnresolvedBlockingReworkFindingsForTask("M001", "S01", "T01").length, 1);
});

test("canonical completion names the uncovered finding when only some blocking findings are resolved", async () => {
  const basePath = createBase();
  claimCanonicalAttempt(basePath);
  seedPendingBlockingFindings(["F1", "F2"]);

  const result = await executeTaskComplete({
    ...completionParams(),
    reworkResolution: [{
      findingId: "F1",
      status: "resolved",
      evidence: "Fixed compile error and reran pnpm run typecheck:extensions.",
    }],
  } as never, basePath, invocation("pi:gsd_task_complete:rework-partial"));

  assert.equal(result.isError, true);
  const text = String(result.content[0]?.text);
  assert.match(text, /unresolved blocking rework finding/i);
  assert.match(text, /F2/);
  assert.doesNotMatch(text, /F1/);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count, 0);
  assert.deepEqual(findingRow().status, "pending");
});
