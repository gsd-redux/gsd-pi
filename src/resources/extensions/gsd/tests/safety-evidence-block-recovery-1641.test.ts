// Project/App: gsd-pi
// File Purpose: Regression for #1641 / #1649 — a blocking safety evidence
// cross-reference mismatch must carry its sanctioned exit: the Task Attempt is
// settled/routed through the canonical recovery seam (recovery action minted),
// the pause notification surfaces the recoveryActionId + resume instruction,
// and the finalize break reason never routes into the verified-task
// publication boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  postUnitPreVerification,
  resolveEvidenceRoutePresentation,
  type PostUnitContext,
} from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { decideFinalizeResult } from "../auto/workflow-kernel.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  openDatabase,
} from "../gsd-db.ts";
import { recordToolCall, recordToolResult, resetEvidence } from "../safety/evidence-collector.ts";
import {
  claimTaskAttempt,
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { readTaskRecoveryRoute, recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.ts";
import { routeEvidenceCrossReferenceBlock } from "../auto-verification.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" } as const;

function settleCanonicalTaskForHostVerification(basePath: string): string {
  const db = _getAdapter();
  assert.ok(db, "DB should be open before claiming canonical task authority");
  const now = "2026-08-08T00:00:00.000Z";
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES ('evidence-worker', 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(now, now, basePath);
  db.prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES ('M001', 'evidence-worker', 7, ?, '2099-08-08T00:00:00.000Z', 'held')
  `).run(now);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'evidence-trace', 'evidence-turn', 'evidence-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, ?
    )
  `).run(now) as { lastInsertRowid: number | bigint };
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-block-1641:claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    task: { ...TASK },
    workerId: "evidence-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
  settleTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-block-1641:settle",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Executor result is ready for host evidence verification.",
    output: { verification: "npm test" },
  });
  return claim.attemptId;
}

test("blocking evidence-xref settles and routes the Attempt with a surfaced recoveryActionId (#1641/#1649)", async () => {
  const base = makeTempRepo("gsd-evidence-block-1641-");

  try {
    writeFileSync(join(base, ".gitignore"), ".gsd/\n");
    git(base, "add", ".gitignore");
    git(base, "commit", "-m", "chore: ignore gsd runtime");

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Add app entrypoint",
      status: "complete",
      oneLiner: "Added app entrypoint",
      keyFiles: ["app.js"],
      planning: {
        description: "Create app entrypoint",
        estimate: "small",
        files: ["app.js"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["app.js"],
        observabilityImpact: "none",
      },
    });
    insertVerificationEvidence({
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      command: "npm test",
      exitCode: 0,
      verdict: "passed",
      durationMs: 10,
    });
    const attemptId = settleCanonicalTaskForHostVerification(base);
    assert.equal(
      isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
      true,
      "fixture Attempt must start in the awaiting-verification state",
    );

    writeFileSync(join(base, "app.js"), "console.log('ready');\n");
    resetEvidence();
    recordToolCall("call-1", "bash", { command: "npm test" });
    recordToolResult("call-1", "bash", "Command exited with code 1\nfailed\n", true);

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: { notify: (message: string) => notifications.push(message) },
      } as unknown as PostUnitContext["ctx"],
      pi: {} as PostUnitContext["pi"],
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {},
    };

    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true,
    });

    // The blocking branch returns the dedicated evidence-xref-blocked signal and pauses.
    assert.equal(result, "evidence-xref-blocked");
    assert.equal(pauseCalled, true);

    // The withheld verdict is durably recorded and the Attempt is routed out of
    // the awaiting-verification wedge — a resume no longer replays the
    // identical finalize sequence.
    const verdict = readTaskTechnicalVerdict(attemptId);
    assert.ok(verdict, "a host Technical Verdict must be recorded");
    assert.equal(verdict.verdict, "fail");
    assert.equal(
      isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
      false,
      "the Attempt must leave the awaiting-verification state",
    );

    // The recovery action row exists — the sanctioned exit was minted.
    const route = readTaskRecoveryRoute(attemptId);
    assert.ok(route, "a recovery route must exist for the blocked Attempt");
    assert.ok(route.recoveryActionId.length > 0, "recoveryActionId must be minted");
    assert.equal(route.recoveryOwner, "agent");
    assert.deepEqual(s.lastSafetyBlockRecovery, {
      recoveryActionId: route.recoveryActionId,
      resumeInstruction: 'resume with /gsd auto to re-run the task',
    });

    // The pause notification carries the recoveryActionId and a resume
    // instruction, so the first pause already contains its sanctioned exit.
    const blockingNotification = notifications.find((message) =>
      message.includes("claimed passing verification"),
    );
    assert.ok(blockingNotification, `expected evidence-xref notification, got: ${notifications.join("\n")}`);
    assert.ok(
      blockingNotification.includes(route.recoveryActionId),
      `notification must surface the recoveryActionId: ${blockingNotification}`,
    );
    assert.match(blockingNotification, /resume with (\/gsd auto|gsd_task_recovery_resume)/);
    // The offending mismatch is surfaced (claimed vs recorded exit code).
    assert.match(blockingNotification, /Claimed exitCode=0 but actual exitCode=1/);

    // Finalize maps "evidence-xref-blocked" to a break reason that is NOT
    // complete-and-break, so the loop stops before the verified-task
    // publication boundary — the "Verified Task publication requires a passing
    // host Technical Verdict" throw is unreachable on this path.
    const safetyReason = `safety-evidence-block (recoveryActionId: ${route.recoveryActionId}; resume with /gsd auto to re-run the task)`;
    const decision = decideFinalizeResult({ action: "break", reason: safetyReason });
    assert.equal(decision.action, "stop");
  } finally {
    resetEvidence();
    closeDatabase();
    cleanup(base);
  }
});

test("evidence routing failure surfaces a supported retry instruction", (t) => {
  const base = makeTempRepo("gsd-evidence-route-rollback-");
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  const attemptId = settleCanonicalTaskForHostVerification(base);
  const attempt = readLatestTaskAttempt({ ...TASK });
  assert.ok(attempt);

  assert.throws(() => routeEvidenceCrossReferenceBlock({
    attempt: attempt!,
    basePath: base,
    mismatch: {
      command: "npm test",
      claimedExitCode: 0,
      actualExitCode: 1,
      reason: "Claimed exitCode=0 but actual exitCode=1",
    },
    taskAuthority: {
      readLatestTaskAttempt,
      readTaskTechnicalVerdict,
      recordTaskTechnicalVerdict,
      invalidateTaskTechnicalPass,
      routeTaskFailure: ((..._args: Parameters<typeof recordFailureAndSelectRecovery>) => {
        throw new Error("injected route failure");
      }) as typeof recordFailureAndSelectRecovery,
    },
  }), /injected route failure/);

  const verdict = readTaskTechnicalVerdict(attemptId);
  assert.ok(verdict, "the failing verdict remains durable when routing fails");
  assert.equal(
    isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
    false,
    "the persisted failing verdict must advance the Attempt out of verification",
  );
  const presentation = resolveEvidenceRoutePresentation(null, "injected route failure");
  assert.deepEqual(presentation.recovery, {
    resumeInstruction: "resume with /gsd auto to retry evidence recovery routing",
  });
  assert.match(presentation.exitInstruction, /injected route failure/);
  assert.match(presentation.exitInstruction, /resume with \/gsd auto/);
});
