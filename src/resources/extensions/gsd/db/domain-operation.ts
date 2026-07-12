// Project/App: gsd-pi
// File Purpose: Atomic, revision-checked Domain Operation writer boundary.

import { createHash, randomUUID } from "node:crypto";

import {
  GSD_IDEMPOTENCY_CONFLICT,
  GSD_REVISION_CONFLICT,
  GSDError,
} from "../errors.js";
import { getDb, immediateTransaction, isInTransaction } from "./engine.js";

export type DomainJsonValue =
  | null
  | boolean
  | number
  | string
  | DomainJsonValue[]
  | { [key: string]: DomainJsonValue };

export interface DomainOperationRequest {
  operationType: string;
  idempotencyKey: string;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  actorType: string;
  actorId?: string;
  sourceTransport: string;
  traceId?: string;
  turnId?: string;
  payload: DomainJsonValue;
  advanceAuthorityEpoch?: boolean;
}

export interface DomainOperationEventInput {
  eventType: string;
  entityType: string;
  entityId: string;
  payload: DomainJsonValue;
  destinations: string[];
  causedByEventIndex?: number;
}

export interface DomainOperationProjectionInput {
  projectionKey: string;
  projectionKind: string;
  rendererVersion: string;
}

export interface DomainOperationMutation {
  events: DomainOperationEventInput[];
  projections: DomainOperationProjectionInput[];
}

export interface DomainOperationContext {
  operationId: string;
  projectId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
}

export interface DomainOperationResult {
  status: "committed" | "replayed";
  operationId: string;
  projectId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  requestHash: string;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

export type DomainOperationFaultPoint =
  | "after-operation"
  | "after-mutation"
  | "after-events"
  | "after-outbox"
  | "after-projections"
  | "before-cas"
  | "after-commit";

interface AuthorityRow {
  project_id: string;
  revision: number;
  authority_epoch: number;
}

interface OperationRow {
  operation_id: string;
  project_id: string;
  operation_type: string;
  idempotency_key: string;
  expected_revision: number;
  resulting_revision: number;
  expected_authority_epoch: number;
  resulting_authority_epoch: number;
  actor_type: string;
  actor_id: string | null;
  source_transport: string;
  trace_id: string | null;
  turn_id: string | null;
  request_hash: string;
  created_at: string;
}

let faultPoint: DomainOperationFaultPoint | null = null;

export function _setDomainOperationFaultForTest(point: DomainOperationFaultPoint | null): void {
  faultPoint = point;
}

function hitFault(point: DomainOperationFaultPoint): void {
  if (faultPoint === point) throw new Error(`domain operation fault: ${point}`);
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

export function canonicalDomainJson(value: DomainJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("domain operation JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalDomainJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("domain operation payload must be JSON-compatible");

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("domain operation payload must contain plain JSON objects");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDomainJson(entry)}`).join(",")}}`;
}

function validateRequestScalars(request: DomainOperationRequest): void {
  requireNonBlank(request.operationType, "operationType");
  requireNonBlank(request.idempotencyKey, "idempotencyKey");
  requireNonBlank(request.actorType, "actorType");
  requireNonBlank(request.sourceTransport, "sourceTransport");
  if (request.actorId !== undefined) requireNonBlank(request.actorId, "actorId");
  if (request.traceId !== undefined) requireNonBlank(request.traceId, "traceId");
  if (request.turnId !== undefined) requireNonBlank(request.turnId, "turnId");
  requireNonNegativeSafeInteger(request.expectedRevision, "expectedRevision");
  requireNonNegativeSafeInteger(request.expectedAuthorityEpoch, "expectedAuthorityEpoch");
  if (request.expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new Error("expectedRevision requires safe integer increment headroom");
  }
  if (request.advanceAuthorityEpoch !== undefined && typeof request.advanceAuthorityEpoch !== "boolean") {
    throw new Error("advanceAuthorityEpoch must be a boolean");
  }
  if (request.advanceAuthorityEpoch === true && request.expectedAuthorityEpoch === Number.MAX_SAFE_INTEGER) {
    throw new Error("expectedAuthorityEpoch requires safe integer increment headroom");
  }
}

function requestHash(request: DomainOperationRequest): string {
  const canonical = canonicalDomainJson({
    operationType: request.operationType,
    expectedRevision: request.expectedRevision,
    expectedAuthorityEpoch: request.expectedAuthorityEpoch,
    actorType: request.actorType,
    actorId: request.actorId ?? null,
    sourceTransport: request.sourceTransport,
    traceId: request.traceId ?? null,
    turnId: request.turnId ?? null,
    payload: request.payload,
    advanceAuthorityEpoch: request.advanceAuthorityEpoch === true,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function validateMutation(mutation: DomainOperationMutation): string[] {
  if (mutation.events.length === 0) throw new Error("domain operation requires at least one event");
  if (mutation.projections.length === 0) {
    throw new Error("domain operation requires at least one projection target");
  }
  if (mutation.projections.length > 10_000) {
    throw new Error("domain operation projection limit is 10,000 targets");
  }

  const eventPayloads = mutation.events.map((event, eventIndex) => {
    requireNonBlank(event.eventType, `events[${eventIndex}].eventType`);
    requireNonBlank(event.entityType, `events[${eventIndex}].entityType`);
    requireNonBlank(event.entityId, `events[${eventIndex}].entityId`);
    const payload = canonicalDomainJson(event.payload);
    if (event.destinations.length === 0) {
      throw new Error(`events[${eventIndex}] requires at least one outbox destination`);
    }
    const destinations = new Set<string>();
    for (const destination of event.destinations) {
      requireNonBlank(destination, `events[${eventIndex}].destinations`);
      if (destinations.has(destination)) {
        throw new Error(`events[${eventIndex}] contains duplicate destination ${destination}`);
      }
      destinations.add(destination);
    }
    if (
      event.causedByEventIndex !== undefined &&
      (!Number.isInteger(event.causedByEventIndex) ||
        event.causedByEventIndex < 0 ||
        event.causedByEventIndex >= eventIndex)
    ) {
      throw new Error(`events[${eventIndex}].causedByEventIndex must reference an earlier event`);
    }
    return payload;
  });

  const projectionKeys = new Set<string>();
  mutation.projections.forEach((projection, projectionIndex) => {
    requireNonBlank(projection.projectionKey, `projections[${projectionIndex}].projectionKey`);
    requireNonBlank(projection.projectionKind, `projections[${projectionIndex}].projectionKind`);
    requireNonBlank(projection.rendererVersion, `projections[${projectionIndex}].rendererVersion`);
    if (projection.projectionKey !== projection.projectionKey.trim().toLowerCase()) {
      throw new Error(`projections[${projectionIndex}].projectionKey must be normalized lowercase`);
    }
    if (projection.projectionKind !== projection.projectionKind.trim().toLowerCase()) {
      throw new Error(`projections[${projectionIndex}].projectionKind must be normalized lowercase`);
    }
    if (projectionKeys.has(projection.projectionKey)) {
      throw new Error(`duplicate projection key ${projection.projectionKey}`);
    }
    projectionKeys.add(projection.projectionKey);
  });
  return eventPayloads;
}

function loadReceipt(operation: OperationRow, status: DomainOperationResult["status"]): DomainOperationResult {
  const db = getDb();
  const eventIds = db.prepare(`
    SELECT event_id FROM workflow_domain_events
    WHERE operation_id = :operation_id ORDER BY event_index
  `).all({ ":operation_id": operation.operation_id }).map((row) => String(row["event_id"]));
  const unsafeOutbox = db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      WHERE event.operation_id = :operation_id
        AND outbox.outbox_id > 9007199254740991
    ) AS unsafe
  `).get({ ":operation_id": operation.operation_id });
  if (unsafeOutbox?.["unsafe"] === 1) {
    throw new Error("stored outbox identity exceeds safe integer range");
  }
  const outboxIds = db.prepare(`
    SELECT outbox.outbox_id
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id
  `).all({ ":operation_id": operation.operation_id }).map((row) => Number(row["outbox_id"]));
  const projectionWorkIds = db.prepare(`
    SELECT projection_work_id FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id
  `).all({ ":operation_id": operation.operation_id })
    .map((row) => String(row["projection_work_id"]));

  return {
    status,
    operationId: operation.operation_id,
    projectId: operation.project_id,
    resultingRevision: operation.resulting_revision,
    resultingAuthorityEpoch: operation.resulting_authority_epoch,
    requestHash: operation.request_hash,
    eventIds,
    outboxIds,
    projectionWorkIds,
  };
}

function operationMatchesRequest(
  operation: OperationRow,
  request: DomainOperationRequest,
  hash: string,
): boolean {
  return (
    operation.operation_type === request.operationType &&
    operation.idempotency_key === request.idempotencyKey &&
    operation.request_hash === hash &&
    operation.expected_revision === request.expectedRevision &&
    operation.expected_authority_epoch === request.expectedAuthorityEpoch &&
    operation.actor_type === request.actorType &&
    operation.actor_id === (request.actorId ?? null) &&
    operation.source_transport === request.sourceTransport &&
    operation.trace_id === (request.traceId ?? null) &&
    operation.turn_id === (request.turnId ?? null)
  );
}

function requireReplayMatch(
  operation: OperationRow,
  request: DomainOperationRequest,
  hash: string,
): void {
  if (!operationMatchesRequest(operation, request, hash)) {
    throw new GSDError(
      GSD_IDEMPOTENCY_CONFLICT,
      `domain operation idempotency conflict for key ${request.idempotencyKey}`,
    );
  }
}

function loadOperation(operationId: string): OperationRow | undefined {
  return getDb().prepare(`
    SELECT operation_id, project_id, operation_type, idempotency_key,
           expected_revision, resulting_revision,
           expected_authority_epoch, resulting_authority_epoch,
           actor_type, actor_id, source_transport, trace_id, turn_id, request_hash,
           created_at
    FROM workflow_operations WHERE operation_id = :operation_id
  `).get({ ":operation_id": operationId }) as unknown as OperationRow | undefined;
}

function requireCommittedProvenance(
  operation: OperationRow | undefined,
  request: DomainOperationRequest,
  hash: string,
  context: DomainOperationContext,
  createdAt: string,
): OperationRow {
  if (!operation) throw new Error("domain operation provenance row is missing");
  const matches =
    operationMatchesRequest(operation, request, hash) &&
    operation.operation_id === context.operationId &&
    operation.project_id === context.projectId &&
    operation.resulting_revision === context.resultingRevision &&
    operation.resulting_authority_epoch === context.resultingAuthorityEpoch &&
    operation.created_at === createdAt;
  if (!matches) throw new Error("domain operation provenance changed during mutation");
  return operation;
}

function staleAuthority(request: DomainOperationRequest, authority: AuthorityRow): never {
  if (authority.revision !== request.expectedRevision) {
    throw new GSDError(
      GSD_REVISION_CONFLICT,
      `stale project revision: expected ${request.expectedRevision}, current ${authority.revision}`,
    );
  }
  throw new GSDError(
    GSD_REVISION_CONFLICT,
    `stale authority epoch: expected ${request.expectedAuthorityEpoch}, current ${authority.authority_epoch}`,
  );
}

function isSqliteBusyError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? error);
  return code.includes("SQLITE_BUSY") || /SQLITE_BUSY|database is locked/i.test(message);
}

function runDomainOperationTransaction(fn: () => DomainOperationResult): DomainOperationResult {
  try {
    return immediateTransaction(fn);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new GSDError(
        GSD_REVISION_CONFLICT,
        "domain operation writer contention; retry the request",
        { cause: error },
      );
    }
    throw error;
  }
}

export function executeDomainOperation(
  request: DomainOperationRequest,
  /**
   * Compose deterministic typed writers only. Sibling tables must enforce the
   * supplied operation/revision context through their foreign keys; filesystem,
   * network, routing, retry, and error-swallowing behavior do not belong here.
   */
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  validateRequestScalars(request);
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  const hash = requestHash(request);

  const result = runDomainOperationTransaction((): DomainOperationResult => {
    const db = getDb();
    const authority = db.prepare(`
      SELECT project_id, revision, authority_epoch
      FROM project_authority WHERE singleton = 1
    `).get() as unknown as AuthorityRow | undefined;
    if (!authority) throw new Error("project authority is missing");
    requireNonNegativeSafeInteger(authority.revision, "stored project revision");
    requireNonNegativeSafeInteger(authority.authority_epoch, "stored authority epoch");

    const existing = db.prepare(`
      SELECT operation_id, project_id, operation_type, idempotency_key,
             expected_revision, resulting_revision,
             expected_authority_epoch, resulting_authority_epoch,
             actor_type, actor_id, source_transport, trace_id, turn_id, request_hash,
             created_at
      FROM workflow_operations
      WHERE project_id = :project_id AND idempotency_key = :idempotency_key
    `).get({
      ":project_id": authority.project_id,
      ":idempotency_key": request.idempotencyKey,
    }) as unknown as OperationRow | undefined;
    if (existing) {
      requireReplayMatch(existing, request, hash);
      return loadReceipt(existing, "replayed");
    }

    if (
      authority.revision !== request.expectedRevision ||
      authority.authority_epoch !== request.expectedAuthorityEpoch
    ) {
      staleAuthority(request, authority);
    }

    const now = new Date().toISOString();
    const operationId = randomUUID();
    const resultingRevision = request.expectedRevision + 1;
    const resultingAuthorityEpoch =
      request.expectedAuthorityEpoch + (request.advanceAuthorityEpoch === true ? 1 : 0);
    const context = Object.freeze({
      operationId,
      projectId: authority.project_id,
      resultingRevision,
      resultingAuthorityEpoch,
    });

    db.prepare(`
      INSERT INTO workflow_operations (
        operation_id, project_id, operation_type, idempotency_key,
        expected_revision, resulting_revision,
        expected_authority_epoch, resulting_authority_epoch,
        actor_type, actor_id, source_transport, trace_id, turn_id,
        request_hash, created_at
      ) VALUES (
        :operation_id, :project_id, :operation_type, :idempotency_key,
        :expected_revision, :resulting_revision,
        :expected_authority_epoch, :resulting_authority_epoch,
        :actor_type, :actor_id, :source_transport, :trace_id, :turn_id,
        :request_hash, :created_at
      )
    `).run({
      ":operation_id": operationId,
      ":project_id": authority.project_id,
      ":operation_type": request.operationType,
      ":idempotency_key": request.idempotencyKey,
      ":expected_revision": request.expectedRevision,
      ":resulting_revision": resultingRevision,
      ":expected_authority_epoch": request.expectedAuthorityEpoch,
      ":resulting_authority_epoch": resultingAuthorityEpoch,
      ":actor_type": request.actorType,
      ":actor_id": request.actorId ?? null,
      ":source_transport": request.sourceTransport,
      ":trace_id": request.traceId ?? null,
      ":turn_id": request.turnId ?? null,
      ":request_hash": hash,
      ":created_at": now,
    });
    hitFault("after-operation");

    const mutation = mutate(context);
    const eventPayloads = validateMutation(mutation);
    const storedOperation = requireCommittedProvenance(
      loadOperation(operationId),
      request,
      hash,
      context,
      now,
    );
    hitFault("after-mutation");

    const eventIds: string[] = [];
    mutation.events.forEach((event, eventIndex) => {
      const eventId = randomUUID();
      const causedByEventId =
        event.causedByEventIndex === undefined ? null : eventIds[event.causedByEventIndex];
      db.prepare(`
        INSERT INTO workflow_domain_events (
          event_id, operation_id, event_index, project_id, project_revision,
          authority_epoch, event_type, entity_type, entity_id,
          caused_by_event_id, payload_json, created_at
        ) VALUES (
          :event_id, :operation_id, :event_index, :project_id, :project_revision,
          :authority_epoch, :event_type, :entity_type, :entity_id,
          :caused_by_event_id, :payload_json, :created_at
        )
      `).run({
        ":event_id": eventId,
        ":operation_id": operationId,
        ":event_index": eventIndex,
        ":project_id": authority.project_id,
        ":project_revision": resultingRevision,
        ":authority_epoch": resultingAuthorityEpoch,
        ":event_type": event.eventType,
        ":entity_type": event.entityType,
        ":entity_id": event.entityId,
        ":caused_by_event_id": causedByEventId,
        ":payload_json": eventPayloads[eventIndex],
        ":created_at": now,
      });
      eventIds.push(eventId);
    });
    hitFault("after-events");

    mutation.events.forEach((event, eventIndex) => {
      for (const destination of event.destinations) {
        db.prepare(`
          INSERT INTO workflow_outbox (event_id, destination, available_at)
          VALUES (:event_id, :destination, :available_at)
        `).run({
          ":event_id": eventIds[eventIndex],
          ":destination": destination,
          ":available_at": now,
        });
      }
    });
    hitFault("after-outbox");

    mutation.projections.forEach((projection, projectionIndex) => {
      const previous = db.prepare(`
        SELECT current.projection_work_id
        FROM workflow_projection_work current
        WHERE current.project_id = :project_id
          AND current.projection_key = :projection_key
          AND NOT EXISTS (
            SELECT 1 FROM workflow_projection_work successor
            WHERE successor.supersedes_projection_work_id = current.projection_work_id
          )
      `).get({
        ":project_id": authority.project_id,
        ":projection_key": projection.projectionKey,
      });
      db.prepare(`
        INSERT INTO workflow_projection_work (
          projection_work_id, project_id, projection_key, projection_kind,
          supersedes_projection_work_id, source_project_revision,
          source_authority_epoch, renderer_version, enqueue_operation_id,
          created_at, updated_at
        ) VALUES (
          :projection_work_id, :project_id, :projection_key, :projection_kind,
          :supersedes_projection_work_id, :source_project_revision,
          :source_authority_epoch, :renderer_version, :enqueue_operation_id,
          :created_at, :updated_at
        )
      `).run({
        ":projection_work_id": `${operationId}:${String(projectionIndex).padStart(4, "0")}`,
        ":project_id": authority.project_id,
        ":projection_key": projection.projectionKey,
        ":projection_kind": projection.projectionKind,
        ":supersedes_projection_work_id": previous?.["projection_work_id"] ?? null,
        ":source_project_revision": resultingRevision,
        ":source_authority_epoch": resultingAuthorityEpoch,
        ":renderer_version": projection.rendererVersion,
        ":enqueue_operation_id": operationId,
        ":created_at": now,
        ":updated_at": now,
      });
    });
    hitFault("after-projections");
    hitFault("before-cas");

    const update = db.prepare(`
      UPDATE project_authority
      SET revision = :resulting_revision,
          authority_epoch = :resulting_authority_epoch,
          updated_at = :updated_at
      WHERE singleton = 1
        AND project_id = :project_id
        AND revision = :expected_revision
        AND authority_epoch = :expected_authority_epoch
    `).run({
      ":resulting_revision": resultingRevision,
      ":resulting_authority_epoch": resultingAuthorityEpoch,
      ":updated_at": now,
      ":project_id": authority.project_id,
      ":expected_revision": request.expectedRevision,
      ":expected_authority_epoch": request.expectedAuthorityEpoch,
    });
    const changes =
      typeof (update as { changes?: unknown }).changes === "number"
        ? (update as { changes: number }).changes
        : 0;
    if (changes !== 1) {
      throw new GSDError(GSD_REVISION_CONFLICT, "domain operation authority CAS failed");
    }

    return loadReceipt(storedOperation, "committed");
  });

  hitFault("after-commit");
  return result;
}
