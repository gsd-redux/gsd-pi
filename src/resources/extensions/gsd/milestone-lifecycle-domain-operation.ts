// Project/App: gsd-pi
// File Purpose: Replay-safe Milestone completion Domain Operation.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  completeMilestoneHierarchy,
  MilestoneLifecycleValidationError,
  type MilestoneCompletionHierarchyResult,
} from "./db/writers/milestone-lifecycle.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { LifecycleShadowRecord } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export { MilestoneLifecycleValidationError };

export interface MilestoneCompletionCloseout {
  title: string;
  oneLiner: string;
  narrative: string;
  successCriteriaResults: string;
  definitionOfDoneResults: string;
  requirementOutcomes: string;
  keyDecisions: string[];
  keyFiles: string[];
  lessonsLearned: string[];
  followUps: string;
  deviations: string;
}

export interface MilestoneCompletionAudit {
  actorName?: string;
  triggerReason?: string;
}

export interface MilestoneCompletionReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  milestoneLifecycleId: string;
  canonicalStatus: "completed";
  legacyStatus: "complete";
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  waiverIds: string[];
  dispositionIds: string[];
  closeout: MilestoneCompletionCloseout;
  isCurrent: boolean;
}

interface StoredCompletionPayload {
  milestoneLifecycleId: string;
  completedAt: string;
  validationEventId: string;
  validationRevision: number;
  completedSliceIds: string[];
  cancelledSliceIds: string[];
  completedTaskIds: string[];
  cancelledTaskIds: string[];
  waiverIds: string[];
  dispositionIds: string[];
  closeout: MilestoneCompletionCloseout;
}

type StoredCompletionAudit = { actorName: string | null; triggerReason: string | null };

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MilestoneLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function normalizedList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedCloseout(closeout: MilestoneCompletionCloseout): MilestoneCompletionCloseout {
  return {
    title: requiredText(closeout.title, "title"),
    oneLiner: requiredText(closeout.oneLiner, "oneLiner"),
    narrative: requiredText(closeout.narrative, "narrative"),
    successCriteriaResults: closeout.successCriteriaResults.trim(),
    definitionOfDoneResults: closeout.definitionOfDoneResults.trim(),
    requirementOutcomes: closeout.requirementOutcomes.trim(),
    keyDecisions: normalizedList(closeout.keyDecisions),
    keyFiles: normalizedList(closeout.keyFiles),
    lessonsLearned: normalizedList(closeout.lessonsLearned),
    followUps: closeout.followUps.trim(),
    deviations: closeout.deviations.trim(),
  };
}

function normalizedAudit(audit?: MilestoneCompletionAudit): StoredCompletionAudit {
  return {
    actorName: audit?.actorName?.trim() || null,
    triggerReason: audit?.triggerReason?.trim() || null,
  };
}

function request(
  invocation: ExecutionInvocation,
  milestoneId: string,
  sourceRevision: string,
  closeout: MilestoneCompletionCloseout,
  audit: StoredCompletionAudit,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType: "milestone.complete",
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: {
      milestoneId,
      sourceRevision,
      closeout: closeout as unknown as DomainJsonValue,
      audit,
    },
  };
}

function shadowPayload(shadow: LifecycleShadowRecord): DomainJsonValue {
  return {
    itemKind: shadow.itemKind,
    milestoneId: shadow.milestoneId,
    sliceId: shadow.sliceId ?? null,
    taskId: shadow.taskId ?? null,
    kind: shadow.kind,
    legacyStatus: shadow.legacyStatus,
    canonicalStatus: shadow.canonicalStatus,
    normalizedLegacyStatus: shadow.normalizedLegacyStatus,
    normalizedCanonicalStatus: shadow.normalizedCanonicalStatus,
  };
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Milestone completion receipt ${field} is corrupt`);
  }
  return value;
}

function numberField(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Milestone completion receipt ${field} is corrupt`);
  }
  return Number(value);
}

function stringArrayField(payload: Record<string, unknown>, field: string): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry) ||
      new Set(value).size !== value.length) {
    throw new Error(`Milestone completion receipt ${field} is corrupt`);
  }
  return value as string[];
}

function storedCompletionPayload(operationId: string): StoredCompletionPayload {
  const events = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'milestone.completed'
  `).all({ ":operation_id": operationId }) as Array<Record<string, unknown>>;
  if (events.length !== 1) throw new Error("Milestone completion receipt requires one durable event");
  const parsed = JSON.parse(String(events[0]!["payload_json"])) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Milestone completion receipt payload is corrupt");
  }
  const payload = parsed as Record<string, unknown>;
  const closeout = payload["closeout"];
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) {
    throw new Error("Milestone completion receipt closeout is corrupt");
  }
  const storedCloseout = closeout as Record<string, unknown>;
  for (const field of ["title", "oneLiner", "narrative", "successCriteriaResults",
    "definitionOfDoneResults", "requirementOutcomes", "followUps", "deviations"]) {
    if (typeof storedCloseout[field] !== "string") {
      throw new Error(`Milestone completion receipt closeout.${field} is corrupt`);
    }
  }
  const normalizedStoredCloseout = {
    ...storedCloseout,
    keyDecisions: stringArrayField(storedCloseout, "keyDecisions"),
    keyFiles: stringArrayField(storedCloseout, "keyFiles"),
    lessonsLearned: stringArrayField(storedCloseout, "lessonsLearned"),
  } as unknown as MilestoneCompletionCloseout;
  return {
    milestoneLifecycleId: stringField(payload, "milestoneLifecycleId"),
    completedAt: stringField(payload, "completedAt"),
    validationEventId: stringField(payload, "validationEventId"),
    validationRevision: numberField(payload, "validationRevision"),
    completedSliceIds: stringArrayField(payload, "completedSliceIds"),
    cancelledSliceIds: stringArrayField(payload, "cancelledSliceIds"),
    completedTaskIds: stringArrayField(payload, "completedTaskIds"),
    cancelledTaskIds: stringArrayField(payload, "cancelledTaskIds"),
    waiverIds: stringArrayField(payload, "waiverIds"),
    dispositionIds: stringArrayField(payload, "dispositionIds"),
    closeout: normalizedStoredCloseout,
  };
}

function isCurrentCompletion(operationId: string, milestoneId: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = :milestone_id
      AND slice_id IS NULL AND task_id IS NULL
      AND lifecycle_status = 'completed' AND last_operation_id = :operation_id
  `).get({ ":milestone_id": milestoneId, ":operation_id": operationId }));
}

export function completeMilestone(input: {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sourceRevision: string;
  closeout: MilestoneCompletionCloseout;
  audit?: MilestoneCompletionAudit;
}): MilestoneCompletionReceipt {
  const milestoneId = requiredText(input.milestoneId, "milestoneId");
  const sourceRevision = requiredText(input.sourceRevision, "sourceRevision");
  const closeout = normalizedCloseout(input.closeout);
  const audit = normalizedAudit(input.audit);
  const operation = executeDomainOperation(
    request(input.invocation, milestoneId, sourceRevision, closeout, audit),
    (context) => {
      const result = completeMilestoneHierarchy(context, { milestoneId, sourceRevision });
      const { shadow, cancellationAuthorizations, ...storedResult } = result;
      return {
        events: [{
          eventType: "milestone.completed",
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            ...storedResult,
            closeout: closeout as unknown as DomainJsonValue,
            audit,
            cancellationAuthorizations: cancellationAuthorizations.map((authorization) => ({
              itemKind: authorization.itemKind,
              sliceId: authorization.sliceId,
              taskId: authorization.taskId ?? null,
              lifecycleId: authorization.lifecycleId,
              waiverId: authorization.waiverId,
              dispositionId: authorization.dispositionId ?? null,
            })),
            lifecycleShadowComparison: shadowPayload(shadow),
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
          projectionKind: "milestone-lifecycle",
          rendererVersion: "1",
        }],
      };
    },
  );
  const stored = storedCompletionPayload(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    milestoneLifecycleId: stored.milestoneLifecycleId,
    canonicalStatus: "completed",
    legacyStatus: "complete",
    completedAt: stored.completedAt,
    validationEventId: stored.validationEventId,
    validationRevision: stored.validationRevision,
    completedSliceIds: stored.completedSliceIds,
    cancelledSliceIds: stored.cancelledSliceIds,
    completedTaskIds: stored.completedTaskIds,
    cancelledTaskIds: stored.cancelledTaskIds,
    waiverIds: stored.waiverIds,
    dispositionIds: stored.dispositionIds,
    closeout: stored.closeout,
    isCurrent: isCurrentCompletion(operation.operationId, milestoneId),
  };
}
