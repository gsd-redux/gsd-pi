// Project/App: gsd-pi
// File Purpose: Replay-safe, evidence-gated forward lifecycle-shadow repair.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  getLifecycleShadowRepairCandidate,
  type LifecycleShadowRepairCandidate,
  type LifecycleShadowRepairEvidence,
  type LifecycleShadowRepairIdentity,
} from "./db/queries.js";
import {
  readDomainOperationFence,
  repairLifecycleShadowStep,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

type RepairStep = "adopt" | "advance" | "complete" | "unresolved";
type RepairDisposition = "advanced" | "repaired" | "unresolved";

interface StoredRepairPayload {
  item: LifecycleShadowRepairIdentity;
  beforeStatus: CanonicalLifecycleStatus | null;
  afterStatus: CanonicalLifecycleStatus | null;
  targetStatus: "completed" | null;
  disposition: RepairDisposition;
  evidence: LifecycleShadowRepairEvidence | null;
  comparison: LifecycleShadowRepairCandidate["comparison"];
  reason: string | null;
}

interface RepairStepReceipt {
  operation: DomainOperationResult;
  payload: StoredRepairPayload;
}

let beforeCommitHook: (() => void) | null = null;

export function _setLifecycleShadowRepairBeforeCommitForTest(hook: (() => void) | null): void {
  beforeCommitHook = hook;
}

export interface LifecycleShadowRepairReceipt {
  status: DomainOperationResult["status"];
  operationId: string;
  resultingRevision: number;
  disposition: RepairDisposition;
  beforeStatus: CanonicalLifecycleStatus | null;
  afterStatus: CanonicalLifecycleStatus | null;
  targetStatus: "completed" | null;
  evidence: LifecycleShadowRepairEvidence | null;
  comparison: LifecycleShadowRepairCandidate["comparison"];
  reason: string | null;
}

function requireText(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${field} must not be blank`);
  return normalized;
}

function normalizeIdentity(identity: LifecycleShadowRepairIdentity): LifecycleShadowRepairIdentity {
  const milestoneId = requireText(identity.milestoneId, "milestoneId");
  if (identity.itemKind === "milestone") {
    if (identity.sliceId !== undefined || identity.taskId !== undefined) {
      throw new Error("milestone repair identity cannot include sliceId or taskId");
    }
    return { itemKind: "milestone", milestoneId };
  }
  const sliceId = requireText(identity.sliceId, "sliceId");
  if (identity.itemKind === "slice") {
    if (identity.taskId !== undefined) throw new Error("slice repair identity cannot include taskId");
    return { itemKind: "slice", milestoneId, sliceId };
  }
  if (identity.itemKind !== "task") throw new Error("invalid lifecycle repair item kind");
  return {
    itemKind: "task",
    milestoneId,
    sliceId,
    taskId: requireText(identity.taskId, "taskId"),
  };
}

function entityId(item: LifecycleShadowRepairIdentity): string {
  return [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
}

function operationKey(invocation: ExecutionInvocation, step: RepairStep): string {
  return `${invocation.idempotencyKey}:${step}`;
}

function operationExists(invocation: ExecutionInvocation, step: RepairStep): boolean {
  return readDomainOperationFence(operationKey(invocation, step)).replay;
}

function eventType(disposition: RepairDisposition): string {
  if (disposition === "advanced") return "lifecycle.shadow.advanced";
  if (disposition === "repaired") return "lifecycle.shadow.repaired";
  return "lifecycle.shadow.unresolved";
}

function projectionKey(item: LifecycleShadowRepairIdentity): string {
  return `lifecycle-shadow-repair/${entityId(item)}`.toLowerCase();
}

function requestPayload(item: LifecycleShadowRepairIdentity, step: RepairStep): DomainJsonValue {
  return { item: item as unknown as DomainJsonValue, step };
}

function requireStableCandidate(
  expected: LifecycleShadowRepairCandidate,
  actual: LifecycleShadowRepairCandidate,
): void {
  if (
    expected.legacyStatus !== actual.legacyStatus ||
    expected.canonicalStatus !== actual.canonicalStatus ||
    expected.canonicalLastOperationId !== actual.canonicalLastOperationId ||
    expected.targetStatus !== actual.targetStatus ||
    expected.evidence?.evidenceDigest !== actual.evidence?.evidenceDigest ||
    JSON.stringify(expected.comparison) !== JSON.stringify(actual.comparison)
  ) {
    throw new Error("lifecycle shadow repair requires stable durable completion evidence and before state");
  }
}

function executeRepairStep(input: {
  invocation: ExecutionInvocation;
  item: LifecycleShadowRepairIdentity;
  step: RepairStep;
  targetStatus: "in_progress" | "completed" | null;
  disposition: RepairDisposition;
  priorRepairOperationId?: string;
}): RepairStepReceipt {
  const idempotencyKey = operationKey(input.invocation, input.step);
  const fence = readDomainOperationFence(idempotencyKey);
  const expectedCandidate = getLifecycleShadowRepairCandidate(input.item);
  if (!expectedCandidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(input.item)}`);
  beforeCommitHook?.();
  const operation = executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: requestPayload(input.item, input.step),
  }, (context) => {
    const candidate = getLifecycleShadowRepairCandidate(input.item);
    if (!candidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(input.item)}`);
    requireStableCandidate(expectedCandidate, candidate);
    let afterStatus = candidate.canonicalStatus;
    if (input.targetStatus !== null) {
      if (!candidate.evidence) throw new Error("lifecycle shadow repair requires durable completion evidence");
      afterStatus = repairLifecycleShadowStep(context, {
        ...input.item,
        expectedBeforeStatus: candidate.canonicalStatus,
        targetStatus: input.targetStatus,
        ...(input.priorRepairOperationId
          ? { priorRepairOperationId: input.priorRepairOperationId }
          : {}),
      }).lifecycleStatus;
    }
    const payload: StoredRepairPayload = {
      item: input.item,
      beforeStatus: candidate.canonicalStatus,
      afterStatus,
      targetStatus: candidate.targetStatus,
      disposition: input.disposition,
      evidence: candidate.evidence,
      comparison: candidate.comparison,
      reason: candidate.reason,
    };
    return {
      events: [{
        eventType: eventType(input.disposition),
        entityType: input.item.itemKind,
        entityId: entityId(input.item),
        payload: payload as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: projectionKey(input.item),
        projectionKind: "lifecycle-shadow-repair",
        rendererVersion: "1",
      }],
    };
  });
  const stored = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).all({
    ":operation_id": operation.operationId,
    ":event_type": eventType(input.disposition),
  });
  if (stored.length !== 1) throw new Error("lifecycle shadow repair receipt requires exactly one event");
  return {
    operation,
    payload: JSON.parse(String(stored[0]!["payload_json"])) as StoredRepairPayload,
  };
}

function toReceipt(step: RepairStepReceipt): LifecycleShadowRepairReceipt {
  return {
    status: step.operation.status,
    operationId: step.operation.operationId,
    resultingRevision: step.operation.resultingRevision,
    disposition: step.payload.disposition,
    beforeStatus: step.payload.beforeStatus,
    afterStatus: step.payload.afterStatus,
    targetStatus: step.payload.targetStatus,
    evidence: step.payload.evidence,
    comparison: step.payload.comparison,
    reason: step.payload.reason,
  };
}

function singleStepReceipt(input: Parameters<typeof executeRepairStep>[0]): LifecycleShadowRepairReceipt {
  return toReceipt(executeRepairStep(input));
}

function replayExistingRepair(
  invocation: ExecutionInvocation,
  item: LifecycleShadowRepairIdentity,
): LifecycleShadowRepairReceipt | null {
  if (operationExists(invocation, "adopt")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "adopt",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (operationExists(invocation, "unresolved")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "unresolved",
      targetStatus: null,
      disposition: "unresolved",
    });
  }
  if (operationExists(invocation, "complete")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (operationExists(invocation, "advance")) {
    return singleStepReceipt({
      invocation,
      item,
      step: "advance",
      targetStatus: "in_progress",
      disposition: "advanced",
    });
  }
  return null;
}

function isMatchingTaskAdvanceReceipt(
  operationId: string | null,
  item: LifecycleShadowRepairIdentity,
): operationId is string {
  if (!operationId || item.itemKind !== "task") return false;
  return Boolean(getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_operations operation
    JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
    WHERE operation.operation_id = :operation_id
      AND operation.operation_type = 'lifecycle.shadow.repair'
      AND event.event_type = 'lifecycle.shadow.advanced'
      AND event.entity_type = 'task'
      AND event.entity_id = :entity_id
      AND json_extract(event.payload_json, '$.afterStatus') = 'in_progress'
  `).get({
    ":operation_id": operationId,
    ":entity_id": entityId(item),
  }));
}

export function repairLifecycleShadowForward(input: {
  invocation: ExecutionInvocation;
  item: LifecycleShadowRepairIdentity;
}): LifecycleShadowRepairReceipt {
  const item = normalizeIdentity(input.item);
  const replay = replayExistingRepair(input.invocation, item);
  if (replay) return replay;

  const candidate = getLifecycleShadowRepairCandidate(item);
  if (!candidate) throw new Error(`lifecycle shadow repair item not found: ${entityId(item)}`);
  if (!candidate.evidence || candidate.targetStatus !== "completed") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "unresolved",
      targetStatus: null,
      disposition: "unresolved",
    });
  }
  if (candidate.canonicalStatus === null) {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "adopt",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  if (candidate.canonicalStatus === "ready" && item.itemKind === "task") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "advance",
      targetStatus: "in_progress",
      disposition: "advanced",
    });
  }
  if (
    candidate.canonicalStatus === "in_progress" &&
    isMatchingTaskAdvanceReceipt(candidate.canonicalLastOperationId, item)
  ) {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
      priorRepairOperationId: candidate.canonicalLastOperationId,
    });
  }
  if (candidate.canonicalStatus === "ready" && item.itemKind === "slice") {
    return singleStepReceipt({
      invocation: input.invocation,
      item,
      step: "complete",
      targetStatus: "completed",
      disposition: "repaired",
    });
  }
  return singleStepReceipt({
    invocation: input.invocation,
    item,
    step: "unresolved",
    targetStatus: null,
    disposition: "unresolved",
  });
}
