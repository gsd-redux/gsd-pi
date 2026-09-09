// Project/App: gsd-pi
// File Purpose: `/gsd rebuild markdown` selects the invocation-cwd projection root (#2232).
//
// Invoked from an active milestone worktree, the rebuild route must repair the
// worktree-local projection (quarantining stale completion summaries/plans
// there) while the already-open project-scoped DB stays authoritative. Invoked
// at the project root, the root projection is repaired as before. Rebuild must
// never mutate DB rows (task, attempts, verification evidence).

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleOpsCommand } from "../commands/handlers/ops.ts";
import { withCommandCwd } from "../commands/context.ts";
import {
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  openDatabase,
} from "../gsd-db.ts";
import { getCurrentProjectStateVersion } from "../markdown-renderer.ts";
import { getDb } from "../db/engine.ts";
import { invalidateStateCache } from "../state.ts";

type Layout = "legacy" | "flat";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function projectionSummaryPath(base: string, layout: Layout): string {
  return layout === "legacy"
    ? join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md")
    : join(base, ".gsd", "phases", "01-m001", "S01-T01-SUMMARY.md");
}

function projectionPlanPath(base: string, layout: Layout): string {
  return layout === "legacy"
    ? join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md")
    : join(base, ".gsd", "phases", "01-m001", "01-01-PLAN.md");
}

// One settled-chain attempt row (workflow_operations → workflow_item_lifecycles
// → workflow_execution_attempts) so the unchanged-DB assertions cover real
// attempt bookkeeping, not empty tables.
function seedAttemptRow(): void {
  const db = getDb();
  const authority = db.prepare(
    "SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1",
  ).get() as { project_id: string; revision: number; authority_epoch: number };
  const revision = Number(authority.revision) + 1;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_operations (
       operation_id, project_id, operation_type, idempotency_key,
       expected_revision, resulting_revision,
       expected_authority_epoch, resulting_authority_epoch,
       actor_type, source_transport, request_hash, created_at
     ) VALUES (
       :op, :pid, 'test', 'rebuild-routing-1',
       :expected, :resulting,
       :epoch, :epoch,
       'system', 'test', 'rebuild-routing', :now
     )`,
  ).run({
    ":op": "op-rebuild-routing-1",
    ":pid": authority.project_id,
    ":expected": Number(authority.revision),
    ":resulting": revision,
    ":epoch": Number(authority.authority_epoch),
    ":now": now,
  });
  db.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
       lifecycle_status, created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES (
       'M001/S01/T01', :pid, 'task', 'M001', 'S01', 'T01',
       'ready', :now, :now,
       :op, :resulting, :epoch
     )`,
  ).run({
    ":pid": authority.project_id,
    ":now": now,
    ":op": "op-rebuild-routing-1",
    ":resulting": revision,
    ":epoch": Number(authority.authority_epoch),
  });
  db.prepare(
    `INSERT INTO workflow_execution_attempts (
       attempt_id, project_id, lifecycle_id, attempt_number, attempt_state,
       claimed_at, claim_operation_id, claim_project_revision, claim_authority_epoch
     ) VALUES (
       'attempt-rebuild-routing-1', :pid, 'M001/S01/T01', 1, 'claimed',
       :now, :op, :resulting, :epoch
     )`,
  ).run({
    ":pid": authority.project_id,
    ":now": now,
    ":op": "op-rebuild-routing-1",
    ":resulting": revision,
    ":epoch": Number(authority.authority_epoch),
  });
}

function workflowSnapshot(): Record<string, unknown> {
  const db = getDb();
  return {
    attempts: db.prepare("SELECT * FROM workflow_execution_attempts ORDER BY attempt_id").all(),
    evidence: db.prepare("SELECT * FROM verification_evidence ORDER BY id").all(),
  };
}

// <root> hosts the canonical project DB; `.gsd-worktrees/M001` is the active
// milestone worktree with its own `.gsd/` projections and no DB of its own.
// The task's completion was legitimately reopened in the DB (back to pending,
// no summary) unless the caller seeds a canonical DB summary instead.
function makeFixture(
  layout: Layout,
  opts: { dbSummary?: string } = {},
): {
  root: string;
  worktree: string;
  summaryPathFor: (base: string) => string;
  planPathFor: (base: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "gsd-rebuild-wt-"));
  tempDirs.add(root);
  const worktree = join(root, ".gsd-worktrees", "M001");
  mkdirSync(join(root, ".gsd"), { recursive: true });
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  openDatabase(join(root, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "in_progress",
    risk: "low",
    depends: [],
  });
  if (opts.dbSummary !== undefined) {
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "complete",
      oneLiner: "Task complete",
      narrative: "Completed through the DB.",
      verificationResult: "passed",
      fullSummaryMd: opts.dbSummary,
    });
  } else {
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Task",
      status: "pending",
    });
  }
  insertVerificationEvidence({
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    command: "npm test",
    exitCode: 0,
    verdict: "pass",
    durationMs: 12,
  });
  seedAttemptRow();
  return {
    root,
    worktree,
    summaryPathFor: (base: string) => projectionSummaryPath(base, layout),
    planPathFor: (base: string) => projectionPlanPath(base, layout),
  };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function makeCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
  };
}

const mockPi = {
  registerCommand() {},
  registerTool() {},
  registerShortcut() {},
  on() {},
  sendMessage() {},
};

const STALE_SUMMARY = "# T01 Summary\n\nDisk-only completion from before the reopen.\n";
const STALE_PLAN = "# S01 Plan\n\n- [x] T01 Task (stale completion state on disk)\n";

function seedStaleProjections(fx: ReturnType<typeof makeFixture>, bases: string[]): void {
  for (const base of bases) {
    const summaryPath = fx.summaryPathFor(base);
    mkdirSync(join(summaryPath, ".."), { recursive: true });
    writeFileSync(summaryPath, STALE_SUMMARY, "utf-8");
    const planPath = fx.planPathFor(base);
    mkdirSync(join(planPath, ".."), { recursive: true });
    writeFileSync(planPath, STALE_PLAN, "utf-8");
  }
}

function quarantineContents(base: string): string[] {
  return listFiles(join(base, ".gsd", "quarantine", "projections"))
    .map((path) => readFileSync(path, "utf-8"));
}

// The selected root receives the full stale-projection treatment: the stale
// completion SUMMARY is quarantined (not re-imported), the stale PLAN is
// quarantined and re-rendered from DB authority, and the other root's seeded
// files stay byte-identical.
function assertRebuildRepairsSelectedRoot(
  selected: string,
  other: string,
  fx: ReturnType<typeof makeFixture>,
): void {
  assert.equal(existsSync(fx.summaryPathFor(selected)), false, "stale completion SUMMARY must be moved aside at the selected projection root");
  const planBytes = readFileSync(fx.planPathFor(selected), "utf-8");
  assert.notEqual(planBytes, STALE_PLAN, "stale PLAN must be re-rendered from DB authority");
  assert.match(planBytes, /gsd:state-version=/, "re-rendered PLAN carries the state-version stamp");
  assert.deepEqual(
    new Set(quarantineContents(selected)),
    new Set([STALE_SUMMARY, STALE_PLAN]),
    "both stale files are preserved byte-exact in quarantine",
  );

  // The other projection root is not the rebuild target: seeded stale files
  // stay byte-unchanged and nothing is quarantined there.
  const otherSummary = fx.summaryPathFor(other);
  if (existsSync(otherSummary)) {
    assert.equal(readFileSync(otherSummary, "utf-8"), STALE_SUMMARY);
    assert.equal(readFileSync(fx.planPathFor(other), "utf-8"), STALE_PLAN);
  } else {
    assert.equal(existsSync(fx.planPathFor(other)), false);
  }
  assert.equal(existsSync(join(other, ".gsd", "quarantine", "projections")), false);
}

function assertReopenedTaskRowsUntouched(before: Record<string, unknown>): void {
  const task = getTask("M001", "S01", "T01");
  assert.equal(task?.status, "pending", "DB task status remains authoritative");
  assert.equal(task?.full_summary_md, "", "disk summary must not be imported into DB");
  const after = workflowSnapshot();
  assert.equal((before.attempts as unknown[]).length, 1, "fixture must seed a real attempt row");
  assert.equal((before.evidence as unknown[]).length, 1, "fixture must seed verification evidence");
  assert.deepEqual(after, before, "rebuild must not mutate attempt or verification rows");
}

for (const layout of ["legacy", "flat"] as const) {
  test(`rebuild markdown at project root repairs the root projection (${layout} layout)`, async () => {
    const fx = makeFixture(layout);
    seedStaleProjections(fx, [fx.root]);
    const before = workflowSnapshot();
    const ctx = makeCtx();

    const handled = await withCommandCwd(fx.root, () =>
      handleOpsCommand("rebuild markdown", ctx as any, mockPi as any));

    assert.equal(handled, true, "the ops dispatcher must claim `rebuild markdown`");
    assertRebuildRepairsSelectedRoot(fx.root, fx.worktree, fx);
    assertReopenedTaskRowsUntouched(before);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Quarantined:\s+2/);
    assert.equal(ctx.notifications.at(-1)?.level, "success");
  });

  test(`rebuild markdown from the active worktree repairs the worktree projection, not the project root (${layout} layout)`, async () => {
    const fx = makeFixture(layout);
    // Dual drift: stale completion files exist at BOTH roots; only the
    // worktree-local projection may be repaired.
    seedStaleProjections(fx, [fx.root, fx.worktree]);
    const before = workflowSnapshot();
    const ctx = makeCtx();

    const handled = await withCommandCwd(fx.worktree, () =>
      handleOpsCommand("rebuild markdown", ctx as any, mockPi as any));

    assert.equal(handled, true, "the ops dispatcher must claim `rebuild markdown`");
    assertRebuildRepairsSelectedRoot(fx.worktree, fx.root, fx);
    assertReopenedTaskRowsUntouched(before);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Quarantined:\s+2/);
    assert.equal(ctx.notifications.at(-1)?.level, "success");
  });

  test(`rebuild markdown from the active worktree re-renders the DB summary over the stale file (${layout} layout)`, async () => {
    const dbSummary = "# T01 Summary\n\nCanonical DB summary after re-completion.\n";
    const fx = makeFixture(layout, { dbSummary });
    const worktreeSummary = fx.summaryPathFor(fx.worktree);
    mkdirSync(join(worktreeSummary, ".."), { recursive: true });
    writeFileSync(worktreeSummary, STALE_SUMMARY, "utf-8");
    const before = workflowSnapshot();
    const ctx = makeCtx();

    const handled = await withCommandCwd(fx.worktree, () =>
      handleOpsCommand("rebuild markdown", ctx as any, mockPi as any));

    assert.equal(handled, true);
    const { revision, authorityEpoch } = getCurrentProjectStateVersion();
    assert.equal(
      readFileSync(worktreeSummary, "utf-8"),
      `${dbSummary}<!-- gsd:state-version=${revision}:${authorityEpoch} -->\n`,
      "worktree projection is re-rendered from DB content, not left stale",
    );
    assert.deepEqual(quarantineContents(fx.worktree), [STALE_SUMMARY]);
    // DB rows — including the canonical summary — stay untouched.
    const task = getTask("M001", "S01", "T01");
    assert.equal(task?.status, "complete");
    assert.equal(task?.full_summary_md, dbSummary);
    assert.equal((before.attempts as unknown[]).length, 1);
    assert.deepEqual(workflowSnapshot(), before, "rebuild must not mutate attempt or verification rows");
    assert.match(ctx.notifications.at(-1)?.message ?? "", /Quarantined:\s+1/);
    assert.equal(ctx.notifications.at(-1)?.level, "success");
  });
}
