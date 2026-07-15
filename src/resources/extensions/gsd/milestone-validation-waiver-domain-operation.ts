// Project/App: gsd-pi
// File Purpose: Canonical source-bound Milestone validation waiver operation.

import { randomUUID } from "node:crypto";

import { executeDomainOperation, type DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { writeMilestoneValidationWaiver } from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export type MilestoneValidationWaiverReason = "preference" | "trivial-scope";

export interface GrantMilestoneValidationWaiverInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  testedSourceRevision: string;
  reason: MilestoneValidationWaiverReason;
  policyId: string;
  policyVersion: string;
}

export interface MilestoneValidationWaiverReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  milestoneId: string;
  lifecycleId: string;
  waiverId: string;
  testedSourceRevision: string;
  reason: MilestoneValidationWaiverReason;
  policyId: string;
  policyVersion: string;
  grantedAt: string;
}

interface StoredWaiver {
  milestoneId: string;
  lifecycleId: string;
  waiverId: string;
  testedSourceRevision: string;
  reason: MilestoneValidationWaiverReason;
  policyId: string;
  policyVersion: string;
  grantedAt: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be blank`);
  return normalized;
}

function storedWaiver(operationId: string): StoredWaiver {
  const row = getDb().prepare(`
    SELECT event.payload_json
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id
     AND operation.project_id = event.project_id
    WHERE event.operation_id = :operation_id
      AND event.event_type = 'milestone.validation.waived'
      AND operation.operation_type = 'milestone.validation.waive'
  `).get({ ":operation_id": operationId });
  if (!row) throw new Error("Milestone validation waiver receipt is missing");
  const payload = JSON.parse(String(row["payload_json"])) as Record<string, unknown>;
  const reason = payload["reason"];
  if (reason !== "preference" && reason !== "trivial-scope") {
    throw new Error("Milestone validation waiver receipt reason is invalid");
  }
  const text = (field: string): string => {
    const value = payload[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Milestone validation waiver receipt ${field} is invalid`);
    }
    return value;
  };
  return {
    milestoneId: text("milestoneId"),
    lifecycleId: text("lifecycleId"),
    waiverId: text("waiverId"),
    testedSourceRevision: text("testedSourceRevision"),
    reason,
    policyId: text("policyId"),
    policyVersion: text("policyVersion"),
    grantedAt: text("grantedAt"),
  };
}

export function grantMilestoneValidationWaiver(
  input: GrantMilestoneValidationWaiverInput,
): MilestoneValidationWaiverReceipt {
  const milestoneId = requiredText(input.milestoneId, "milestoneId");
  const testedSourceRevision = requiredText(input.testedSourceRevision, "testedSourceRevision");
  const policyId = requiredText(input.policyId, "policyId");
  const policyVersion = requiredText(input.policyVersion, "policyVersion");
  const payload: DomainJsonValue = {
    milestoneId,
    testedSourceRevision,
    reason: input.reason,
    policyId,
    policyVersion,
  };
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let written: StoredWaiver | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.validation.waive",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload,
  }, (context) => {
    const lifecycle = getDb().prepare(`
      SELECT lifecycle_id, lifecycle_status
      FROM workflow_item_lifecycles
      WHERE project_id = :project_id
        AND item_kind = 'milestone'
        AND milestone_id = :milestone_id
        AND slice_id IS NULL
        AND task_id IS NULL
    `).get({
      ":project_id": context.projectId,
      ":milestone_id": milestoneId,
    });
    if (!lifecycle) throw new Error("Milestone validation waiver requires an adopted Milestone");
    if (lifecycle["lifecycle_status"] !== "ready" && lifecycle["lifecycle_status"] !== "in_progress") {
      throw new Error("Milestone validation waiver requires an open Milestone lifecycle");
    }
    const lifecycleId = String(lifecycle["lifecycle_id"]);
    const active = getDb().prepare(`
      SELECT waiver_id
      FROM workflow_waivers
      WHERE project_id = :project_id
        AND lifecycle_id = :lifecycle_id
        AND waiver_status = 'active'
        AND scope = 'milestone-validation'
      ORDER BY project_revision, waiver_id
    `).all({
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
    });
    if (active.length > 1) {
      throw new Error("Milestone validation found multiple active Waivers");
    }
    const grantedAt = new Date().toISOString();
    const waiverId = randomUUID();
    writeMilestoneValidationWaiver(context, {
      waiverId,
      lifecycleId,
      ...(active.length === 1 ? { activeWaiverId: String(active[0]!["waiver_id"]) } : {}),
      rationale: `Milestone validation waived by ${input.reason} policy ${policyId}@${policyVersion}`,
      actorId: input.invocation.actorId ?? null,
      grantedAt,
    });
    written = {
      milestoneId,
      lifecycleId,
      waiverId,
      testedSourceRevision,
      reason: input.reason,
      policyId,
      policyVersion,
      grantedAt,
    };
    return {
      events: [{
        eventType: "milestone.validation.waived",
        entityType: "milestone",
        entityId: milestoneId,
        payload: written as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `validation/${milestoneId}`.toLowerCase(),
        projectionKind: "milestone-validation",
        rendererVersion: "1",
      }],
    };
  });
  const stored = written ?? storedWaiver(operation.operationId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    ...stored,
  };
}
