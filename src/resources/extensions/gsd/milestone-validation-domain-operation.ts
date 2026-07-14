// Project/App: gsd-pi
// File Purpose: Durable Milestone validation preparation, settlement, and evidence receipt operations.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  insertMilestoneValidationVerdicts,
  prepareMilestoneValidationAttempt,
  settleMilestoneValidationAttempt,
  type InsertedMilestoneValidationVerdict,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
  type PreparedMilestoneValidationCriterion,
  type PrepareMilestoneValidationAttemptResult,
  type SettleMilestoneValidationAttemptResult,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export interface MilestoneValidationCriterionInput {
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  description: string;
  required?: boolean;
  requirementId?: string;
}

export interface PrepareMilestoneValidationInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  criteria: MilestoneValidationCriterionInput[];
}

export interface SettleMilestoneValidationInput {
  invocation: ExecutionInvocation;
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
}

export interface MilestoneValidationEvidenceInput {
  evidenceClass: MilestoneValidationEvidenceClass;
  commandOrTool: string;
  workingDirectory: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  observation: MilestoneValidationObservation;
  durableOutputRef: string;
  environment: { [key: string]: DomainJsonValue };
}

export interface MilestoneValidationCriterionResultInput {
  criterionId: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: MilestoneValidationEvidenceInput[];
}

export interface RecordMilestoneValidationInput {
  invocation: ExecutionInvocation;
  attemptId: string;
  testedSourceRevision: string;
  policyId: string;
  policyVersion: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  criterionResults: MilestoneValidationCriterionResultInput[];
}

interface OperationReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

export interface PrepareMilestoneValidationReceipt extends OperationReceipt {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  criteria: PreparedMilestoneValidationCriterion[];
}

export interface SettleMilestoneValidationReceipt extends OperationReceipt {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  outcome: SettleMilestoneValidationInput["outcome"];
  endedAt: string;
}

export interface RecordMilestoneValidationReceipt extends OperationReceipt {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  testedSourceRevision: string;
  verdict: MilestoneValidationVerdict;
  verdicts: InsertedMilestoneValidationVerdict[];
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationReceipt(operation: DomainOperationResult): OperationReceipt {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
  };
}

function storedEventPayload(operationId: string, eventType: string): Record<string, unknown> {
  const event = getDb().prepare(`
    SELECT payload_json
    FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).get({
    ":operation_id": operationId,
    ":event_type": eventType,
  }) as Record<string, unknown> | undefined;
  if (!event) throw new Error(`Milestone validation receipt is missing ${eventType}`);
  const payload = JSON.parse(String(event["payload_json"])) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Milestone validation receipt ${eventType} payload is invalid`);
  }
  return payload as Record<string, unknown>;
}

function storedPrepared(operationId: string): PrepareMilestoneValidationAttemptResult {
  const payload = storedEventPayload(operationId, "milestone.validation.prepared");
  return {
    milestoneId: String(payload["milestoneId"]),
    lifecycleId: String(payload["lifecycleId"]),
    attemptId: String(payload["attemptId"]),
    attemptNumber: Number(payload["attemptNumber"]),
    retryOfAttemptId: payload["retryOfAttemptId"] === null
      ? null
      : String(payload["retryOfAttemptId"]),
    criteria: payload["criteria"] as PreparedMilestoneValidationCriterion[],
  };
}

function storedSettlement(operationId: string): SettleMilestoneValidationAttemptResult {
  const payload = storedEventPayload(operationId, "milestone.validation.settled");
  return {
    milestoneId: String(payload["milestoneId"]),
    lifecycleId: String(payload["lifecycleId"]),
    attemptId: String(payload["attemptId"]),
    resultId: String(payload["resultId"]),
    outcome: String(payload["outcome"]) as SettleMilestoneValidationAttemptResult["outcome"],
    endedAt: String(payload["endedAt"]),
  };
}

function storedValidation(operationId: string): Omit<RecordMilestoneValidationReceipt, keyof OperationReceipt> {
  const payload = storedEventPayload(operationId, "milestone.validation.recorded");
  return {
    milestoneId: String(payload["milestoneId"]),
    lifecycleId: String(payload["lifecycleId"]),
    attemptId: String(payload["attemptId"]),
    resultId: String(payload["resultId"]),
    testedSourceRevision: String(payload["testedSourceRevision"]),
    verdict: String(payload["overallVerdict"]) as MilestoneValidationVerdict,
    verdicts: payload["verdicts"] as InsertedMilestoneValidationVerdict[],
  };
}

export function prepareMilestoneValidation(
  input: PrepareMilestoneValidationInput,
): PrepareMilestoneValidationReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  if (input.criteria.length === 0) throw new Error("Milestone validation requires objective criteria");
  const seen = new Set<string>();
  const criteria = input.criteria.map((criterion) => {
    const criterionKey = requireNonBlank(criterion.criterionKey, "criterionKey").toLowerCase();
    const description = requireNonBlank(criterion.description, "criterion description");
    const requirementId = criterion.requirementId === undefined
      ? undefined
      : requireNonBlank(criterion.requirementId, "requirementId");
    const identity = `${criterionKey}\u0000${requirementId ?? ""}`;
    if (seen.has(identity)) throw new Error("Milestone validation criteria must not contain duplicates");
    seen.add(identity);
    return {
      criterionKey,
      evidenceClass: criterion.evidenceClass,
      description,
      required: criterion.required ?? true,
      ...(requirementId ? { requirementId } : {}),
    };
  }).sort((left, right) => {
    const leftKey = `${left.criterionKey}\u0000${left.requirementId ?? ""}`;
    const rightKey = `${right.criterionKey}\u0000${right.requirementId ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let prepared: PrepareMilestoneValidationAttemptResult | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.validation.prepare",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: { milestoneId, criteria },
  }, (context) => {
    prepared = prepareMilestoneValidationAttempt(context, { milestoneId, criteria });
    return {
      events: [{
        eventType: "milestone.validation.prepared",
        entityType: "milestone",
        entityId: milestoneId,
        payload: {
          milestoneId,
          lifecycleId: prepared.lifecycleId,
          attemptId: prepared.attemptId,
          attemptNumber: prepared.attemptNumber,
          retryOfAttemptId: prepared.retryOfAttemptId,
          criteria: prepared.criteria.map((criterion) => ({ ...criterion })),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `validation/${milestoneId}`.toLowerCase(),
        projectionKind: "milestone-validation",
        rendererVersion: "1",
      }],
    };
  });
  const stored = prepared ?? storedPrepared(operation.operationId);
  return { ...operationReceipt(operation), ...stored };
}

export function settleMilestoneValidation(
  input: SettleMilestoneValidationInput,
): SettleMilestoneValidationReceipt {
  const attemptId = requireNonBlank(input.attemptId, "attemptId");
  const failureClass = requireNonBlank(input.failureClass, "failureClass");
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let settled: SettleMilestoneValidationAttemptResult | undefined;
  const operation = executeDomainOperation({
    operationType: "attempt.settle",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      purpose: "milestone-validation",
      attemptId,
      outcome: input.outcome,
      failureClass,
      summary: input.summary,
      output: input.output,
    },
  }, (context) => {
    settled = settleMilestoneValidationAttempt(context, {
      attemptId,
      outcome: input.outcome,
      failureClass,
      summary: input.summary,
      output: input.output,
    });
    return {
      events: [{
        eventType: "milestone.validation.settled",
        entityType: "milestone",
        entityId: settled.milestoneId,
        payload: { ...settled },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `validation/${settled.milestoneId}`.toLowerCase(),
        projectionKind: "milestone-validation",
        rendererVersion: "1",
      }],
    };
  });
  const stored = settled ?? storedSettlement(operation.operationId);
  return { ...operationReceipt(operation), ...stored };
}

export function recordMilestoneValidation(
  input: RecordMilestoneValidationInput,
): RecordMilestoneValidationReceipt {
  const attemptId = requireNonBlank(input.attemptId, "attemptId");
  const testedSourceRevision = requireNonBlank(input.testedSourceRevision, "testedSourceRevision");
  const policyId = requireNonBlank(input.policyId, "policyId");
  const policyVersion = requireNonBlank(input.policyVersion, "policyVersion");
  const rationale = requireNonBlank(input.rationale, "rationale");
  const criterionResults = input.criterionResults.map((result) => ({
    criterionId: requireNonBlank(result.criterionId, "criterionId"),
    verdict: result.verdict,
    rationale: requireNonBlank(result.rationale, "criterion rationale"),
    evidence: result.evidence,
  }));
  const criterionResultsPayload = criterionResults.map((result) => ({
    criterionId: result.criterionId,
    verdict: result.verdict,
    rationale: result.rationale,
    evidence: result.evidence.map((evidence) => ({
      evidenceClass: evidence.evidenceClass,
      commandOrTool: evidence.commandOrTool,
      workingDirectory: evidence.workingDirectory,
      startedAt: evidence.startedAt,
      endedAt: evidence.endedAt,
      ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }),
      observation: evidence.observation,
      durableOutputRef: evidence.durableOutputRef,
      environment: evidence.environment,
    })),
  }));
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let recorded: Omit<RecordMilestoneValidationReceipt, keyof OperationReceipt> | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.validate",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      attemptId,
      testedSourceRevision,
      policyId,
      policyVersion,
      verdict: input.verdict,
      rationale,
      criterionResults: criterionResultsPayload,
    },
  }, (context) => {
    const inserted = insertMilestoneValidationVerdicts(context, {
      attemptId,
      testedSourceRevision,
      policyId,
      policyVersion,
      verdict: input.verdict,
      criterionResults,
    });
    recorded = {
      milestoneId: inserted.milestoneId,
      lifecycleId: inserted.lifecycleId,
      attemptId,
      resultId: inserted.resultId,
      testedSourceRevision,
      verdict: inserted.verdict,
      verdicts: inserted.verdicts,
    };
    return {
      events: [{
        eventType: "milestone.validation.recorded",
        entityType: "milestone",
        entityId: inserted.milestoneId,
        payload: {
          milestoneId: inserted.milestoneId,
          lifecycleId: inserted.lifecycleId,
          attemptId,
          resultId: inserted.resultId,
          testedSourceRevision,
          overallVerdict: inserted.verdict,
          policyId,
          policyVersion,
          rationale,
          criterionIds: inserted.verdicts.map((verdict) => verdict.criterionId),
          verdictIds: inserted.verdicts.map((verdict) => verdict.verdictId),
          evidenceIds: inserted.verdicts.flatMap((verdict) => verdict.evidenceIds),
          humanAcceptanceIds: [],
          verdicts: inserted.verdicts.map((verdict) => ({
            criterionId: verdict.criterionId,
            verdictId: verdict.verdictId,
            verdict: verdict.verdict,
            evidenceIds: verdict.evidenceIds,
          })),
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `validation/${inserted.milestoneId}`.toLowerCase(),
        projectionKind: "milestone-validation",
        rendererVersion: "1",
      }],
    };
  });
  return {
    ...operationReceipt(operation),
    ...(recorded ?? storedValidation(operation.operationId)),
  };
}
