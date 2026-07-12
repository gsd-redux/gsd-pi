// Project/App: gsd-pi
// File Purpose: Domain Operation contracts for roadmap reassessment.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  getAssessment,
  getSlice,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { PlanningInvocation } from "../planning-invocation.ts";
import { writePlanningDirectory } from "../migrate/planning-writer.ts";
import {
  handleReassessRoadmap,
  type ReassessRoadmapParams,
  type ReassessRoadmapResult,
} from "../tools/reassess-roadmap.ts";
import { workflowEventLogPath } from "../workflow-event-ledger.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function fixture(): { base: string; dbPath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reassess-operation-")));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd", "phases", "01-test-milestone"), { recursive: true });
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Completed", status: "complete", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Existing future work", status: "pending", sequence: 2 });
  adoptExistingSlice();
  return { base, dbPath };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string): number {
  return Number(db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function invocation(key: string): PlanningInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "direct",
    actorType: "agent",
    actorId: "reassess-test",
  };
}

function params(): ReassessRoadmapParams {
  return {
    milestoneId: "M001",
    completedSliceId: "S01",
    verdict: "confirmed",
    assessment: "The completed slice validates the approach.",
    sliceChanges: {
      modified: [{ sliceId: "S02", title: "Refined future work", risk: "high", depends: ["S01"] }],
      added: [
        { sliceId: "S03", title: "Ready follow-up", depends: ["S01"] },
        { sliceId: "S04", title: "Blocked follow-up", depends: ["S02"] },
      ],
      removed: [],
    },
  };
}

function adoptExistingSlice(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.seed.lifecycle",
    idempotencyKey: "seed/S02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId: "S02" },
  }, (context) => {
    adoptLifecycleIfMissing(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.slice.adopted",
        entityType: "slice",
        entityId: "M001/S02",
        payload: { sliceId: "S02" },
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "test/s02", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
}

function adoptDriftedTerminalLifecycle(
  item: "milestone" | "completed-slice",
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.seed.terminal-drift",
    idempotencyKey: `seed/terminal-drift/${item}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { item },
  }, (context) => {
    if (item === "milestone") {
      adoptLifecycleIfMissing(context, {
        itemKind: "milestone",
        milestoneId: "M001",
        lifecycleStatus: "completed",
      });
    } else {
      adoptLifecycleIfMissing(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "cancelled",
      });
    }
    return {
      events: [{ eventType: "test.terminal.drift", entityType: item, entityId: item, payload: { item }, destinations: ["projection"] }],
      projections: [{ projectionKey: `test/terminal-drift/${item}`, projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
}

function lifecycle(sliceId: string): Record<string, unknown> {
  return db().prepare(`
    SELECT lifecycle_status, state_version, last_operation_id, last_project_revision
    FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = ?
  `).get(sliceId) ?? {};
}

function eventLines(base: string): string[] {
  try {
    return readFileSync(workflowEventLogPath(base), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function reassess(
  input: ReassessRoadmapParams,
  base: string,
  envelope: PlanningInvocation,
): Promise<ReassessRoadmapResult | { error: string }> {
  return handleReassessRoadmap(input, base, envelope);
}

test("reassessment preserves its response and adopts added slices with progressive readiness", async () => {
  const { base } = fixture();
  const existingBefore = lifecycle("S02");

  const result = await reassess(params(), base, invocation("reassess/first"));
  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(result, {
    milestoneId: "M001",
    completedSliceId: "S01",
    assessmentPath: join(base, ".gsd", "phases", "01-test-milestone", "01-01-ASSESSMENT.md"),
    roadmapPath: join(base, ".gsd", "phases", "01-test-milestone", "01-ROADMAP.md"),
  });
  assert.deepEqual(lifecycle("S02"), existingBefore, "metadata reassessment must preserve existing lifecycle provenance");
  assert.equal(lifecycle("S03")["lifecycle_status"], "ready");
  assert.equal(lifecycle("S04")["lifecycle_status"], "pending");
  assert.ok(getAssessment(".gsd/phases/01-test-milestone/01-01-ASSESSMENT.md"));
  assert.equal(count("workflow_operations"), 2, "seed plus reassessment operations");
  assert.equal(count("workflow_domain_events"), 2);
  assert.equal(eventLines(base).filter((line) => line.includes('"cmd":"reassess-roadmap"')).length, 1);
});

test("exact reassessment replay repairs projections without another mutation or JSONL event", async () => {
  const { base, dbPath } = fixture();
  const envelope = invocation("reassess/replay");
  const first = await reassess(params(), base, envelope);
  assert.ok(!("error" in first));

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.unrelated",
    idempotencyKey: "unrelated/advance",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { unrelated: true },
  }, () => ({
    events: [{ eventType: "test.unrelated", entityType: "project", entityId: "project", payload: {}, destinations: ["projection"] }],
    projections: [{ projectionKey: "test/unrelated", projectionKind: "markdown", rendererVersion: "v1" }],
  }));
  const before = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    jsonl: eventLines(base).length,
  };

  closeDatabase();
  assert.equal(openDatabase(dbPath), true);
  const replay = await reassess(params(), base, envelope);
  assert.deepEqual(replay, first);
  assert.deepEqual({
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    jsonl: eventLines(base).length,
  }, before);
});

test("same reassessment invocation rejects changed semantics with no residue", async () => {
  const { base } = fixture();
  const envelope = invocation("reassess/conflict");
  const first = await reassess(params(), base, envelope);
  assert.ok(!("error" in first));
  const before = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    s03: getSlice("M001", "S03"),
    s04: getSlice("M001", "S04"),
    assessment: getAssessment(".gsd/phases/01-test-milestone/01-01-ASSESSMENT.md"),
  };
  const changed = params();
  changed.assessment = "Changed planning semantics under the same invocation.";

  const conflict = await reassess(changed, base, envelope);
  assert.ok("error" in conflict);
  assert.match(conflict.error, /idempotency|request|semantics|conflict/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    s03: getSlice("M001", "S03"),
    s04: getSlice("M001", "S04"),
    assessment: getAssessment(".gsd/phases/01-test-milestone/01-01-ASSESSMENT.md"),
  }, before);
});

test("removed slices are cancelled durably, excluded from the roadmap, and require explicit reopen", async () => {
  const { base } = fixture();
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  };
  const result = await reassess(input, base, invocation("reassess/remove"));
  assert.ok(!("error" in result));

  assert.equal(getSlice("M001", "S02")?.status, "skipped");
  assert.deepEqual(lifecycle("S02"), {
    lifecycle_status: "cancelled",
    state_version: 1,
    last_operation_id: lifecycle("S02")["last_operation_id"],
    last_project_revision: 2,
  });
  assert.doesNotMatch(readFileSync(result.roadmapPath, "utf8"), /\bS02\b/);
  await writePlanningDirectory(base, "flat-phases");
  assert.doesNotMatch(
    readFileSync(join(base, ".planning", "ROADMAP.md"), "utf8"),
    /Existing future work|S02/,
  );

  const before = {
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  };
  const reuse: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [],
      added: [{ sliceId: "S02", title: "Reuse without reopen", depends: ["S01"] }],
      removed: [],
    },
  };
  const rejected = await reassess(reuse, base, invocation("reassess/reuse-cancelled"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /cancelled slice S02|reopen/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  }, before);
});

test("removal fails before mutation when an unchanged slice would retain a dangling dependency", async () => {
  const { base } = fixture();
  insertSlice({ id: "S05", milestoneId: "M001", title: "Still depends on S02", status: "pending", depends: ["S02"], sequence: 3 });
  const before = {
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
    s05: getSlice("M001", "S05"),
  };
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  };

  const rejected = await reassess(input, base, invocation("reassess/dangling"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /S05.*depends.*S02|dangling dependency/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
    s05: getSlice("M001", "S05"),
  }, before);
});

test("modified and added slice identities are validated before roadmap mutation", async () => {
  const { base } = fixture();
  const before = {
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
  };
  const missing: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [{ sliceId: "S99", title: "Missing" }],
      added: [],
      removed: [],
    },
  };
  const missingResult = await reassess(missing, base, invocation("reassess/missing-modified"));
  assert.ok("error" in missingResult);
  assert.match(missingResult.error, /missing slice S99/i);

  const duplicate: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [],
      added: [{ sliceId: "S02", title: "Duplicate" }],
      removed: [],
    },
  };
  const duplicateResult = await reassess(duplicate, base, invocation("reassess/duplicate-added"));
  assert.ok("error" in duplicateResult);
  assert.match(duplicateResult.error, /existing slice S02/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
  }, before);
});

test("canonical cancellation vetoes modification even when the legacy slice drifted pending", async () => {
  const { base } = fixture();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.cancel.slice",
    idempotencyKey: "cancel/S02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId: "S02" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "cancelled",
    });
    return {
      events: [{ eventType: "test.slice.cancelled", entityType: "slice", entityId: "M001/S02", payload: {}, destinations: ["projection"] }],
      projections: [{ projectionKey: "test/cancel-s02", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
  const before = {
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  };
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [{ sliceId: "S02", title: "Must not modify" }],
      added: [],
      removed: [],
    },
  };

  const rejected = await reassess(input, base, invocation("reassess/canonical-cancelled"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /cancelled slice S02|reopen/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  }, before);
});

test("canonical cancellation vetoes a legacy-complete completedSliceId with no residue", async () => {
  const { base } = fixture();
  adoptDriftedTerminalLifecycle("completed-slice");
  const before = {
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  };

  const rejected = await reassess(params(), base, invocation("reassess/cancelled-completed-slice"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /completedSliceId S01.*cancelled|not a valid completed slice/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  }, before);
});

test("canonical terminal milestone vetoes reassessment despite legacy active drift", async () => {
  const { base } = fixture();
  adoptDriftedTerminalLifecycle("milestone");
  const before = {
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  };

  const rejected = await reassess(params(), base, invocation("reassess/terminal-milestone"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /closed milestone.*canonical status: completed/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  }, before);
});
