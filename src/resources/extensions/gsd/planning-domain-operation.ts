// Project/App: gsd-pi
// File Purpose: Shared atomic Domain Operation seam for planning commands.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationEventInput,
  type DomainOperationProjectionInput,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { PlanningInvocation } from "./planning-invocation.js";

export class PlanningGuardError extends Error {}

export interface PlanningDomainOperationInput {
  operationType: string;
  invocation: PlanningInvocation;
  actorId?: string;
  payload: DomainJsonValue;
  event: DomainOperationEventInput;
  projection: DomainOperationProjectionInput;
  mutate(context: Readonly<DomainOperationContext>): void;
}

export function planningOperationPayload(value: unknown): DomainJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("planning operation payload must be JSON-compatible");
  return JSON.parse(serialized) as DomainJsonValue;
}

export function executePlanningDomainOperation(
  input: PlanningDomainOperationInput,
): DomainOperationResult {
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  const actorId = input.invocation.actorId ?? input.actorId;
  return executeDomainOperation({
    operationType: input.operationType,
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(actorId ? { actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: input.payload,
  }, (context) => {
    input.mutate(context);
    return {
      events: [input.event],
      projections: [input.projection],
    };
  });
}
