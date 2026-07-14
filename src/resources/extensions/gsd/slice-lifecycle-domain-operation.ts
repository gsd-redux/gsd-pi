// Project/App: gsd-pi
// File Purpose: Replay-safe Slice lifecycle Domain Operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  cancelSliceHierarchy,
  reopenSliceHierarchy,
  SliceLifecycleValidationError,
  type SliceCancellationHierarchyResult,
  type SliceCancellationInterruption,
  type SliceReopenHierarchyResult,
} from "./db/writers/slice-lifecycle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export { SliceLifecycleValidationError };

export interface SliceLifecycleIdentity {
  milestoneId: string;
  sliceId: string;
}

export interface SliceCancellationReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  sliceLifecycleId: string;
  canonicalStatus: "cancelled";
  legacyStatus: "skipped";
  wasAlreadySkipped: boolean;
  tasksSkipped: number;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
}

interface StoredCancellationPayload {
  sliceLifecycleId: string;
  wasAlreadySkipped: boolean;
  cancelledTaskIds: string[];
  preservedTaskIds: string[];
  interruptions: SliceCancellationInterruption[];
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SliceLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function request(
  operationType: "slice.cancel" | "slice.reopen",
  invocation: ExecutionInvocation,
  slice: SliceLifecycleIdentity,
  reason: string,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: {
      slice: { milestoneId: slice.milestoneId, sliceId: slice.sliceId },
      reason,
    },
  };
}

function shadowPayload(
  result: SliceCancellationHierarchyResult | SliceReopenHierarchyResult,
): DomainJsonValue[] {
  return result.shadows.map((shadow) => ({
    itemKind: shadow.itemKind,
    milestoneId: shadow.milestoneId,
    sliceId: shadow.sliceId ?? null,
    taskId: shadow.taskId ?? null,
    kind: shadow.kind,
    legacyStatus: shadow.legacyStatus,
    canonicalStatus: shadow.canonicalStatus,
    normalizedLegacyStatus: shadow.normalizedLegacyStatus,
    normalizedCanonicalStatus: shadow.normalizedCanonicalStatus,
  }));
}

function storedPayload(operationId: string): StoredCancellationPayload {
  const event = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'slice.cancelled'
  `).all({ ":operation_id": operationId }) as Array<Record<string, unknown>>;
  if (event.length !== 1) throw new Error("Slice cancellation receipt requires one durable event");
  return JSON.parse(String(event[0]!["payload_json"])) as StoredCancellationPayload;
}

export function cancelSlice(input: {
  invocation: ExecutionInvocation;
  slice: SliceLifecycleIdentity;
  reason: string;
}): SliceCancellationReceipt {
  const slice = {
    milestoneId: requireText(input.slice.milestoneId, "milestoneId"),
    sliceId: requireText(input.slice.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const operation = executeDomainOperation(request("slice.cancel", input.invocation, slice, reason), (context) => {
    const result = cancelSliceHierarchy(context, { ...slice, reason });
    return {
      events: [{
        eventType: "slice.cancelled",
        entityType: "slice",
        entityId: `${slice.milestoneId}/${slice.sliceId}`,
        payload: {
          sliceLifecycleId: result.sliceLifecycleId,
          reason,
          wasAlreadySkipped: result.wasAlreadySkipped,
          cancelledTaskIds: result.cancelledTaskIds,
          preservedTaskIds: result.preservedTaskIds,
          interruptions: result.interruptions.map((interruption) => ({ ...interruption })),
          lifecycleShadowComparisons: shadowPayload(result),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${slice.milestoneId}/${slice.sliceId}`.toLowerCase(),
        projectionKind: "slice-lifecycle",
        rendererVersion: "1",
      }],
    };
  });
  const stored = storedPayload(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    sliceLifecycleId: stored.sliceLifecycleId,
    canonicalStatus: "cancelled",
    legacyStatus: "skipped",
    wasAlreadySkipped: stored.wasAlreadySkipped,
    tasksSkipped: stored.cancelledTaskIds.length,
    cancelledTaskIds: stored.cancelledTaskIds,
    preservedTaskIds: stored.preservedTaskIds,
    interruptions: stored.interruptions,
  };
}

export interface SliceReopenReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  sliceLifecycleId: string;
  canonicalStatus: "ready";
  legacyStatus: "in_progress";
  tasksReset: number;
  reopenedTaskIds: string[];
}

export function reopenSlice(input: {
  invocation: ExecutionInvocation;
  slice: SliceLifecycleIdentity;
  reason: string;
}): SliceReopenReceipt {
  const slice = {
    milestoneId: requireText(input.slice.milestoneId, "milestoneId"),
    sliceId: requireText(input.slice.sliceId, "sliceId"),
  };
  const reason = requireText(input.reason, "reason");
  const operation = executeDomainOperation(request("slice.reopen", input.invocation, slice, reason), (context) => {
    const result = reopenSliceHierarchy(context, { ...slice, reason });
    return {
      events: [{
        eventType: "slice.reopened",
        entityType: "slice",
        entityId: `${slice.milestoneId}/${slice.sliceId}`,
        payload: {
          sliceLifecycleId: result.sliceLifecycleId,
          reason,
          reopenedTaskIds: result.reopenedTaskIds,
          lifecycleShadowComparisons: shadowPayload(result),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `lifecycle/${slice.milestoneId}/${slice.sliceId}`.toLowerCase(),
        projectionKind: "slice-lifecycle",
        rendererVersion: "1",
      }],
    };
  });
  const event = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'slice.reopened'
  `).all({ ":operation_id": operation.operationId }) as Array<Record<string, unknown>>;
  if (event.length !== 1) throw new Error("Slice reopen receipt requires one durable event");
  const stored = JSON.parse(String(event[0]!["payload_json"])) as {
    sliceLifecycleId: string;
    reopenedTaskIds: string[];
  };
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    sliceLifecycleId: stored.sliceLifecycleId,
    canonicalStatus: "ready",
    legacyStatus: "in_progress",
    tasksReset: stored.reopenedTaskIds.length,
    reopenedTaskIds: stored.reopenedTaskIds,
  };
}
