// Project/App: gsd-pi
// File Purpose: One strict read-only validator for durable Import Application evidence.

import { canonicalDomainJson, type DomainJsonValue } from "./db/domain-operation.js";
import { getDb, readTransaction } from "./db/engine.js";
import {
  LEGACY_IMPORT_APPLICATION_EVENT_TYPE,
  LEGACY_IMPORT_APPLICATION_OPERATION_TYPE,
  LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
} from "./legacy-import-application.js";
import {
  compileLegacyImportApplicationPlan,
  legacyImportProjectionKind,
  type LegacyImportApplicationPlan,
} from "./legacy-import-application-plan.js";
import {
  canonicalLegacyImportJson,
  isValidLegacyImportPreviewArtifact,
  type LegacyImportPreviewArtifact,
} from "./legacy-import-preview.js";
import type { LegacyImportSha256 } from "./legacy-import-contract.js";

type DbRow = Record<string, unknown>;

export class LegacyImportApplicationEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyImportApplicationEvidenceError";
  }
}

export interface LegacyImportApplicationEvidence {
  readonly projectId: string;
  readonly projectRootRealpath: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly sourceTransport: string;
  readonly traceId: string | null;
  readonly turnId: string | null;
  readonly baseProjectRevision: number;
  readonly resultingProjectRevision: number;
  readonly baseAuthorityEpoch: number;
  readonly resultingAuthorityEpoch: number;
  readonly createdAt: string;
  readonly applicationIdentityHash: LegacyImportSha256;
  readonly previewInputHash: LegacyImportSha256;
  readonly backupArtifactHash: LegacyImportSha256;
  readonly backupId: LegacyImportSha256;
  readonly applicationRelevantRowsHash: LegacyImportSha256;
  readonly preview: Readonly<LegacyImportPreviewArtifact>;
  readonly plan: Readonly<LegacyImportApplicationPlan>;
  readonly backupRef: string;
  readonly backupSha256: LegacyImportSha256;
  readonly backupByteSize: number;
  readonly backupSchemaVersion: number;
  readonly backupProjectRevision: number;
  readonly backupAuthorityEpoch: number;
  readonly backupQuickCheck: "ok";
  readonly backupVerifiedAt: string;
  readonly eventId: string;
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
}

function invalid(message: string): never {
  throw new LegacyImportApplicationEvidenceError(message);
}

function isPlainRecord(value: unknown): value is DbRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is DbRow {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === keys.length
    && keys.every((key) => (
      Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ));
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`Import Application ${field} is invalid`);
  }
  return value;
}

function nullableNonBlank(value: unknown, field: string): string | null {
  return value === null ? null : nonBlank(value, field);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`Import Application ${field} is invalid`);
  return value;
}

function hash(value: unknown, field: string): LegacyImportSha256 {
  const result = nonBlank(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) invalid(`Import Application ${field} is invalid`);
  return result as LegacyImportSha256;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`Import Application ${field} is invalid`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonNegativeInteger(value, field);
  if (result < 1) invalid(`Import Application ${field} is invalid`);
  return result;
}

function parsePayload(value: unknown): DbRow {
  try {
    const parsed = JSON.parse(String(value));
    if (isPlainRecord(parsed)) return parsed;
  } catch {
    // Normalized below.
  }
  return invalid("Import Application event payload is invalid");
}

function parsePreview(row: DbRow): LegacyImportPreviewArtifact {
  const previewJson = nonBlank(row["preview_json"], "Preview JSON");
  let preview: unknown;
  try {
    preview = JSON.parse(previewJson);
  } catch {
    return invalid("Import Application Preview JSON is malformed");
  }
  const artifact = { preview, preview_hash: hash(row["preview_hash"], "Preview hash") };
  if (!isValidLegacyImportPreviewArtifact(artifact)) {
    return invalid("Import Application Preview identity is invalid");
  }
  if (canonicalLegacyImportJson(artifact.preview) !== previewJson) {
    return invalid("Import Application Preview JSON is not canonical");
  }
  return artifact;
}

function applicationRow(operationId: string): DbRow {
  const row = getDb().prepare(`
    SELECT authority.project_root_realpath,
           operation.project_id, operation.operation_id, operation.idempotency_key,
           operation.expected_revision, operation.resulting_revision,
           operation.expected_authority_epoch, operation.resulting_authority_epoch,
           operation.actor_type, operation.actor_id, operation.source_transport,
           operation.trace_id, operation.turn_id, operation.request_hash,
           operation.created_at,
           application.import_kind, application.importer_version,
           application.preview_schema_version, application.preview_id,
           application.preview_hash, application.base_project_revision,
           application.base_authority_epoch, application.base_database_schema_version,
           application.source_set_hash, application.change_set_hash,
           application.create_count, application.update_count, application.delete_count,
           application.preserve_count, application.unparsed_count, application.unresolved_count,
           application.preview_json, application.backup_ref,
           application.backup_sha256, application.backup_byte_size,
           application.backup_schema_version, application.backup_project_revision,
           application.backup_authority_epoch, application.backup_quick_check,
           application.backup_verified_at, application.applied_at,
           application.resulting_project_revision, application.resulting_authority_epoch
             AS application_resulting_authority_epoch,
           event.event_id, event.payload_json
    FROM workflow_operations operation
    JOIN project_authority authority ON authority.project_id = operation.project_id
    JOIN workflow_import_applications application
      ON application.operation_id = operation.operation_id
     AND application.project_id = operation.project_id
     AND application.resulting_project_revision = operation.resulting_revision
     AND application.resulting_authority_epoch = operation.resulting_authority_epoch
    JOIN workflow_domain_events event
      ON event.operation_id = operation.operation_id
     AND event.event_index = 0
     AND event.event_type = '${LEGACY_IMPORT_APPLICATION_EVENT_TYPE}'
     AND event.project_id = operation.project_id
     AND event.project_revision = operation.resulting_revision
     AND event.authority_epoch = operation.resulting_authority_epoch
     AND event.entity_type = 'legacy-import'
     AND event.entity_id = application.preview_id
     AND event.caused_by_event_id IS NULL
     AND event.created_at = application.applied_at
    WHERE operation.operation_id = :operation_id
      AND operation.operation_type = '${LEGACY_IMPORT_APPLICATION_OPERATION_TYPE}'
      AND (SELECT COUNT(*) FROM workflow_domain_events all_events
           WHERE all_events.operation_id = operation.operation_id) = 1
  `).get({ ":operation_id": operationId });
  if (!row) invalid("Import Application durable aggregate is missing or inconsistent");
  return row;
}

function validateApplicationRow(row: DbRow): {
  preview: LegacyImportPreviewArtifact;
  plan: LegacyImportApplicationPlan;
  payload: DbRow;
} {
  const preview = parsePreview(row);
  let plan: LegacyImportApplicationPlan;
  try {
    plan = compileLegacyImportApplicationPlan(preview);
  } catch {
    return invalid("Import Application compiled plan is invalid");
  }
  const payload = parsePayload(row["payload_json"]);
  const envelope = preview.preview;
  const receiptMatches = [
    ["import_kind", envelope.import_kind],
    ["importer_version", envelope.importer_version],
    ["preview_schema_version", envelope.preview_schema_version],
    ["preview_id", envelope.preview_id],
    ["base_project_revision", envelope.base_project_revision],
    ["base_authority_epoch", envelope.base_authority_epoch],
    ["base_database_schema_version", envelope.base_database_schema_version],
    ["source_set_hash", envelope.source_set_hash],
    ["change_set_hash", envelope.change_set_hash],
    ["create_count", envelope.counts.create],
    ["update_count", envelope.counts.update],
    ["delete_count", envelope.counts.delete],
    ["preserve_count", envelope.counts.preserve],
    ["unparsed_count", envelope.counts.unparsed],
    ["unresolved_count", envelope.counts.unresolved],
    ["backup_schema_version", envelope.base_database_schema_version],
    ["backup_project_revision", envelope.base_project_revision],
    ["backup_authority_epoch", envelope.base_authority_epoch],
  ].every(([field, expected]) => row[String(field)] === expected);
  const operationMatches = row["request_hash"] === preview.preview_hash
    && row["expected_revision"] === envelope.base_project_revision
    && row["resulting_revision"] === envelope.base_project_revision + 1
    && row["expected_authority_epoch"] === envelope.base_authority_epoch
    && row["resulting_authority_epoch"] === envelope.base_authority_epoch
    && row["resulting_project_revision"] === row["resulting_revision"]
    && row["application_resulting_authority_epoch"] === row["resulting_authority_epoch"]
    && row["applied_at"] === row["created_at"];
  const payloadMatches = hasExactDataKeys(payload, [
    "replayIdentitySchemaVersion",
    "applicationIdentityHash",
    "previewInputHash",
    "backupArtifactHash",
    "backupId",
    "applicationRelevantRowsHash",
    "planSchemaVersion",
    "eventFacts",
    "projectionKeys",
    "instructionResults",
  ])
    && payload["replayIdentitySchemaVersion"]
      === LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION
    && payload["planSchemaVersion"] === plan.planSchemaVersion
    && canonicalDomainJson(payload as DomainJsonValue) === row["payload_json"]
    && canonicalDomainJson(payload["eventFacts"] as DomainJsonValue)
      === canonicalDomainJson(plan.eventFacts as unknown as DomainJsonValue)
    && canonicalDomainJson(payload["projectionKeys"] as DomainJsonValue)
      === canonicalDomainJson([...plan.projectionKeys]);
  if (!receiptMatches || !operationMatches || !payloadMatches) {
    invalid("Import Application durable identity is inconsistent");
  }
  hash(payload["applicationIdentityHash"], "identity hash");
  hash(payload["previewInputHash"], "Preview input hash");
  hash(payload["backupArtifactHash"], "backup artifact hash");
  hash(payload["backupId"], "backup ID");
  return { preview, plan, payload };
}

function validateDelivery(row: DbRow, plan: LegacyImportApplicationPlan): {
  outboxIds: number[];
  projectionWorkIds: string[];
} {
  const operationId = nonBlank(row["operation_id"], "operation ID");
  const outbox = getDb().prepare(`
    SELECT outbox.outbox_id, outbox.event_id, outbox.destination
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id
  `).all({ ":operation_id": operationId });
  const projections = getDb().prepare(`
    SELECT current.projection_work_id, current.project_id, current.projection_key,
           current.projection_kind, current.source_project_revision,
           current.source_authority_epoch, current.renderer_version,
           current.enqueue_operation_id, current.created_at,
           current.supersedes_projection_work_id,
           previous.projection_work_id AS predecessor_id,
           previous.project_id AS predecessor_project_id,
           previous.projection_key AS predecessor_key,
           previous.projection_kind AS predecessor_kind,
           previous.source_project_revision AS predecessor_revision,
           previous.source_authority_epoch AS predecessor_epoch
    FROM workflow_projection_work current
    LEFT JOIN workflow_projection_work previous
      ON previous.projection_work_id = current.supersedes_projection_work_id
    WHERE current.enqueue_operation_id = :operation_id
    ORDER BY current.projection_work_id
  `).all({ ":operation_id": operationId });
  const exactOutbox = outbox.length === 1
    && Number.isSafeInteger(outbox[0]?.["outbox_id"])
    && Number(outbox[0]?.["outbox_id"]) > 0
    && outbox[0]?.["event_id"] === row["event_id"]
    && outbox[0]?.["destination"] === "projection";
  const exactProjections = projections.length === plan.projectionKeys.length
    && plan.projectionKeys.every((projectionKey, index) => {
      const projection = projections[index];
      const projectionKind = legacyImportProjectionKind(projectionKey);
      const predecessorId = projection?.["supersedes_projection_work_id"];
      let predecessorMatches = projection?.["predecessor_id"] === null;
      if (predecessorId !== null) {
        predecessorMatches = typeof predecessorId === "string"
          && projection?.["predecessor_id"] === predecessorId
          && projection?.["predecessor_project_id"] === row["project_id"]
          && projection?.["predecessor_key"] === projectionKey
          && projection?.["predecessor_kind"] === projectionKind
          && Number(projection?.["predecessor_revision"]) < Number(row["resulting_revision"])
          && Number(projection?.["predecessor_epoch"]) <= Number(row["resulting_authority_epoch"]);
      }
      return projection?.["projection_work_id"]
          === `${operationId}:${String(index).padStart(4, "0")}`
        && projection["project_id"] === row["project_id"]
        && projection["projection_key"] === projectionKey
        && projection["projection_kind"] === projectionKind
        && projection["source_project_revision"] === row["resulting_revision"]
        && projection["source_authority_epoch"] === row["resulting_authority_epoch"]
        && projection["renderer_version"] === "v1"
        && projection["enqueue_operation_id"] === operationId
        && projection["created_at"] === row["created_at"]
        && predecessorMatches;
    });
  if (!exactOutbox || !exactProjections) {
    invalid("Import Application delivery lineage is inconsistent");
  }
  return {
    outboxIds: outbox.map((entry) => Number(entry["outbox_id"])),
    projectionWorkIds: projections.map((entry) => String(entry["projection_work_id"])),
  };
}

export function inspectLegacyImportApplicationEvidence(
  operationId: string,
): LegacyImportApplicationEvidence {
  if (typeof operationId !== "string" || operationId.trim().length === 0) {
    throw new LegacyImportApplicationEvidenceError("Import Application operation ID is invalid");
  }
  return readTransaction(() => {
    const row = applicationRow(operationId);
    const { preview, plan, payload } = validateApplicationRow(row);
    const delivery = validateDelivery(row, plan);
    return Object.freeze({
      projectId: nonBlank(row["project_id"], "project ID"),
      projectRootRealpath: text(row["project_root_realpath"], "project root"),
      operationId: nonBlank(row["operation_id"], "operation ID"),
      idempotencyKey: nonBlank(row["idempotency_key"], "idempotency key"),
      actorType: nonBlank(row["actor_type"], "actor type"),
      actorId: nullableNonBlank(row["actor_id"], "actor ID"),
      sourceTransport: nonBlank(row["source_transport"], "source transport"),
      traceId: nullableNonBlank(row["trace_id"], "trace ID"),
      turnId: nullableNonBlank(row["turn_id"], "turn ID"),
      baseProjectRevision: nonNegativeInteger(row["expected_revision"], "base revision"),
      resultingProjectRevision: positiveInteger(row["resulting_revision"], "result revision"),
      baseAuthorityEpoch: nonNegativeInteger(row["expected_authority_epoch"], "base epoch"),
      resultingAuthorityEpoch: nonNegativeInteger(row["resulting_authority_epoch"], "result epoch"),
      createdAt: nonBlank(row["created_at"], "created time"),
      applicationIdentityHash: hash(payload["applicationIdentityHash"], "identity hash"),
      previewInputHash: hash(payload["previewInputHash"], "Preview input hash"),
      backupArtifactHash: hash(payload["backupArtifactHash"], "backup artifact hash"),
      backupId: hash(payload["backupId"], "backup ID"),
      applicationRelevantRowsHash: hash(
        payload["applicationRelevantRowsHash"],
        "Application result rows hash",
      ),
      preview,
      plan,
      backupRef: nonBlank(row["backup_ref"], "backup reference"),
      backupSha256: hash(row["backup_sha256"], "backup SHA-256"),
      backupByteSize: positiveInteger(row["backup_byte_size"], "backup byte size"),
      backupSchemaVersion: positiveInteger(row["backup_schema_version"], "backup schema version"),
      backupProjectRevision: nonNegativeInteger(row["backup_project_revision"], "backup revision"),
      backupAuthorityEpoch: nonNegativeInteger(row["backup_authority_epoch"], "backup epoch"),
      backupQuickCheck: row["backup_quick_check"] === "ok"
        ? "ok"
        : invalid("Import Application backup quick check is invalid"),
      backupVerifiedAt: nonBlank(row["backup_verified_at"], "backup verified time"),
      eventId: nonBlank(row["event_id"], "event ID"),
      outboxIds: Object.freeze(delivery.outboxIds),
      projectionWorkIds: Object.freeze(delivery.projectionWorkIds),
    });
  });
}
