/**
 * Live workflow: three dependent slices, five tasks, real agent, FULL
 * `gsd headless auto` to milestone completion.
 *
 * Seeds S01 → S02 → S03 (see seedMultiSliceMilestone) and runs the whole auto
 * loop headlessly with a real model: every execute-task, every
 * complete-slice, and the milestone closeout. It proves the loop reaches the
 * fixed point a user expects — not just that one agent turn did work.
 *
 * Proof is durable only — never agent prose: exit code, each task's own
 * verification command, git history, milestone/slice/task rows in gsd.db
 * (including slice completion order), and the absence of liveness/wedge/
 * pause/error lines on the child's stderr.
 *
 * Exit: 0 pass · 77 skip (no creds) · non-zero fail.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { stripAnsi } from "../e2e/_shared/index.ts";
import { type FixtureSlice, runVerification, seedMultiSliceMilestone } from "./harness.ts";
import { runLiveWorkflowScenario } from "./scenario.ts";

// Authority: a manual single-task auto run on 2026-08-23 took ~275s
// (kimi-for-coding); five tasks plus closeout need room. Override with
// GSD_LIVE_WORKFLOW_TIMEOUT_MS.
const AUTO_TIMEOUT_MS = 1_800_000;
// Only the child's stderr is scanned: that is where gsd's operator
// notifications (liveness, wedge, pause, provider errors) land. Fixture test
// output from the agent's tool calls goes to stdout and is not scanned.
const STDERR_FAILURE_RE = /liveness|wedge|Cannot dispatch|paused|error/i;

let slices: FixtureSlice[] = [];

const result = await runLiveWorkflowScenario({
  slug: "live-multi-slice-auto",
  seed: (project) => {
    const seed = seedMultiSliceMilestone(project);
    slices = seed.slices;
    return seed;
  },
  dispatch: { command: "auto", timeoutMs: AUTO_TIMEOUT_MS },
  expect: { commits: "increased" },
});

try {
  const badLines = stripAnsi(result.stderr).split("\n").filter((line) => STDERR_FAILURE_RE.test(line));
  assert.equal(badLines.length, 0, `auto reported liveness/wedge/pause/error lines on stderr:\n${badLines.join("\n")}`);

  const taskCount = slices.reduce((n, s) => n + s.tasks.length, 0);
  assert.ok(
    result.commitsAfter - result.commitsBefore >= taskCount,
    `expected at least ${taskCount} new commits (one per task), got ${result.commitsAfter - result.commitsBefore}`,
  );

  for (const slice of slices) {
    for (const task of slice.tasks) {
      const verify = runVerification(result.project, task.verifyArgv);
      assert.ok(verify.ok, `${slice.id}/${task.id} verification fails:\n${verify.output}`);
    }
  }

  const db = new DatabaseSync(join(result.project.dir, ".gsd", "gsd.db"), { readOnly: true });
  try {
    const milestone = db.prepare("SELECT status FROM milestones WHERE id = 'M001'").get() as { status?: string } | undefined;
    assert.equal(milestone?.status, "complete", "M001 not complete");

    const sliceRows = db
      .prepare("SELECT id, status, completed_at FROM slices WHERE milestone_id = 'M001' ORDER BY id")
      .all() as { id: string; status: string; completed_at: string | null }[];
    assert.deepEqual(
      sliceRows.map((r) => [r.id, r.status]),
      slices.map((s) => [s.id, "complete"]),
      "every seeded slice should be complete",
    );
    for (let i = 1; i < sliceRows.length; i++) {
      const prev = sliceRows[i - 1];
      const cur = sliceRows[i];
      assert.ok(prev.completed_at && cur.completed_at, `${prev.id}/${cur.id} missing completed_at`);
      assert.ok(
        prev.completed_at <= cur.completed_at,
        `${cur.id} (depends on ${prev.id}) completed at ${cur.completed_at}, before ${prev.id} at ${prev.completed_at}`,
      );
    }

    const taskRows = db
      .prepare("SELECT slice_id, id, status FROM tasks WHERE milestone_id = 'M001' ORDER BY slice_id, id")
      .all() as { slice_id: string; id: string; status: string }[];
    assert.deepEqual(
      taskRows.map((r) => [r.slice_id, r.id, r.status]),
      slices.flatMap((s) => s.tasks.map((t) => [s.id, t.id, "complete"])),
      "every seeded task should be complete",
    );
  } finally {
    db.close();
  }
  console.log(
    `PASS: live agent ran auto to milestone completion (M001, ${slices.length} slices, ${taskCount} tasks complete in dependency order).`,
  );
} finally {
  result.project.cleanup();
}
