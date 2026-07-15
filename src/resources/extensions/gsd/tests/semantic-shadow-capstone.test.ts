// Project/App: gsd-pi
// File Purpose: Capstone proof that semantic-shadow evidence is complete, stable, and fail-closed.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "../db/domain-operation.ts";
import { openIsolatedDatabase } from "../db/engine.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
} from "../lifecycle-shadow-repair-domain-operation.ts";
import type { LifecycleShadowObservation } from "../lifecycle-shadow-observation.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.ts";
import {
  CAPSTONE_CLASSIFICATIONS,
  CAPSTONE_MODES,
  CAPSTONE_TRANSPORTS,
  normalizeSemanticShadowCapstoneEvidence,
  type CapstoneDispositionEvidence,
  type SemanticShadowCapstoneEvidence,
} from "./semantic-shadow-capstone-harness.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  _setLifecycleShadowRepairBeforeCommitForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-capstone-"));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "--quiet"], { cwd: basePath });
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n", "utf8");
  writeFileSync(join(basePath, "source.txt"), "semantic-shadow capstone\n", "utf8");
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function seedLifecycle(
  identity: LifecycleIdentity,
  lifecycleStatus: CanonicalLifecycleStatus,
  key: string,
): void {
  const payload: DomainJsonValue = {
    itemKind: identity.itemKind,
    milestoneId: identity.milestoneId,
    sliceId: identity.sliceId ?? null,
    taskId: identity.taskId ?? null,
    lifecycleStatus,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.semantic-shadow-capstone.seed",
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus });
    return {
      events: [{
        eventType: "test.semantic-shadow-capstone.seeded",
        entityType: identity.itemKind,
        entityId: [identity.milestoneId, identity.sliceId, identity.taskId].filter(Boolean).join("/"),
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: key,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function seedFixture(): void {
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES
      ('M001', 'Capstone milestone', 'pending', '2026-07-15T00:00:00.000Z'),
      ('M002', 'Repair milestone', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES
      ('M001', 'S01', 'Observed slice', 'active', 1, '2026-07-15T00:00:00.000Z'),
      ('M001', 'S02', 'Missing shadow slice', 'queued', 2, '2026-07-15T00:00:00.000Z'),
      ('M002', 'S01', 'Repair slice', 'active', 1, '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, sequence, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      ('M001', 'S01', 'T01', 'Extra shadow task', 'pending', 1, NULL, '', '', '', ''),
      ('M001', 'S01', 'T02', 'Mismatched task', 'done', 2, NULL, '', '', '', ''),
      ('M002', 'S01', 'A', 'Advance repair', 'complete', 1,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# A summary'),
      ('M002', 'S01', 'R', 'Adopt repair', 'complete', 2,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# R summary'),
      ('M002', 'S01', 'U', 'Unresolved repair', 'complete', 3, NULL, '', '', '', ''),
      ('M002', 'S01', 'X', 'Rejected repair', 'complete', 4,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# X summary');
  `);

  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "pending", "capstone/matrix/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress", "capstone/matrix/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "capstone/matrix/extra",
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    "paused",
    "capstone/matrix/mismatch",
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M002", sliceId: "S01", taskId: "A" },
    "ready",
    "capstone/repair/advance-seed",
  );

  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    DELETE FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db().exec("PRAGMA foreign_keys = ON");
}

function expectedResponse() {
  const result = {
    milestoneId: "M001",
    title: "Capstone milestone",
    status: "pending",
    createdAt: "2026-07-15T00:00:00.000Z",
    completedAt: null,
    sliceCount: 2,
    slices: [
      { id: "S01", status: "active", taskCounts: { total: 1, done: 1, pending: 0 } },
      { id: "S02", status: "queued", taskCounts: { total: 0, done: 0, pending: 0 } },
    ],
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structured: { operation: "milestone_status", ...result },
  };
}

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function observationPayloads(basePath: string): LifecycleShadowObservation[] {
  const observationDb = openIsolatedDatabase(join(basePath, ".gsd", "gsd.db"));
  assert.ok(observationDb);
  const rows = observationDb.prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observed'
    ORDER BY ts, event_id
  `).all();
  observationDb.close();
  return rows.map((row) => JSON.parse(String(row["payload_json"])) as LifecycleShadowObservation);
}

function repairInvocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "internal" as const,
    actorType: "agent" as const,
    actorId: "semantic-shadow-capstone",
  };
}

function repairTask(taskId: string) {
  return { itemKind: "task" as const, milestoneId: "M002", sliceId: "S01", taskId };
}

function authoritySnapshot(): Record<string, unknown> {
  return {
    authority: db().prepare("SELECT revision, authority_epoch FROM project_authority").get(),
    lifecycles: db().prepare("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
    operations: db().prepare("SELECT * FROM workflow_operations ORDER BY operation_id").all(),
    events: db().prepare("SELECT * FROM workflow_domain_events ORDER BY event_id").all(),
    projections: db().prepare("SELECT * FROM workflow_projection_work ORDER BY projection_work_id").all(),
  };
}

function corrupt<T>(value: T, mutate: (copy: T) => void): T {
  const copy = structuredClone(value);
  mutate(copy);
  return copy;
}

test("semantic-shadow capstone evidence converges and rejects incomplete or mixed proof", async () => {
  const basePath = makeBase();
  seedFixture();
  const source = captureMilestoneVerificationSourceRevision(basePath, undefined);
  assert.equal(source.ok, true);
  if (!source.ok) return;

  const frozenResponse = expectedResponse();
  const responseHash = stableHash(frozenResponse);
  for (const mode of CAPSTONE_MODES) {
    for (const transport of CAPSTONE_TRANSPORTS) {
      const response = await executeMilestoneStatus(
        { milestoneId: "M001" },
        basePath,
        {
          mode,
          transport,
          sourceRevision: source.sourceRevision,
          traceId: `trace:${mode}:${transport}`,
          turnId: `turn:${mode}:${transport}`,
        },
      );
      assert.deepEqual(response.content, frozenResponse.content);
      assert.deepEqual(response.details, frozenResponse.structured);
    }
  }

  const cleanObservations = observationPayloads(basePath);
  assert.equal(cleanObservations.length, 12);

  const advanced = repairLifecycleShadowForward({
    invocation: repairInvocation("capstone/repair/advanced"),
    item: repairTask("A"),
  });
  const repaired = repairLifecycleShadowForward({
    invocation: repairInvocation("capstone/repair/repaired"),
    item: repairTask("R"),
  });
  const unresolved = repairLifecycleShadowForward({
    invocation: repairInvocation("capstone/repair/unresolved"),
    item: repairTask("U"),
  });

  const beforeRejected = authoritySnapshot();
  _setLifecycleShadowRepairBeforeCommitForTest(() => {
    db().prepare("UPDATE tasks SET full_summary_md = '# changed' WHERE milestone_id = 'M002' AND id = 'X'").run();
  });
  assert.throws(() => repairLifecycleShadowForward({
    invocation: repairInvocation("capstone/repair/rejected"),
    item: repairTask("X"),
  }), /stable durable completion evidence/i);
  _setLifecycleShadowRepairBeforeCommitForTest(null);
  const rejectedAuthorityUnchanged = JSON.stringify(beforeRejected) === JSON.stringify(authoritySnapshot());

  db().exec("PRAGMA foreign_keys = OFF");
  db().exec("ALTER TABLE workflow_item_lifecycles RENAME TO unavailable_workflow_item_lifecycles");
  db().exec("PRAGMA foreign_keys = ON");
  const lossResponse = await executeMilestoneStatus(
    { milestoneId: "M001" },
    basePath,
    {
      mode: "legacy",
      transport: "native_pi",
      sourceRevision: source.sourceRevision,
      traceId: "trace:observation-loss",
      turnId: "turn:observation-loss",
    },
  );
  assert.deepEqual(lossResponse.content, frozenResponse.content);
  assert.deepEqual(lossResponse.details, frozenResponse.structured);
  const lossObservation = observationPayloads(basePath).at(-1)!;

  const dispositions: CapstoneDispositionEvidence[] = [
    {
      disposition: "advanced",
      sourceRevision: source.sourceRevision,
      proof: { beforeStatus: advanced.beforeStatus, afterStatus: advanced.afterStatus },
    },
    {
      disposition: "repaired",
      sourceRevision: source.sourceRevision,
      proof: { beforeStatus: repaired.beforeStatus, afterStatus: repaired.afterStatus },
    },
    {
      disposition: "unresolved",
      sourceRevision: source.sourceRevision,
      proof: { beforeStatus: unresolved.beforeStatus, afterStatus: unresolved.afterStatus },
    },
    {
      disposition: "rejected",
      sourceRevision: source.sourceRevision,
      proof: { authorityUnchanged: rejectedAuthorityUnchanged },
    },
    {
      disposition: "observation_loss",
      sourceRevision: source.sourceRevision,
      proof: {
        lossCount: lossObservation.observationLossAccounting.lossCount,
        persistedCount: lossObservation.observationLossAccounting.persistedCount,
        responseHash: stableHash({
          content: lossResponse.content,
          structured: lossResponse.details,
        }),
      },
    },
  ];
  const evidence: SemanticShadowCapstoneEvidence = {
    schemaVersion: 1,
    sourceRevision: source.sourceRevision,
    responseHash,
    observations: cleanObservations.map((observation) => ({
      mode: observation.mode,
      transport: observation.transport,
      sourceRevision: observation.sourceRevision,
      responseHash,
      classifications: observation.items.map((item) => item.classification),
      lossCount: observation.observationLossAccounting.lossCount,
      persistedCount: observation.observationLossAccounting.persistedCount,
    })),
    dispositions,
  };

  const normalized = normalizeSemanticShadowCapstoneEvidence(evidence);
  assert.equal(normalized.evidence.observations.length, 12);
  assert.equal(
    normalized.evidence.observations.flatMap((observation) => observation.classifications).length,
    60,
  );

  const reordered = corrupt(evidence, (copy) => {
    copy.observations.reverse();
    copy.dispositions.reverse();
    for (const observation of copy.observations) observation.classifications.reverse();
  });
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(reordered), normalized);
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(normalized), normalized);

  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(evidence, (copy) => copy.observations.pop())),
    /12 observation envelopes/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(evidence, (copy) => {
      copy.observations[11] = structuredClone(copy.observations[0]!);
    })),
    /duplicate observation cell/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(evidence, (copy) => {
      copy.observations[0]!.sourceRevision = "sha256:mixed-source";
    })),
    /mixed source revision/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence({ ...normalized, evidenceHash: "sha256:corrupt" }),
    /evidence hash mismatch/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(evidence, (copy) => {
      copy.observations[0]!.classifications[0] = copy.observations[0]!.classifications[1]!;
    })),
    /classification set/i,
  );
});
