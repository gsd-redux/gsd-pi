// Project/App: gsd-pi
// File Purpose: Pure whole-Preview compilation contract for transactional legacy import.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportTarget,
  type LegacyImportValue,
} from "../legacy-import-contract.ts";
import { LegacyImportApplicationError } from "../legacy-import-application.ts";
import {
  compileLegacyImportApplicationPlan,
} from "../legacy-import-application-plan.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";

const PROJECT_REVISION = 7;
const AUTHORITY_EPOCH = 2;

function source(
  label: string,
  outcome: LegacyImportPreviewSource["outcome"] = "mapped",
): LegacyImportPreviewSource {
  return {
    source_id: hashLegacyImportValue(`source:${label}`),
    path: `.legacy/${label}.md`,
    kind: "markdown",
    byte_size: 1_000,
    sha256: hashLegacyImportValue(`source-bytes:${label}`),
    parser_id: `parser-${label}`,
    parser_version: "1",
    encoding: "utf-8",
    outcome,
  };
}

function change(
  label: string,
  sourceValue: LegacyImportPreviewSource,
  action: LegacyImportPreviewChange["action"],
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  reasonCode = `reason-${label}`,
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
    reason_code: reasonCode,
  };
  return { change_id: hashLegacyImportValue(value), ...value };
}

interface ArtifactInput {
  sources: LegacyImportPreviewSource[];
  changes?: LegacyImportPreviewChange[];
  diagnoses?: LegacyImportPreviewDiagnosis[];
  resolutions?: LegacyImportPreviewResolution[];
}

function artifact(input: ArtifactInput): LegacyImportPreviewArtifact {
  const sources = [...input.sources].sort((left, right) => (
    left.path.localeCompare(right.path) || left.source_id.localeCompare(right.source_id)
  ));
  const changes = [...(input.changes ?? [])].sort((left, right) => (
    left.change_id.localeCompare(right.change_id)
  ));
  const diagnoses = [...(input.diagnoses ?? [])].sort((left, right) => (
    left.diagnosis_id.localeCompare(right.diagnosis_id)
  ));
  const resolutions = [...(input.resolutions ?? [])].sort((left, right) => (
    left.diagnosis_id.localeCompare(right.diagnosis_id)
  ));
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
        revision: PROJECT_REVISION,
        authority_epoch: AUTHORITY_EPOCH,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: hashLegacyImportValue([]),
    },
    source_set_hash: hashLegacyImportValue(sources),
    change_set_hash: hashLegacyImportValue(changes),
    counts: {
      create: changes.filter((entry) => entry.action === "create").length,
      update: changes.filter((entry) => entry.action === "update").length,
      delete: changes.filter((entry) => entry.action === "delete").length,
      preserve: changes.filter((entry) => entry.action === "preserve").length,
      unparsed: sources.filter((entry) => entry.outcome === "unparsed").length,
      unresolved: resolutions.filter((entry) => (
        entry.disposition === "requires-user" || entry.disposition === "unsupported"
      )).length,
    },
    sources,
    changes,
    diagnoses,
    resolutions,
  });
}

function applicationError(
  fn: () => unknown,
  code: LegacyImportApplicationError["code"],
): LegacyImportApplicationError {
  let error: unknown;
  try {
    fn();
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof LegacyImportApplicationError);
  assert.equal(error.stage, code === "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED" ? "preview" : "compile");
  assert.equal(error.code, code);
  return error;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

describe("legacy import Application plan", () => {
  test("compiles deterministically without I/O, clocks, randomness, or mutable aliases", () => {
    const input = artifact({ sources: [] });
    const before = structuredClone(input);
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    const originalFetch = globalThis.fetch;
    Date.now = () => { throw new Error("clock access"); };
    Math.random = () => { throw new Error("random access"); };
    globalThis.fetch = (() => { throw new Error("network access"); }) as typeof fetch;
    try {
      const first = compileLegacyImportApplicationPlan(input);
      const second = compileLegacyImportApplicationPlan(input);
      assert.equal(canonicalLegacyImportJson(first), canonicalLegacyImportJson(second));
      assert.deepEqual(input, before);
      assert.deepEqual(first.instructions, []);
      assert.deepEqual(first.projectionKeys, [`legacy-import/${input.preview.preview_id}`]);
      assertDeepFrozen(first);
      assert.notStrictEqual(first.receiptCounts, input.preview.counts);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalRandom;
      globalThis.fetch = originalFetch;
    }
  });

  test("refuses an artifact whose sealed Preview identity was forged", () => {
    const valid = artifact({ sources: [] });
    const invalid = { ...structuredClone(valid), preview_hash: hashLegacyImportValue("forged") };
    applicationError(
      () => compileLegacyImportApplicationPlan(invalid),
      "LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID",
    );
  });

  test("merges whole-row, alias, and explicit status evidence into row plus lifecycle work", () => {
    const project = source("project");
    const roadmap = source("roadmap");
    const plan = source("plan");
    const summary = source("summary");
    const requirements = source("requirements");
    const input = artifact({
      sources: [project, roadmap, plan, summary, requirements],
      changes: [
        change("milestone", project, "create", { kind: "milestone", key: "M001" }, {
          id: "M001", title: "Pocket Notes",
        }),
        change("slice", roadmap, "create", { kind: "slice", key: "M001/S01" }, {
          id: "S01", milestone_id: "M001", title: "Foundation", status: "complete",
        }),
        change("task", plan, "create", { kind: "task", key: "M001/S01/T01" }, {
          id: "T01", slice_id: "S01", title: "Persist notes", status: "planned",
          objective: "Store and reload a note.",
        }),
        change("task-status", summary, "create", {
          kind: "task", key: "M001/S01/T01", field: "status",
        }, {
          id: "T01", slice_id: "S01", status: "complete", summary: "Verification passed.",
        }),
        change("requirement", requirements, "create", { kind: "requirement", key: "R001" }, {
          id: "R001", text: "Saved notes remain available.",
        }),
      ],
    });

    const planValue = compileLegacyImportApplicationPlan(input);
    const task = planValue.instructions.find((entry) => (
      entry.action === "create" && entry.targetKind === "task"
    ));
    const lifecycle = planValue.instructions.find((entry) => (
      entry.action === "adopt-lifecycle" && entry.targetKind === "task-lifecycle"
    ));
    assert.ok(task?.action === "create");
    assert.deepEqual(task.values, {
      description: "Store and reload a note.",
      id: "T01",
      milestone_id: "M001",
      slice_id: "S01",
      status: "planned",
      full_summary_md: "Verification passed.",
      title: "Persist notes",
    });
    assert.ok(lifecycle?.action === "adopt-lifecycle");
    assert.equal(lifecycle.lifecycleStatus, "completed");
    // #1657: hierarchy creates without explicit status evidence still mint
    // lifecycle authority — terminal statuses adopt as-is, in-flight as ready.
    const derived = planValue.instructions.filter((entry) => (
      entry.action === "adopt-lifecycle" && entry.targetKind !== "task-lifecycle"
    ));
    assert.deepEqual(
      derived.map((entry) => (entry.action === "adopt-lifecycle"
        ? `${entry.targetKind}:${entry.targetKey}:${entry.lifecycleStatus}`
        : "")),
      ["milestone-lifecycle:M001:ready", "slice-lifecycle:M001/S01:completed"],
    );
    // #1658: every created slice mints its companion Q8 gate — completed
    // slices adopt the closed shape complete-slice would have left behind.
    const gates = planValue.instructions.filter(
      (entry): entry is Extract<typeof entry, { action: "seed-quality-gate" }> => entry.action === "seed-quality-gate",
    );
    assert.deepEqual(
      gates.map((entry) => `${entry.targetKey}:${entry.gateStatus}`),
      ["M001/S01:complete"],
    );
    assert.deepEqual(planValue.receiptCounts, input.preview.counts);
    assert.deepEqual(planValue.mutationCounts, {
      create: 4,
      update: 0,
      delete: 0,
      replaceSliceDependencies: 0,
      deleteSliceDependencies: 0,
      adoptLifecycle: 3,
      seedQualityGate: 1,
    });
    assert.deepEqual(planValue.accounting.changeIds, input.preview.changes.map((entry) => entry.change_id));
    assert.equal(JSON.stringify(planValue.eventFacts).includes("raw-task"), false);
  });

  test("compiles lifecycle shadow drift as a row repair without replacing canonical authority", () => {
    const sourceValue = source("lifecycle-shadow-drift");
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [change(
        "task-status",
        sourceValue,
        "update",
        { kind: "task", key: "M001/S01/T01", field: "status" },
        "complete",
      )],
    }));

    assert.deepEqual(planValue.instructions.map((instruction) => instruction.action), [
      "update",
      "adopt-lifecycle",
    ]);
    const rowRepair = planValue.instructions[0];
    assert.ok(rowRepair?.action === "update");
    assert.deepEqual(rowRepair.values, { status: "complete" });
    const lifecycle = planValue.instructions[1];
    assert.ok(lifecycle?.action === "adopt-lifecycle");
    assert.equal(lifecycle.lifecycleAction, "update");
    assert.equal(lifecycle.lifecycleStatus, "completed");
  });

  test("orders hierarchy work, mirrors slice dependencies, and accounts preserves", () => {
    const nested = source("nested");
    const preserved = source("context", "preserved");
    const input = artifact({
      sources: [nested, preserved],
      changes: [
        change("task", nested, "create", { kind: "task", key: "M001/S02/T01" }, {
          id: "T01", title: "Wire API", status: "pending",
        }),
        change("slice-2", nested, "create", { kind: "slice", key: "M001/S02" }, {
          id: "S02", title: "API", depends_on: ["S01"], sketch: false,
        }),
        change("milestone", nested, "create", { kind: "milestone", key: "M001" }, {
          id: "M001", title: "Foundation",
        }),
        change("slice-1", nested, "create", { kind: "slice", key: "M001/S01" }, {
          id: "S01", title: "Core", depends_on: [],
        }),
        change("preserve", preserved, "preserve", { kind: "legacy-artifact", key: ".gsd/CONTEXT.md" }, {
          reason: "readable context only",
        }),
      ],
    });
    const planValue = compileLegacyImportApplicationPlan(input);

    assert.deepEqual(planValue.instructions.map((entry) => `${entry.action}:${entry.targetKey}`), [
      "create:M001",
      "create:M001/S01",
      "create:M001/S02",
      "create:M001/S02/T01",
      "replace-slice-dependencies:M001/S01",
      "replace-slice-dependencies:M001/S02",
      "adopt-lifecycle:M001",
      "adopt-lifecycle:M001/S01",
      "adopt-lifecycle:M001/S02",
      "adopt-lifecycle:M001/S02/T01",
      "seed-quality-gate:M001/S01",
      "seed-quality-gate:M001/S02",
      "preserve:.gsd/CONTEXT.md",
    ]);
    const dependency = planValue.instructions[5];
    assert.ok(dependency?.action === "replace-slice-dependencies");
    assert.deepEqual(dependency.dependsOnSliceIds, ["S01"]);
    assert.deepEqual(planValue.accounting.preserveChangeIds, [
      input.preview.changes.find((entry) => entry.action === "preserve")?.change_id,
    ]);
    assert.deepEqual(planValue.projectionKeys, [
      `legacy-import/${input.preview.preview_id}`,
      "planning/m001",
      "planning/m001/s01",
      "planning/m001/s02",
      "planning/m001/s02/t01",
      "lifecycle/m001",
      "lifecycle/m001/s01",
      "lifecycle/m001/s02",
      "lifecycle/m001/s02/t01",
    ]);
  });

  test("accepts preserve-only and unparsed evidence without treating it as authority", () => {
    const workflow = source("workflow", "preserved");
    const unknown = source("unknown", "unparsed");
    const diagnosisId = hashLegacyImportValue("diagnosis:preserved-workflow");
    const preserve = change(
      "workflow",
      workflow,
      "preserve",
      { kind: "legacy-workflow-run", key: "run-1" },
      { executable: false },
    );
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [workflow, unknown],
      changes: [preserve],
      diagnoses: [{
        diagnosis_id: diagnosisId,
        code: "preserved-workflow",
        severity: "info",
        source_id: workflow.source_id,
        locator: { start_byte: 0, end_byte: 10 },
        raw_value: "workflow",
        message: "Workflow history remains evidence only.",
      }],
      resolutions: [{ diagnosis_id: diagnosisId, disposition: "preserved" }],
    }));

    assert.deepEqual(planValue.instructions.map((instruction) => instruction.action), ["preserve"]);
    assert.deepEqual(planValue.affectedTargets, []);
    assert.deepEqual(planValue.accounting.preserveChangeIds, [preserve.change_id]);
    assert.equal(planValue.accounting.unparsedSourceIds.length, 1);
    assert.deepEqual(planValue.accounting.diagnosisIds, [diagnosisId]);
    assert.deepEqual(planValue.accounting.resolutionIds, [diagnosisId]);
    assert.equal(planValue.eventFacts.preserveCount, 1);
    assert.equal(planValue.eventFacts.unparsedCount, 1);
  });

  test("does not schedule canonical projections for canonical-looking preserve evidence", () => {
    const sourceValue = source("preserved-milestone", "preserved");
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [change("preserved-milestone", sourceValue, "preserve", {
        kind: "milestone", key: "M001",
      }, {
        id: "M001", title: "Evidence only",
      })],
    }));

    assert.deepEqual(planValue.instructions.map((instruction) => instruction.action), ["preserve"]);
    assert.deepEqual(planValue.affectedTargets, []);
    assert.deepEqual(planValue.projectionKeys, [`legacy-import/${planValue.previewId}`]);
  });

  test("refuses unresolved evidence before semantic target mapping", () => {
    const sourceValue = source("blocked");
    const diagnosisId = hashLegacyImportValue("diagnosis:blocked");
    const input = artifact({
      sources: [sourceValue],
      changes: [change(
        "unknown",
        sourceValue,
        "create",
        { kind: "invented-target", key: "one" },
        { invented: true },
      )],
      diagnoses: [{
        diagnosis_id: diagnosisId,
        code: "route-required",
        severity: "blocker",
        source_id: sourceValue.source_id,
        locator: { start_byte: 0, end_byte: 10 },
        raw_value: "ambiguous",
        message: "A route is required.",
      }],
      resolutions: [{ diagnosis_id: diagnosisId, disposition: "requires-user" }],
    });

    applicationError(
      () => compileLegacyImportApplicationPlan(input),
      "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED",
    );
  });

  test("refuses unsupported mappings and internally inconsistent evidence", () => {
    const sourceValue = source("semantic");
    const cases: Array<[string, LegacyImportPreviewChange[], LegacyImportApplicationError["code"]]> = [
      [
        "unknown kind",
        [change("kind", sourceValue, "create", { kind: "invented", key: "one" }, { id: "one" })],
        "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
      ],
      [
        "unknown field",
        [change("field", sourceValue, "update", { kind: "milestone", key: "M001", field: "invented" }, "x")],
        "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
      ],
      [
        "identity field write",
        [change("identity-field", sourceValue, "create", { kind: "milestone", key: "M001", field: "id" }, "M002")],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
      [
        "metadata field write",
        [change("metadata-field", sourceValue, "create", { kind: "task", key: "M001/S01/T01", field: "layout" }, "flat")],
        "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
      ],
      [
        "identity mismatch",
        [change("identity", sourceValue, "create", { kind: "slice", key: "M001/S01" }, { milestone_id: "M002", id: "S01" })],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
      [
        "unequal alias collision",
        [
          change("whole", sourceValue, "create", { kind: "task", key: "M001/S01/T01" }, { id: "T01", objective: "one" }),
          change("field-two", sourceValue, "update", { kind: "task", key: "M001/S01/T01", field: "description" }, "two"),
        ],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
      [
        "unequal lifecycle claims",
        [
          change("status-one", sourceValue, "create", { kind: "task-status", key: "M001/S01/T01" }, "planned"),
          change("status-two", sourceValue, "create", { kind: "task", key: "M001/S01/T01", field: "status" }, "complete"),
        ],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
      [
        "invalid legacy status",
        [change("bad-status", sourceValue, "create", { kind: "task", key: "M001/S01/T01" }, { id: "T01", status: "invented" })],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
      [
        "boolean in a text column",
        [change("boolean-title", sourceValue, "create", { kind: "milestone", key: "M001" }, { id: "M001", title: true })],
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      ],
    ];

    for (const [, changes, code] of cases) {
      applicationError(
        () => compileLegacyImportApplicationPlan(artifact({ sources: [sourceValue], changes })),
        code,
      );
    }

    const wrongParser = change(
      "parser",
      sourceValue,
      "create",
      { kind: "milestone", key: "M001" },
      { id: "M001" },
    );
    wrongParser.provenance = { ...wrongParser.provenance, parser_id: "different" };
    applicationError(
      () => compileLegacyImportApplicationPlan(artifact({ sources: [sourceValue], changes: [wrongParser] })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );

    const outside = change(
      "outside",
      sourceValue,
      "create",
      { kind: "milestone", key: "M001" },
      { id: "M001" },
    );
    outside.raw.locator.end_byte = sourceValue.byte_size + 1;
    applicationError(
      () => compileLegacyImportApplicationPlan(artifact({ sources: [sourceValue], changes: [outside] })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );

    const forgedIdentity = change(
      "forged-id",
      sourceValue,
      "create",
      { kind: "milestone", key: "M001" },
      { id: "M001" },
    );
    forgedIdentity.change_id = hashLegacyImportValue("not-the-change");
    applicationError(
      () => compileLegacyImportApplicationPlan(artifact({ sources: [sourceValue], changes: [forgedIdentity] })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );

    const protectedPath = "/Users/example/private/customer-secret.md";
    const protectedPathError = applicationError(
      () => compileLegacyImportApplicationPlan(artifact({
        sources: [sourceValue],
        changes: [
          change("artifact-one", sourceValue, "create", { kind: "artifact", key: protectedPath }, { content: "one" }),
          change("artifact-two", sourceValue, "update", { kind: "artifact", key: protectedPath, field: "content" }, "two"),
        ],
      })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );
    assert.equal(JSON.stringify(protectedPathError.context).includes(protectedPath), false);
    assert.equal(typeof protectedPathError.context.target_identity_hash, "string");
  });

  test("normalizes JSON and booleans and reverses dependency order for deletes", () => {
    const sourceValue = source("actions");
    const input = artifact({
      sources: [sourceValue],
      changes: [
        change("milestone-delete", sourceValue, "delete", { kind: "milestone", key: "M002" }, null, "complete-snapshot-row-absent"),
        change("slice-delete", sourceValue, "delete", { kind: "slice", key: "M002/S01" }, null, "complete-snapshot-row-absent"),
        change("task-delete", sourceValue, "delete", { kind: "task", key: "M002/S01/T01" }, null, "complete-snapshot-row-absent"),
        change("slice-create", sourceValue, "create", { kind: "slice", key: "M001/S01" }, {
          id: "S01", depends_on: "[\"S03\",\"S02\"]", sketch: true,
        }),
        change("task-booleans", sourceValue, "create", { kind: "task", key: "M001/S01/T01" }, {
          id: "T01",
          blocker_discovered: true,
          escalation_pending: false,
          escalation_awaiting_review: true,
        }),
      ],
    });
    const planValue = compileLegacyImportApplicationPlan(input);
    const create = planValue.instructions.find((entry) => entry.action === "create");
    assert.ok(create?.action === "create");
    assert.equal(create.values.depends, '["S03","S02"]');
    assert.equal(create.values.is_sketch, 1);
    const task = planValue.instructions.find((entry) => entry.targetKey === "M001/S01/T01");
    assert.ok(task?.action === "create");
    assert.equal(task.values.blocker_discovered, 1);
    assert.equal(task.values.escalation_pending, 0);
    assert.equal(task.values.escalation_awaiting_review, 1);
    assert.deepEqual(planValue.instructions.slice(-3).map((entry) => entry.targetKey), [
      "M002/S01/T01", "M002/S01", "M002",
    ]);
    assert.equal(planValue.mutationCounts.deleteSliceDependencies, 1);
  });

  test("produces distinct create, update, delete, and preserve action semantics", () => {
    const sourceValue = source("action-matrix");
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [
        change("decision-create", sourceValue, "create", { kind: "decision", key: "D001" }, {
          id: "D001", decision: "Use SQLite", choice: "SQLite",
        }),
        change("decision-update", sourceValue, "update", {
          kind: "decision", key: "D002", field: "choice",
        }, "PostgreSQL"),
        change("decision-delete", sourceValue, "delete", { kind: "decision", key: "D003" }, null, "complete-snapshot-row-absent"),
        change("decision-preserve", sourceValue, "preserve", {
          kind: "legacy-decision-note", key: "note-1",
        }, { text: "context only" }),
      ],
    }));

    assert.equal(planValue.planSchemaVersion, 2);
    assert.deepEqual(planValue.instructions.map((instruction) => instruction.action), [
      "create-decision-memory", "update-decision-memory", "delete-decision-memory", "preserve",
    ]);
    const update = planValue.instructions[1];
    assert.ok(update?.action === "update-decision-memory");
    assert.equal(update.decisionId, "D002");
    assert.deepEqual(update.values, { choice: "PostgreSQL" });
    const deletion = planValue.instructions[2];
    assert.ok(deletion?.action === "delete-decision-memory");
    assert.deepEqual(planValue.receiptCounts, {
      create: 1, update: 1, delete: 1, preserve: 1, unparsed: 0, unresolved: 0,
    });
    assert.equal(planValue.accounting.preserveChangeIds.length, 1);
  });

  test("hashes path-keyed targets out of bounded event facts", () => {
    const sourceValue = source("protected-artifact");
    const protectedPath = "/Users/example/private/customer-secret.md";
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [change("artifact", sourceValue, "create", {
        kind: "artifact", key: protectedPath,
      }, {
        content: "retained only in the Preview and writer instruction",
      })],
    }));

    assert.equal(JSON.stringify(planValue.eventFacts).includes(protectedPath), false);
    assert.equal(planValue.eventFacts.affectedTargetHashes.length, 1);
    assert.match(planValue.eventFacts.affectedTargetHashes[0]!, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(planValue.affectedTargets[0]?.targetKey, protectedPath);
  });

  test("orders lifecycle adoption by hierarchy depth before unrelated lexical IDs", () => {
    const sourceValue = source("lifecycle-order");
    const planValue = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [
        change("slice-status", sourceValue, "create", { kind: "slice-status", key: "M001/S01" }, "pending"),
        change("task-status", sourceValue, "create", { kind: "task-status", key: "M000/S01/T01" }, "planned"),
        change("milestone-status", sourceValue, "create", { kind: "milestone-status", key: "M999" }, "active"),
      ],
    }));

    assert.deepEqual(
      planValue.instructions.map((instruction) => instruction.targetKind),
      ["milestone-lifecycle", "slice-lifecycle", "task-lifecycle"],
    );
  });

  test("requires complete deterministic assessment authority", () => {
    const sourceValue = source("assessment");
    const partial = artifact({
      sources: [sourceValue],
      changes: [change("partial", sourceValue, "create", {
        kind: "assessment", key: "M001/S01/run-uat",
      }, {
        scope: "run-uat", verdict: "pass", authority: "structured",
      })],
    });
    applicationError(
      () => compileLegacyImportApplicationPlan(partial),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );

    const assessmentRow = (path: string) => ({
      milestone_id: "M001",
      slice_id: "S01",
      task_id: null,
      scope: "run-uat",
      verdict: "pass",
      authority: "structured",
      path,
      full_content: "# UAT\n\nPass.",
    });
    applicationError(
      () => compileLegacyImportApplicationPlan(artifact({
        sources: [sourceValue],
        changes: [
          change("assessment-one", sourceValue, "create", {
            kind: "assessment", key: "M001/S01/run-uat",
          }, assessmentRow(".gsd/milestones/M001/slices/S01/UAT.md")),
          change("assessment-two", sourceValue, "create", {
            kind: "assessment", key: "M001/S01/run-uat",
          }, assessmentRow(".gsd/milestones/M001/slices/S01/alternate-UAT.md")),
        ],
      })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );
    applicationError(
      () => compileLegacyImportApplicationPlan(artifact({
        sources: [sourceValue],
        changes: [
          change("assessment-path-one", sourceValue, "create", {
            kind: "assessment", key: "M001/S01/run-uat",
          }, assessmentRow(".gsd/shared-assessment.md")),
          change("assessment-path-two", sourceValue, "create", {
            kind: "assessment", key: "M001/S02/run-uat",
          }, {
            ...assessmentRow(".gsd/shared-assessment.md"),
            slice_id: "S02",
          }),
        ],
      })),
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
    );

    const complete = compileLegacyImportApplicationPlan(artifact({
      sources: [sourceValue],
      changes: [change("complete", sourceValue, "create", {
        kind: "assessment", key: "M001/S01/run-uat",
      }, assessmentRow(".gsd/milestones/M001/slices/S01/UAT.md"))],
    }));
    const assessment = complete.instructions[0];
    assert.ok(assessment?.action === "create");
    assert.equal(assessment.targetKind, "assessment");
    assert.equal(assessment.identity.path, ".gsd/milestones/M001/slices/S01/UAT.md");
    assert.equal(assessment.values.status, "pass");
  });
});
