import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveMilestoneValidationVerdict } from "../milestone-validation-verdict.ts";
import {
  adoptOrTransitionLifecycle,
  openDatabase,
  closeDatabase,
  executeDomainOperation,
  insertAssessment,
  insertMilestone,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";

function setup(base: string): void {
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  process.chdir(base);
  _clearGsdRootCache();
  openDatabase(join(base, ".gsd", "gsd.db"));
  invalidateAllCaches();
}

function adoptMilestone(milestoneId: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: `test/${milestoneId}/adopt`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { milestoneId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${milestoneId}/adopt`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function recordCanonicalValidation(milestoneId: string, overallVerdict: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.validate",
    idempotencyKey: `test/${milestoneId}/validate/${overallVerdict}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId, overallVerdict },
  }, () => ({
    events: [{
      eventType: "milestone.validation.recorded",
      entityType: "milestone",
      entityId: milestoneId,
      payload: { overallVerdict },
      destinations: ["test"],
    }],
    projections: [{
      projectionKey: `test/${milestoneId}/validation/${fence.revision}`.toLowerCase(),
      projectionKind: "test",
      rendererVersion: "1",
    }],
  }));
}

test("resolveMilestoneValidationVerdict prefers DB pass over stale worktree needs-attention", async () => {
  const base = join(tmpdir(), `validation-verdict-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../.git/worktrees/M001\n", "utf-8");
  writeFileSync(
    join(worktree, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: needs-attention\n---\n\n# Validation\nStale worktree copy.\n",
  );

  try {
    setup(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertAssessment({
      path: join(worktree, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n\n# Validation\nManual override.\n",
    });

    const verdict = await resolveMilestoneValidationVerdict(base, "M001");
    assert.equal(verdict, "pass");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveMilestoneValidationVerdict does not promote a projection when the DB has no validation", async (t) => {
  const base = join(tmpdir(), `validation-verdict-file-only-${Date.now()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const validationDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(validationDir, { recursive: true });
  writeFileSync(
    join(validationDir, "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n\n# Validation\nProjection only.\n",
  );

  setup(base);
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  const verdict = await resolveMilestoneValidationVerdict(base, "M001");
  assert.equal(verdict, undefined);
});

test("resolveMilestoneValidationVerdict rejects a forged omitted assessment", async (t) => {
  const base = join(tmpdir(), `validation-verdict-omitted-${Date.now()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(base, { recursive: true });

  setup(base);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    status: "omitted",
    scope: "milestone-validation",
    fullContent: "---\noutcome: omitted\nsource_revision: forged\n---\n",
  });

  assert.equal(await resolveMilestoneValidationVerdict(base, "M001"), undefined);
});

test("resolveMilestoneValidationVerdict keeps the database assessment authoritative after adoption", async (t) => {
  const base = join(tmpdir(), `validation-verdict-adopted-${Date.now()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(base, { recursive: true });

  setup(base);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  adoptMilestone("M001");

  recordCanonicalValidation("M001", "pass");
  assert.equal(await resolveMilestoneValidationVerdict(base, "M001"), "pass");
});

test("resolveMilestoneValidationVerdict does not let adoption hide a database assessment", async (t) => {
  const base = join(tmpdir(), `validation-verdict-adopted-no-receipt-${Date.now()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(base, { recursive: true });

  setup(base);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  adoptMilestone("M001");

  assert.equal(await resolveMilestoneValidationVerdict(base, "M001"), "pass");
});
