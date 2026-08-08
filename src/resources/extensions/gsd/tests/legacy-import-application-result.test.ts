// Project/App: gsd-pi
// File Purpose: Independent result-verification contract for retained legacy Import Applications.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  executeImportDomainOperation,
  type DomainOperationMutation,
  type ImportDomainOperationRequest,
} from "../db/domain-operation.ts";
import { applyLegacyImportApplicationPlan } from "../db/writers/legacy-import-application.ts";
import {
  LegacyImportApplicationError,
} from "../legacy-import-application-error.ts";
import type { LegacyImportApplicationEvidence } from "../legacy-import-application-evidence.ts";
import {
  compileLegacyImportApplicationPlan,
  type LegacyImportApplicationPlan,
  type LegacyImportApplicationPlanInstruction,
} from "../legacy-import-application-plan.ts";
import {
  verifyLegacyImportApplicationResult,
  verifyLegacyImportApplicationTargets,
} from "../legacy-import-application-result.ts";
import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewSource,
  type LegacyImportTarget,
  type LegacyImportValue,
} from "../legacy-import-contract.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";

const tempDirectories = new Set<string>();
let importSequence = 0;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gsd-legacy-import-result-"));
  tempDirectories.add(directory);
  return join(directory, "gsd.db");
}

function openFixture(): void {
  assert.equal(openDatabase(databasePath()), true);
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, bindings: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(bindings) ?? {};
}

function projectId(): string {
  return String(row("SELECT project_id FROM project_authority WHERE singleton = 1")["project_id"]);
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

// #1657: hierarchy creates now always mint lifecycle authority, so retained
// Application verification expects a lifecycle row per created hierarchy row.
function seedLifecycleRow(
  itemKind: "milestone" | "slice" | "task",
  milestoneId: string,
  sliceId: string | null,
): void {
  const lifecycleStatus = 'ready';
  db().prepare(`INSERT OR IGNORE INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      'seed-lifecycle-operation', :project_id, 'test.seed', 'seed-lifecycle-operation',
      0, 1, 0, 0,
      'test', 'internal', :request_hash, '2026-07-17T00:00:00.000Z'
    )`).run({
    ":project_id": projectId(),
    ":request_hash": hashLegacyImportValue("seed-lifecycle-operation"),
  });
  db().prepare(`INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      :lifecycle_id, :project_id, :item_kind, :milestone_id, :slice_id, NULL,
      :lifecycle_status, 0, '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
      'seed-lifecycle-operation', 1, 0
    )`).run({
    ":lifecycle_id": `lifecycle-${itemKind}-${milestoneId}${sliceId === null ? "" : `-${sliceId}`}`,
    ":project_id": projectId(),
    ":item_kind": itemKind,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":lifecycle_status": lifecycleStatus,
  });
}

// ─── Sealed Preview scaffolding (mirrors the pure plan compiler contract) ────

function source(label: string): LegacyImportPreviewSource {
  return {
    source_id: hashLegacyImportValue(`source:${label}`),
    path: `.legacy/${label}.md`,
    kind: "markdown",
    byte_size: 1_000,
    sha256: hashLegacyImportValue(`source-bytes:${label}`),
    parser_id: `parser-${label}`,
    parser_version: "1",
    encoding: "utf-8",
    outcome: "mapped",
  };
}

function change(
  label: string,
  sourceValue: LegacyImportPreviewSource,
  action: LegacyImportPreviewChange["action"],
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
): LegacyImportPreviewChange {
  const value = {
    action,
    target,
    raw: {
      source_id: sourceValue.source_id,
      locator: { start_byte: 0, end_byte: 10, line: 1 },
      value: `raw-${label}`,
      sha256: hashLegacyImportValue(`raw-${label}`),
    },
    normalized,
    provenance: {
      source_id: sourceValue.source_id,
      parser_id: sourceValue.parser_id,
      parser_version: sourceValue.parser_version,
    },
    reason_code: `reason-${label}`,
  };
  return { change_id: hashLegacyImportValue(value), ...value };
}

function artifact(
  sources: LegacyImportPreviewSource[],
  changes: LegacyImportPreviewChange[],
): LegacyImportPreviewArtifact {
  const orderedSources = [...sources].sort((left, right) => (
    left.path.localeCompare(right.path) || left.source_id.localeCompare(right.source_id)
  ));
  const orderedChanges = [...changes].sort((left, right) => left.change_id.localeCompare(right.change_id));
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: "/tmp/project-1",
        revision: 7,
        authority_epoch: 2,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: hashLegacyImportValue([]),
    },
    source_set_hash: hashLegacyImportValue(orderedSources),
    change_set_hash: hashLegacyImportValue(orderedChanges),
    counts: {
      create: orderedChanges.filter((entry) => entry.action === "create").length,
      update: orderedChanges.filter((entry) => entry.action === "update").length,
      delete: orderedChanges.filter((entry) => entry.action === "delete").length,
      preserve: orderedChanges.filter((entry) => entry.action === "preserve").length,
      unparsed: 0,
      unresolved: 0,
    },
    sources: orderedSources,
    changes: orderedChanges,
    diagnoses: [],
    resolutions: [],
  });
}

function evidenceFor(
  preview: LegacyImportPreviewArtifact,
  plan: LegacyImportApplicationPlan,
): LegacyImportApplicationEvidence {
  const snapshot = captureCurrentLegacyImportBaseSnapshot();
  return {
    resultingProjectRevision: snapshot.authority.revision,
    resultingAuthorityEpoch: snapshot.authority.authority_epoch,
    applicationRelevantRowsHash: snapshot.relevant_rows_hash,
    preview,
    plan,
  } as unknown as LegacyImportApplicationEvidence;
}

function compileError(
  fn: () => unknown,
  code: LegacyImportApplicationError["code"],
): void {
  let error: unknown;
  try {
    fn();
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof LegacyImportApplicationError, String(error));
  assert.equal(error.stage, "compile");
  assert.equal(error.code, code);
}

// ─── Finding 1: standard -status lifecycle path verifies instead of throwing ─

test("result verification accepts the standard -status lifecycle path", () => {
  openFixture();
  const roadmap = source("roadmap");
  const preview = artifact([roadmap], [
    change("milestone", roadmap, "create", { kind: "milestone", key: "M001" }, {
      id: "M001", title: "Pocket Notes",
    }),
    change("milestone-status", roadmap, "create", { kind: "milestone-status", key: "M001" }, "complete"),
  ]);
  const plan = compileLegacyImportApplicationPlan(preview);
  assert.ok(plan.instructions.some((instruction) => (
    instruction.action === "adopt-lifecycle" && instruction.targetKind === "milestone-lifecycle"
  )));
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M001', 'Pocket Notes', 'active')").run();
  db().prepare(`INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      'seed-operation', :project_id, 'test.seed', 'seed-operation',
      0, 1, 0, 0,
      'test', 'internal', :request_hash, '2026-07-17T00:00:00.000Z'
    )`).run({
    ":project_id": projectId(),
    ":request_hash": hashLegacyImportValue("seed-operation"),
  });
  db().prepare(`INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lifecycle-M001', :project_id, 'milestone', 'M001', NULL, NULL,
      'completed', 0, '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
      'seed-operation', 1, 0
    )`).run({ ":project_id": projectId() });

  const evidence = evidenceFor(preview, plan);
  verifyLegacyImportApplicationTargets(evidence);
  verifyLegacyImportApplicationResult(evidence);

  db().prepare("UPDATE milestones SET title = 'Rewritten after the fact' WHERE id = 'M001'").run();
  assert.throws(
    () => verifyLegacyImportApplicationTargets(evidenceFor(preview, plan)),
    /did not match retained Application content/,
  );
});

test("result verification detects canonical authority advancing after the retained Application", () => {
  openFixture();
  const roadmap = source("roadmap");
  const preview = artifact([roadmap], [
    change("milestone", roadmap, "create", { kind: "milestone", key: "M001" }, {
      id: "M001", title: "Pocket Notes",
    }),
  ]);
  const plan = compileLegacyImportApplicationPlan(preview);
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M001', 'Pocket Notes', 'active')").run();
  seedLifecycleRow("milestone", "M001", null);
  const evidence = evidenceFor(preview, plan);
  verifyLegacyImportApplicationResult(evidence);

  db().prepare("INSERT INTO milestones (id, title) VALUES ('M999', 'Unrelated drift')").run();
  assert.throws(
    () => verifyLegacyImportApplicationResult(evidence),
    /canonical authority advanced after the retained Import Application/,
  );
});

// ─── Finding 2: assessment rows verify against their canonical base identity ──

const ASSESSMENT_PATH = ".gsd/milestones/M001/slices/S01/UAT.md";

function seedAssessmentHierarchy(status = "pass"): void {
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', 'S01', 'Foundation')").run();
  // #1658: an applied import seeds a Q8 companion gate per created slice, and
  // target verification now asserts it exists.
  db().prepare(`INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')`).run();
  db().prepare(`INSERT INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content)
    VALUES (:path, 'M001', 'S01', NULL, :status, 'run-uat', '# UAT\n\nPass.')`).run({
    ":path": ASSESSMENT_PATH,
    ":status": status,
  });
}

function assessmentPreview(): {
  preview: LegacyImportPreviewArtifact;
  plan: LegacyImportApplicationPlan;
} {
  const uat = source("uat");
  const preview = artifact([uat], [
    change("milestone", uat, "create", { kind: "milestone", key: "M001" }, { id: "M001", title: "Milestone" }),
    change("slice", uat, "create", { kind: "slice", key: "M001/S01" }, {
      id: "S01", milestone_id: "M001", title: "Foundation",
    }),
    change("assessment", uat, "create", { kind: "assessment", key: "M001/S01/run-uat" }, {
      milestone_id: "M001",
      slice_id: "S01",
      task_id: null,
      scope: "run-uat",
      verdict: "pass",
      authority: "structured",
      path: ASSESSMENT_PATH,
      full_content: "# UAT\n\nPass.",
    }),
  ]);
  return { preview, plan: compileLegacyImportApplicationPlan(preview) };
}

test("result verification matches assessment creates and detects content drift", () => {
  openFixture();
  const { preview, plan } = assessmentPreview();
  const assessment = plan.instructions.find((instruction) => instruction.targetKind === "assessment");
  assert.ok(assessment?.action === "create");
  assert.equal(typeof assessment.identity["path"], "string");
  seedAssessmentHierarchy();
  seedLifecycleRow("milestone", "M001", null);
  seedLifecycleRow("slice", "M001", "S01");

  verifyLegacyImportApplicationTargets(evidenceFor(preview, plan));
  verifyLegacyImportApplicationResult(evidenceFor(preview, plan));

  db().prepare("UPDATE assessments SET status = 'fail' WHERE path = :path").run({ ":path": ASSESSMENT_PATH });
  assert.throws(
    () => verifyLegacyImportApplicationTargets(evidenceFor(preview, plan)),
    /did not match retained Application content/,
  );
});

test("result verification does not vacuously pass an assessment delete while the row remains", () => {
  openFixture();
  seedAssessmentHierarchy();
  const empty = artifact([], []);
  const emptyPlan = compileLegacyImportApplicationPlan(empty);
  const deletion: LegacyImportApplicationPlanInstruction = {
    action: "delete",
    targetKind: "assessment",
    targetKey: "M001/S01/run-uat",
    rowSet: "assessments",
    identity: {
      path: ASSESSMENT_PATH,
      milestone_id: "M001",
      slice_id: "S01",
      task_id: null,
      scope: "run-uat",
    },
    values: {},
    changeIds: ["handcrafted-delete"],
  };
  const plan: LegacyImportApplicationPlan = { ...emptyPlan, instructions: [deletion] };

  assert.throws(
    () => verifyLegacyImportApplicationTargets(evidenceFor(empty, plan)),
    /did not match retained Application content/,
  );

  db().prepare("DELETE FROM assessments WHERE path = :path").run({ ":path": ASSESSMENT_PATH });
  verifyLegacyImportApplicationTargets(evidenceFor(empty, plan));
});

// ─── Finding 3: lifecycle updates are refused at compile with mapping taxonomy ─

test("plan compilation binds lifecycle updates to both the row and lifecycle writer", () => {
  const roadmap = source("roadmap");
  for (const lifecycleChange of [
      change("status", roadmap, "update", { kind: "milestone-status", key: "M001" }, "active"),
      change("status-field", roadmap, "update", { kind: "milestone", key: "M001", field: "status" }, "active"),
  ]) {
    const plan = compileLegacyImportApplicationPlan(artifact([roadmap], [lifecycleChange]));
    assert.ok(plan.instructions.some((instruction) => (
      instruction.action === "update"
      && instruction.rowSet === "milestones"
      && instruction.values.status === "active"
    )), JSON.stringify(plan.instructions));
    assert.ok(plan.instructions.some((instruction) => (
      instruction.action === "adopt-lifecycle"
      && instruction.lifecycleAction === "update"
      && instruction.targetKind === "milestone-lifecycle"
    )));
  }
});

// ─── Writer harness for findings 6 and 8 ─────────────────────────────────────

function emptyPreview(): LegacyImportPreviewArtifact {
  const emptyHash = hashLegacyImportValue([]);
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: "/tmp/project-1/result-writer",
        revision: 0,
        authority_epoch: 0,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: emptyHash,
    },
    source_set_hash: emptyHash,
    change_set_hash: emptyHash,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function planFor(
  artifactValue: LegacyImportPreviewArtifact,
  instructions: readonly LegacyImportApplicationPlanInstruction[],
): LegacyImportApplicationPlan {
  const receiptCounts = { ...artifactValue.preview.counts };
  const mutationCounts = {
    create: instructions.filter((entry) => entry.action === "create").length,
    update: instructions.filter((entry) => entry.action === "update").length,
    delete: instructions.filter((entry) => entry.action === "delete").length,
    replaceSliceDependencies: instructions.filter((entry) => entry.action === "replace-slice-dependencies").length,
    deleteSliceDependencies: instructions.filter((entry) => entry.action === "delete-slice-dependencies").length,
    adoptLifecycle: instructions.filter((entry) => entry.action === "adopt-lifecycle").length,
    seedQualityGate: instructions.filter((entry) => entry.action === "seed-quality-gate").length,
  };
  const affectedTargets = instructions
    .filter((entry) => entry.action !== "preserve")
    .map((entry) => ({ targetKind: entry.targetKind, targetKey: entry.targetKey }));
  const plan: LegacyImportApplicationPlan = {
    planSchemaVersion: 2,
    previewId: artifactValue.preview.preview_id,
    previewHash: artifactValue.preview_hash,
    baseProjectRevision: artifactValue.preview.base_project_revision,
    baseAuthorityEpoch: artifactValue.preview.base_authority_epoch,
    receiptCounts,
    instructions: structuredClone(instructions),
    accounting: {
      sourceIds: [],
      diagnosisIds: [],
      resolutionIds: [],
      changeIds: instructions.flatMap((entry) => [...entry.changeIds]),
      preserveChangeIds: [],
      unparsedSourceIds: [],
    },
    mutationCounts,
    affectedTargets,
    eventFacts: {
      previewId: artifactValue.preview.preview_id,
      previewHash: artifactValue.preview_hash,
      sourceSetHash: artifactValue.preview.source_set_hash,
      changeSetHash: artifactValue.preview.change_set_hash,
      receiptCounts,
      mutationCounts,
      affectedTargetHashes: affectedTargets.map((target) => hashLegacyImportValue({
        kind: target.targetKind,
        key: target.targetKey,
      })),
      sourceCount: 0,
      diagnosisCount: 0,
      resolutionCount: 0,
      preserveCount: 0,
      unparsedCount: 0,
    },
    projectionKeys: [`legacy-import/${artifactValue.preview.preview_id}`],
  };
  return structuredClone(plan);
}

function importRequest(artifactValue: LegacyImportPreviewArtifact): ImportDomainOperationRequest {
  importSequence += 1;
  return {
    operationType: "import.apply",
    idempotencyKey: `legacy-import/result-writer-${importSequence}`,
    expectedRevision: artifactValue.preview.base_project_revision,
    expectedAuthorityEpoch: artifactValue.preview.base_authority_epoch,
    actorType: "agent",
    actorId: "legacy-import-result-test",
    sourceTransport: "internal",
    payload: artifactValue,
  };
}

function mutation(plan: LegacyImportApplicationPlan): DomainOperationMutation {
  return {
    events: [{
      eventType: "legacy-import.applied",
      entityType: "legacy-import",
      entityId: plan.previewId,
      payload: { previewId: plan.previewId, previewHash: plan.previewHash },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: plan.projectionKeys[0]!,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

function insertImportApplicationReceiptStub(
  context: { operationId: string; projectId: string; resultingRevision: number; resultingAuthorityEpoch: number },
  artifactValue: LegacyImportPreviewArtifact,
): void {
  const preview = artifactValue.preview;
  db().prepare(`
    INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version,
      preview_schema_version, preview_id, preview_hash,
      base_project_revision, base_authority_epoch, base_database_schema_version,
      source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json,
      backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :import_kind, :importer_version,
      :preview_schema_version, :preview_id, :preview_hash,
      :base_project_revision, :base_authority_epoch, :base_database_schema_version,
      :source_set_hash, :change_set_hash,
      :create_count, :update_count, :delete_count, :preserve_count, :unparsed_count, :unresolved_count,
      :preview_json,
      '/tmp/verified-backup.sqlite', :backup_sha256, 1, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, 'ok', '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:01.000Z', :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":import_kind": preview.import_kind,
    ":importer_version": preview.importer_version,
    ":preview_schema_version": preview.preview_schema_version,
    ":preview_id": preview.preview_id,
    ":preview_hash": artifactValue.preview_hash,
    ":base_project_revision": preview.base_project_revision,
    ":base_authority_epoch": preview.base_authority_epoch,
    ":base_database_schema_version": preview.base_database_schema_version,
    ":source_set_hash": preview.source_set_hash,
    ":change_set_hash": preview.change_set_hash,
    ":create_count": preview.counts.create,
    ":update_count": preview.counts.update,
    ":delete_count": preview.counts.delete,
    ":preserve_count": preview.counts.preserve,
    ":unparsed_count": preview.counts.unparsed,
    ":unresolved_count": preview.counts.unresolved,
    ":preview_json": canonicalLegacyImportJson(preview),
    ":backup_sha256": `sha256:${"2".repeat(64)}`,
    ":backup_schema_version": preview.base_database_schema_version,
    ":backup_project_revision": preview.base_project_revision,
    ":backup_authority_epoch": preview.base_authority_epoch,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
}

function applyImport(
  artifactValue: LegacyImportPreviewArtifact,
  plan: LegacyImportApplicationPlan,
): void {
  executeImportDomainOperation(importRequest(artifactValue), (context) => {
    applyLegacyImportApplicationPlan(context, plan);
    insertImportApplicationReceiptStub(context, artifactValue);
    return mutation(plan);
  });
}

// ─── Finding 6: dependency sets compare in the plan collation, not SQLite BINARY ─

test("writer verifies slice dependency sets in the same collation the plan sorted them in", () => {
  openFixture();
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  // U+1F600 sorts before U+FFFF in JS UTF-16 order but after it in SQLite BINARY (UTF-8) order.
  const astral = "S\u{1F600}";
  const bmpEdge = "S\uFFFF";
  assert.ok(astral < bmpEdge, "fixture requires divergent JS vs BINARY ordering");
  for (const id of ["S01", astral, bmpEdge]) {
    db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', :id, 'Slice')").run({ ":id": id });
  }
  const artifactValue = emptyPreview();
  const instruction: LegacyImportApplicationPlanInstruction = {
    action: "replace-slice-dependencies",
    targetKind: "slice-dependencies",
    targetKey: "M001/S01",
    milestoneId: "M001",
    sliceId: "S01",
    dependsOnSliceIds: [astral, bmpEdge].sort(),
    changeIds: ["collation-dependencies"],
  };

  applyImport(artifactValue, planFor(artifactValue, [instruction]));

  const stored = db().prepare(`SELECT depends_on_slice_id FROM slice_dependencies
    WHERE milestone_id = 'M001' AND slice_id = 'S01'`).all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    stored.map((entry) => String(entry["depends_on_slice_id"])).sort(),
    [astral, bmpEdge].sort(),
  );
});

// ─── Finding 8: retained-slice depends JSON cannot drift after dependency deletes ─

function seedDependencyDriftFixture(retainedDepends: string): void {
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  db().prepare("INSERT INTO slices (milestone_id, id, title, depends) VALUES ('M001', 'S01', 'Retained', :depends)")
    .run({ ":depends": retainedDepends });
  db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', 'S02', 'Delete me')").run();
  db().prepare(`INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S01', 'S02')`).run();
}

function deleteSlicePlan(
  artifactValue: LegacyImportPreviewArtifact,
): LegacyImportApplicationPlan {
  return planFor(artifactValue, [
    {
      action: "delete-slice-dependencies",
      targetKind: "slice-dependencies",
      targetKey: "M001/S02",
      milestoneId: "M001",
      sliceId: "S02",
      changeIds: ["delete-dependencies"],
    },
    {
      action: "delete",
      targetKind: "slice",
      targetKey: "M001/S02",
      rowSet: "slices",
      identity: { milestone_id: "M001", id: "S02" },
      values: {},
      changeIds: ["delete-slice"],
    },
  ]);
}

test("writer refuses to leave a retained slice depending on a deleted slice", () => {
  openFixture();
  seedDependencyDriftFixture('["S02"]');
  const artifactValue = emptyPreview();

  assert.throws(
    () => applyImport(artifactValue, deleteSlicePlan(artifactValue)),
    /retained slice depends on a deleted slice/,
  );
  assert.equal(row("SELECT COUNT(*) AS count FROM slices")["count"], 2);
  assert.equal(row("SELECT COUNT(*) AS count FROM slice_dependencies")["count"], 1);
});

test("writer permits dependency deletes whose retained slices no longer reference the deleted slice", () => {
  openFixture();
  seedDependencyDriftFixture("[]");
  const artifactValue = emptyPreview();

  applyImport(artifactValue, deleteSlicePlan(artifactValue));

  assert.equal(row("SELECT COUNT(*) AS count FROM slices")["count"], 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM slice_dependencies")["count"], 0);
});
