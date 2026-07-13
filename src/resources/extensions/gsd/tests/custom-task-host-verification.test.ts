// Project/App: gsd-pi
// File Purpose: Real-database integration contract for custom-engine Task host verification.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { publishVerifiedTaskExecution } from "../auto/task-execution-cutover.js";
import { runCustomEngineHostVerification } from "../auto/custom-task-host-verification.js";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.js";
import { publishVerifiedTaskCompletion, stageTaskCompletion } from "../task-completion-compatibility-adapter.js";
import { claimTaskAttempt, readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "../task-verification-domain-operation.js";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "custom-engine-test",
  };
}

function createFixture(): { basePath: string; attemptId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-custom-host-verification-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: basePath });
  writeFileSync(join(basePath, "tracked.ts"), "export const verified = true;\n");
  execFileSync("git", ["add", "tracked.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: basePath });

  const phaseDir = join(basePath, ".gsd", "phases", "01-custom");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "01-01-PLAN.md"), [
    "# S01: Custom engine",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Verify custom execution** `est:30m`",
    "  - Do: Complete through the custom engine",
    "  - Verify: custom policy",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Custom engine', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Host verification', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, verify, sequence)
    VALUES ('M001', 'S01', 'T01', 'Verify custom execution', 'in_progress', 'custom policy', 1);
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
      'trace-1', 'turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const claim = claimTaskAttempt({
    invocation: invocation("custom/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(row("SELECT id FROM unit_dispatches").id),
  });
  return { basePath, attemptId: claim.attemptId };
}

async function stage(basePath: string): Promise<void> {
  await stageTaskCompletion({
    invocation: invocation("custom/stage"),
    basePath,
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    completion: {
      oneLiner: "Custom execution completed",
      narrative: "Candidate Result awaits host verification.",
      verification: "Custom policy owns verification.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["tracked.ts"],
      keyDecisions: ["Persist host verdict before publication."],
      blockerDiscovered: false,
      verificationEvidence: [],
    },
  });
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("custom execute-task persists host verdict and source proof before publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);
  let policyCalls = 0;

  const verified = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => { policyCalls++; return "continue"; },
  });
  await publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  }, { readLatestTaskAttempt, publishVerifiedTaskCompletion });

  const verdict = readTaskTechnicalVerdict(attemptId);
  assert.equal(verified, "continue");
  assert.equal(policyCalls, 1);
  assert.equal(verdict?.verdict, "pass");
  assert.match(verdict?.testedSourceRevision ?? "", /^sha256:/);
  assert.equal(row("SELECT observation FROM workflow_verification_evidence").observation, "passed");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "settled");
});

test("custom policy retry records a failed verdict and prevents publication", async () => {
  const { basePath, attemptId } = createFixture();
  await stage(basePath);

  const verified = await runCustomEngineHostVerification({
    unitType: "execute-task",
    basePath,
    unitId: "M001/S01/T01",
    verifyPolicy: async () => "retry",
  });

  assert.equal(verified, "retry");
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verdict, "fail");
  assert.equal(readLatestTaskAttempt({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.nextStage, "route");
  await assert.rejects(publishVerifiedTaskExecution({
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    workerId: "worker-1",
    traceId: "trace-1",
    turnId: "turn-1",
    basePath,
  }, { readLatestTaskAttempt, publishVerifiedTaskCompletion }), /verify stage|succeeded Attempt/i);
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "in_progress");
});
