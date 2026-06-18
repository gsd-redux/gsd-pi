// Project/App: gsd-pi
// File Purpose: Regression tests for source-write worktree safety phase behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutoSession } from "../auto/session.ts";
import { validateSourceWriteWorktreeSafety } from "../auto/worktree-safety-phase.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, getMilestoneLease, releaseMilestoneLease } from "../db/milestone-leases.ts";

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("source-write safety reclaims a released milestone lease for resumed branch sessions", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-reclaim-"));
  const previousCwd = process.cwd();
  const notifications: string[] = [];
  const stopReasons: string[] = [];

  try {
    mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
    runGit(["init", "-b", "auto/M001"], projectRoot);
    runGit(["config", "user.email", "test@example.com"], projectRoot);
    runGit(["config", "user.name", "Test User"], projectRoot);
    process.chdir(projectRoot);

    openDatabase(join(projectRoot, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone 1", status: "active" });

    const priorWorkerId = registerAutoWorker({ projectRootRealpath: projectRoot });
    const priorLease = claimMilestoneLease(priorWorkerId, "M001");
    assert.equal(priorLease.ok, true);
    if (!priorLease.ok) return;
    assert.equal(releaseMilestoneLease(priorWorkerId, "M001", priorLease.token), true);

    const resumedWorkerId = registerAutoWorker({ projectRootRealpath: projectRoot });
    const session = new AutoSession();
    session.basePath = projectRoot;
    session.originalBasePath = projectRoot;
    session.currentMilestoneId = null;
    session.workerId = resumedWorkerId;
    session.milestoneLeaseToken = null;

    const result = await validateSourceWriteWorktreeSafety(
      {
        ctx: {
          ui: {
            notify(message: string) {
              notifications.push(message);
            },
          },
        },
        pi: {},
        s: session,
        deps: {
          getIsolationMode: () => "branch",
          autoWorktreeBranch: () => "auto/M001",
          stopAuto: async (_ctx: unknown, _pi: unknown, reason?: string) => {
            if (reason) stopReasons.push(reason);
          },
        },
        prefs: undefined,
        iteration: 1,
        flowId: "flow-1",
        nextSeq: () => 1,
      } as any,
      "execute-task",
      "M001/S01/T01",
      "M001",
      "resume-pre-dispatch",
    );

    assert.equal(result, null);
    assert.equal(session.currentMilestoneId, "M001");
    assert.equal(session.milestoneLeaseToken, priorLease.token + 1);
    const lease = getMilestoneLease("M001");
    assert.equal(lease?.worker_id, resumedWorkerId);
    assert.equal(lease?.status, "held");
    assert.equal(stopReasons.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    try {
      closeDatabase();
    } catch {
      /* noop */
    }
    process.chdir(previousCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
