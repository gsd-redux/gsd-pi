// Project/App: gsd-pi
// File Purpose: Regression proof (#1659) that an applied legacy import enqueues lifecycle
// projection work under the canonical lifecycle kinds so post-import closeouts can extend
// the same (key, kind) lineage chain instead of aborting on trg_workflow_projection_lineage.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import { applyLegacyImport } from "../legacy-import-application.ts";
import { legacyImportProjectionKind } from "../legacy-import-application-plan.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { type DbAdapter } from "../db-adapter.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all() as Array<Record<string, unknown>>;
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirectories.clear();
});

test("legacyImportProjectionKind mirrors the canonical lifecycle projection kinds (#1659)", () => {
  assert.equal(legacyImportProjectionKind("lifecycle/m001"), "milestone-lifecycle");
  assert.equal(legacyImportProjectionKind("lifecycle/m001/s01"), "slice-lifecycle");
  assert.equal(legacyImportProjectionKind("lifecycle/m001/s01/t01"), "task-lifecycle");
  assert.equal(legacyImportProjectionKind("planning/m001/s01"), "markdown");
  assert.equal(legacyImportProjectionKind("planning/requirements"), "markdown");
  assert.equal(legacyImportProjectionKind("legacy-import/abc"), "markdown");
});

test("applied import projections use canonical kinds so closeout can extend the chain (#1659)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-projection-lineage-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const destination = join(workspace, "backups");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(destination);
  assert.equal(openDatabase(join(workspace, "canonical.sqlite")), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: destination,
    label: "pre-application",
  });
  const receipt = applyLegacyImport({
    invocation: {
      idempotencyKey: "legacy-import/projection-lineage-1659",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-projection-lineage-test",
      traceId: "projection-lineage-trace",
      turnId: "projection-lineage-turn",
    },
    previewInput,
    preview,
    backup,
  });

  // Every projection the import enqueued must carry the kind the canonical
  // writer for that key family uses — lifecycle keys imported as "markdown"
  // permanently blocked the (key, kind) chain for slice closeout (#1659).
  const importedProjections = rows(`
    SELECT projection_key, projection_kind FROM workflow_projection_work
    WHERE enqueue_operation_id = '${receipt.operationId}'
    ORDER BY projection_work_id
  `);
  assert.ok(importedProjections.length > 0);
  const lifecycleKeys = importedProjections
    .map((row) => String(row["projection_key"]))
    .filter((key) => key.startsWith("lifecycle/"));
  assert.ok(lifecycleKeys.length > 0);
  for (const projection of importedProjections) {
    assert.equal(
      projection["projection_kind"],
      legacyImportProjectionKind(String(projection["projection_key"])),
      `projection kind mismatch for ${String(projection["projection_key"])}`,
    );
  }

  // The load-bearing invariant: a canonical slice-lifecycle enqueue for the
  // same key must now extend the import's head instead of hitting the
  // "projection work must extend the current logical target head" trigger.
  const sliceKey = lifecycleKeys.find((key) => key.split("/").length === 3);
  assert.ok(sliceKey);
  const authority = rows("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1")[0];
  assert.ok(authority);
  executeDomainOperation({
    operationType: "slice.complete",
    idempotencyKey: "projection-lineage-1659/closeout",
    expectedRevision: Number(authority["revision"]),
    expectedAuthorityEpoch: Number(authority["authority_epoch"]),
    actorType: "agent",
    sourceTransport: "test",
    payload: { sliceKey },
  }, () => ({
    events: [{
      eventType: "slice.completed",
      entityType: "slice",
      entityId: sliceKey,
      payload: { closeout: true },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: sliceKey,
      projectionKind: "slice-lifecycle",
      rendererVersion: "v1",
    }],
  }));
  const chain = rows(`
    SELECT projection_kind, supersedes_projection_work_id FROM workflow_projection_work
    WHERE projection_key = '${sliceKey}'
    ORDER BY source_project_revision
  `);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]?.["projection_kind"], "slice-lifecycle");
  assert.equal(chain[1]?.["projection_kind"], "slice-lifecycle");
  assert.notEqual(chain[1]?.["supersedes_projection_work_id"], null);
});
