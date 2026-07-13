// Project/App: gsd-pi
// File Purpose: Executable contract for staged Task completion and verified legacy publication.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _setDomainOperationFaultForTest } from "../db/domain-operation.js";
import { clearParseCache } from "../files.js";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { claimTaskAttempt } from "../task-execution-domain-operation.js";
import type { ExecutionInvocation } from "../execution-invocation.js";

interface TaskIdentity {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface StageTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskIdentity;
  completion: {
    oneLiner: string;
    narrative: string;
    verification: string;
    deviations: string;
    knownIssues: string;
    keyFiles: string[];
    keyDecisions: string[];
    blockerDiscovered: boolean;
    verificationEvidence: Array<{
      command: string;
      exitCode: number;
      verdict: string;
      durationMs: number;
    }>;
  };
}

interface PublishVerifiedTaskCompletionInput {
  invocation: ExecutionInvocation;
  basePath: string;
  task: TaskIdentity;
  attemptId: string;
}

interface StagedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  resultId: string;
  summaryPath: string;
}

interface PublishedTaskCompletionReceipt {
  status: "committed" | "replayed";
  attemptId: string;
  summaryPath: string;
}

interface TaskCompletionCompatibilityAdapter {
  stageTaskCompletion(input: StageTaskCompletionInput): Promise<StagedTaskCompletionReceipt>;
  publishVerifiedTaskCompletion(input: PublishVerifiedTaskCompletionInput): Promise<PublishedTaskCompletionReceipt>;
}

const TASK: TaskIdentity = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };
const tempDirs = new Set<string>();

async function subject(): Promise<TaskCompletionCompatibilityAdapter> {
  return import("../task-completion-compatibility-adapter.js") as Promise<TaskCompletionCompatibilityAdapter>;
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`).count ?? 0);
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "task-completion-test",
    traceId: key,
    turnId: "turn-task-completion",
  };
}

function createFixture(): { basePath: string; planPath: string; attemptId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-task-completion-adapter-"));
  tempDirs.add(basePath);
  const phaseDir = join(basePath, ".gsd", "phases", "01-test");
  mkdirSync(phaseDir, { recursive: true });
  const planPath = join(phaseDir, "01-01-PLAN.md");
  writeFileSync(planPath, [
    "# S01: Compatibility adapter",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Stage completion** `est:30m`",
    "  - Do: Keep legacy status open until host verification",
    "  - Verify: npm test",
    "",
  ].join("\n"));

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Compatibility adapter', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Completion seam', 'active', '2026-07-12T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, verify, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Stage completion', 'in_progress', 'npm test', 1
    );
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
      'trace-dispatch-1', 'turn-dispatch-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-12T00:00:00.000Z'
    );
  `);
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("task-completion/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { basePath, planPath, attemptId: claim.attemptId };
}

function stageInput(basePath: string): StageTaskCompletionInput {
  return {
    invocation: invocation("task-completion/stage"),
    basePath,
    task: TASK,
    completion: {
      oneLiner: "Implemented the compatibility seam",
      narrative: "The executor produced a candidate result for host verification.",
      verification: "Agent reported npm test passed; host verification is still required.",
      deviations: "None.",
      knownIssues: "None.",
      keyFiles: ["src/task.ts"],
      keyDecisions: ["Keep dependency unlock behind host verification."],
      blockerDiscovered: false,
      verificationEvidence: [{
        command: "npm test",
        exitCode: 0,
        verdict: "pass",
        durationMs: 25,
      }],
    },
  };
}

function publishInput(basePath: string, attemptId: string): PublishVerifiedTaskCompletionInput {
  return {
    invocation: invocation("task-completion/publish"),
    basePath,
    task: TASK,
    attemptId,
  };
}

function taskState(): Record<string, unknown> {
  return row(`
    SELECT status, completed_at, one_liner, narrative, full_summary_md
    FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `);
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  clearPathCache();
  clearParseCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("staging settles the canonical Attempt but leaves legacy completion and its checkbox pending", async () => {
  const { stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();

  const staged = await stageTaskCompletion(stageInput(basePath));

  assert.equal(staged.status, "committed");
  assert.equal(staged.attemptId, attemptId);
  assert.deepEqual(row(`
    SELECT attempt_id, outcome, operation_id
    FROM workflow_attempt_results
  `), {
    attempt_id: attemptId,
    outcome: "succeeded",
    operation_id: row("SELECT settle_operation_id FROM workflow_execution_attempts").settle_operation_id,
  });
  const stagedTask = taskState();
  assert.equal(stagedTask.status, "in_progress");
  assert.equal(stagedTask.completed_at, null);
  assert.equal(stagedTask.one_liner, "Implemented the compatibility seam");
  assert.equal(stagedTask.narrative, "The executor produced a candidate result for host verification.");
  assert.match(String(stagedTask.full_summary_md), /Implemented the compatibility seam/);
  assert.equal(existsSync(staged.summaryPath), true);
  assert.match(readFileSync(staged.summaryPath, "utf8"), /host verification is still required/i);
  assert.match(readFileSync(planPath, "utf8"), /\[ \][^\n]*\*\*T01/);
  assert.equal(count("verification_evidence"), 1);
});

test("a summary projection failure leaves the immutable Result and staged legacy state intact for replay repair", async (t) => {
  const { stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  const originalRename = fsPromises.rename.bind(fsPromises);
  t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof fsPromises.rename>) => {
    if (String(args[1]).endsWith("SUMMARY.md")) {
      throw new Error("simulated summary projection failure");
    }
    return originalRename(...args);
  });

  await assert.rejects(stageTaskCompletion(stageInput(basePath)), /projection|summary/i);

  assert.deepEqual(row("SELECT attempt_state, settle_outcome FROM workflow_execution_attempts"), {
    attempt_state: "settled",
    settle_outcome: "succeeded",
  });
  assert.deepEqual(row("SELECT attempt_id, outcome FROM workflow_attempt_results"), {
    attempt_id: attemptId,
    outcome: "succeeded",
  });
  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(count("verification_evidence"), 1);

  t.mock.restoreAll();
  const replayed = await stageTaskCompletion(stageInput(basePath));
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.attemptId, attemptId);
  assert.equal(existsSync(replayed.summaryPath), true);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(count("verification_evidence"), 1);
  assert.equal(taskState().status, "in_progress");
});

test("verified publication alone completes the legacy Task and checks its projection", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));

  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.equal(published.status, "committed");
  assert.equal(published.attemptId, attemptId);
  assert.equal(published.summaryPath, staged.summaryPath);
  assert.equal(taskState().status, "complete");
  assert.match(String(taskState().completed_at), /\S/);
  assert.match(readFileSync(planPath, "utf8"), /\[x\][^\n]*\*\*T01/);
  assert.equal(count("workflow_attempt_results"), 1);
  assert.equal(row("SELECT outcome FROM workflow_attempt_results").outcome, "succeeded");
  assert.equal(
    row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status,
    "completed",
  );
  assert.deepEqual(
    db().prepare(`
      SELECT sequence, next_stage
      FROM workflow_kernel_checkpoints
      ORDER BY sequence
    `).all(),
    [
      { sequence: 1, next_stage: "execute" },
      { sequence: 2, next_stage: "verify" },
      { sequence: 3, next_stage: "route" },
      { sequence: 4, next_stage: "closeout" },
      { sequence: 5, next_stage: "settled" },
    ],
  );
});

test("a publish fault rolls canonical closeout and legacy completion back together", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, attemptId } = createFixture();
  await stageTaskCompletion(stageInput(basePath));
  _setDomainOperationFaultForTest("after-mutation");

  await assert.rejects(
    publishVerifiedTaskCompletion(publishInput(basePath, attemptId)),
    /domain operation fault/i,
  );

  assert.equal(taskState().status, "in_progress");
  assert.equal(taskState().completed_at, null);
  assert.equal(
    row("SELECT lifecycle_status FROM workflow_item_lifecycles").lifecycle_status,
    "in_progress",
  );
  assert.deepEqual(
    db().prepare("SELECT sequence, next_stage FROM workflow_kernel_checkpoints ORDER BY sequence").all()
      .map((checkpoint) => ({ ...checkpoint })),
    [
      { sequence: 1, next_stage: "execute" },
      { sequence: 2, next_stage: "verify" },
    ],
  );

  _setDomainOperationFaultForTest(null);
  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  assert.equal(published.status, "committed");
  assert.equal(taskState().status, "complete");
});

test("exact stage and publication replay repair projections without duplicate facts", async () => {
  const { publishVerifiedTaskCompletion, stageTaskCompletion } = await subject();
  const { basePath, planPath, attemptId } = createFixture();
  const staged = await stageTaskCompletion(stageInput(basePath));
  const published = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));
  const beforeReplay = {
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    results: count("workflow_attempt_results"),
    evidence: count("verification_evidence"),
    task: taskState(),
    summary: readFileSync(staged.summaryPath, "utf8"),
    plan: readFileSync(planPath, "utf8"),
  };
  unlinkSync(staged.summaryPath);
  unlinkSync(planPath);

  const stagedReplay = await stageTaskCompletion(stageInput(basePath));
  const publishedReplay = await publishVerifiedTaskCompletion(publishInput(basePath, attemptId));

  assert.deepEqual(stagedReplay, { ...staged, status: "replayed" });
  assert.deepEqual(publishedReplay, { ...published, status: "replayed" });
  assert.deepEqual({
    revision: row("SELECT revision FROM project_authority").revision,
    operations: count("workflow_operations"),
    results: count("workflow_attempt_results"),
    evidence: count("verification_evidence"),
    task: taskState(),
    summary: readFileSync(staged.summaryPath, "utf8"),
    plan: readFileSync(planPath, "utf8"),
  }, beforeReplay);
});
