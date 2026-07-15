// Project/App: gsd-pi
// File Purpose: Context-bound canonical Milestone validation writes.

import { createHash, randomUUID } from "node:crypto";

import {
  canonicalDomainJson,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export type MilestoneValidationEvidenceClass = "command" | "runtime" | "browser" | "artifact";
export type MilestoneValidationVerdict = "pass" | "fail" | "inconclusive";
export type MilestoneValidationObservation = "passed" | "failed" | "inconclusive";

export interface MilestoneValidationWaiverWriteInput {
  waiverId: string;
  lifecycleId: string;
  activeWaiverId?: string;
  rationale: string;
  actorId: string | null;
  grantedAt: string;
}

export function writeMilestoneValidationWaiver(
  context: Readonly<DomainOperationContext>,
  input: MilestoneValidationWaiverWriteInput,
): void {
  if (requireActiveDomainOperationContext(context) !== "milestone.validation.waive") {
    throw new Error("Milestone validation Waiver requires a milestone.validation.waive Domain Operation");
  }
  if (input.activeWaiverId) {
    getDb().prepare(`
      UPDATE workflow_waivers
      SET waiver_status = 'revoked', ended_at = :ended_at,
          ended_operation_id = :operation_id,
          ended_project_revision = :project_revision,
          ended_authority_epoch = :authority_epoch
      WHERE waiver_id = :waiver_id AND waiver_status = 'active'
    `).run({
      ":ended_at": input.grantedAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":waiver_id": input.activeWaiverId,
    });
  }
  getDb().prepare(`
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :waiver_id, :project_id, :lifecycle_id, NULL, NULL,
      'active', 'milestone-validation', :rationale, 'policy',
      :actor_id, :granted_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":waiver_id": input.waiverId,
    ":project_id": context.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":rationale": input.rationale,
    ":actor_id": input.actorId,
    ":granted_at": input.grantedAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
}

export interface MilestoneValidationCriterionWriteInput {
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  description: string;
  required: boolean;
  requirementId?: string;
}

export interface PreparedMilestoneValidationCriterion {
  criterionId: string;
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  required: boolean;
  requirementId?: string;
}

interface PrepareMilestoneValidationAttemptInput {
  milestoneId: string;
  criteria: MilestoneValidationCriterionWriteInput[];
  claimedAt?: string;
}

interface PrepareMilestoneValidationAttemptResult {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  attemptNumber: number;
  retryOfAttemptId: string | null;
  criteria: PreparedMilestoneValidationCriterion[];
}

interface SettleMilestoneValidationAttemptInput {
  attemptId: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  endedAt?: string;
}

interface SettleMilestoneValidationAttemptResult {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  outcome: SettleMilestoneValidationAttemptInput["outcome"];
  endedAt: string;
}

export interface MilestoneValidationEvidenceWriteInput {
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

interface MilestoneValidationCriterionResultWriteInput {
  criterionId: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: MilestoneValidationEvidenceWriteInput[];
}

interface InsertMilestoneValidationVerdictsInput {
  attemptId: string;
  testedSourceRevision: string;
  policyId: string;
  policyVersion: string;
  verdict: MilestoneValidationVerdict;
  criterionResults: MilestoneValidationCriterionResultWriteInput[];
  createdAt?: string;
}

export interface InsertedMilestoneValidationVerdict {
  criterionId: string;
  verdictId: string;
  verdict: MilestoneValidationVerdict;
  evidenceIds: string[];
}

interface InsertMilestoneValidationVerdictsResult {
  milestoneId: string;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  verdict: MilestoneValidationVerdict;
  verdicts: InsertedMilestoneValidationVerdict[];
}

interface ValidateMilestoneCriterionWriteInput
  extends MilestoneValidationCriterionWriteInput {
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: MilestoneValidationEvidenceWriteInput[];
}

export interface ValidateMilestoneWriteInput {
  milestoneId: string;
  testedSourceRevision: string;
  policyId: string;
  policyVersion: string;
  verdict: MilestoneValidationVerdict;
  criteria: ValidateMilestoneCriterionWriteInput[];
  outcome: SettleMilestoneValidationAttemptInput["outcome"];
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
}

export type ValidateMilestoneWriteResult =
  & PrepareMilestoneValidationAttemptResult
  & SettleMilestoneValidationAttemptResult
  & InsertMilestoneValidationVerdictsResult;

interface LifecycleRow {
  lifecycle_id: string;
  lifecycle_status: string;
}

interface AttemptRow {
  attempt_id: string;
  attempt_number: number;
  attempt_state: string;
}

interface CurrentCriterionRow {
  criterion_id: string;
  criterion_key: string;
  requirement_id: string | null;
  evidence_class: MilestoneValidationEvidenceClass;
  required: number;
  description: string;
}

interface SettledAttemptScope {
  attempt_id: string;
  lifecycle_id: string;
  milestone_id: string;
  result_id: string;
  result_outcome: string;
  settle_project_revision: number;
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
}

function requireTimestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
  return value;
}

function changedRows(result: unknown): number {
  return typeof (result as { changes?: unknown })?.changes === "number"
    ? (result as { changes: number }).changes
    : 0;
}

function requireMilestoneLifecycle(
  context: Readonly<DomainOperationContext>,
  milestoneId: string,
): LifecycleRow {
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
  }) as unknown as LifecycleRow | undefined;
  if (!lifecycle) throw new Error("Milestone validation lifecycle is missing");
  if (lifecycle.lifecycle_status !== "ready" && lifecycle.lifecycle_status !== "in_progress") {
    throw new Error(`Milestone validation requires a ready or in_progress lifecycle, found ${lifecycle.lifecycle_status}`);
  }
  return lifecycle;
}

function currentCriterion(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  input: MilestoneValidationCriterionWriteInput,
): CurrentCriterionRow | undefined {
  return getDb().prepare(`
    SELECT criterion_id, criterion_key, requirement_id, evidence_class, required, description
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.project_id = :project_id
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_key = :criterion_key
      AND criterion.requirement_id IS :requirement_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":criterion_key": input.criterionKey,
    ":requirement_id": input.requirementId ?? null,
  }) as unknown as CurrentCriterionRow | undefined;
}

function ensureTechnicalCriterion(
  context: Readonly<DomainOperationContext>,
  lifecycleId: string,
  input: MilestoneValidationCriterionWriteInput,
  createdAt: string,
): PreparedMilestoneValidationCriterion {
  const current = currentCriterion(context, lifecycleId, input);
  const unchanged = current &&
    current.evidence_class === input.evidenceClass &&
    Boolean(current.required) === input.required &&
    current.description === input.description;
  if (unchanged) {
    return {
      criterionId: current.criterion_id,
      criterionKey: current.criterion_key,
      evidenceClass: current.evidence_class,
      required: Boolean(current.required),
      ...(current.requirement_id ? { requirementId: current.requirement_id } : {}),
    };
  }

  const criterionId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id, requirement_id,
      criterion_kind, evidence_class, required, description,
      supersedes_criterion_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :criterion_id, :criterion_key, :project_id, :lifecycle_id, :requirement_id,
      'technical', :evidence_class, :required, :description,
      :supersedes_criterion_id, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":criterion_id": criterionId,
    ":criterion_key": input.criterionKey,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycleId,
    ":requirement_id": input.requirementId ?? null,
    ":evidence_class": input.evidenceClass,
    ":required": input.required ? 1 : 0,
    ":description": input.description,
    ":supersedes_criterion_id": current?.criterion_id ?? null,
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    criterionId,
    criterionKey: input.criterionKey,
    evidenceClass: input.evidenceClass,
    required: input.required,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
  };
}

function prepareMilestoneValidationAttemptRows(
  context: Readonly<DomainOperationContext>,
  input: PrepareMilestoneValidationAttemptInput,
): PrepareMilestoneValidationAttemptResult {
  requireNonBlank(input.milestoneId, "milestoneId");
  if (input.criteria.length === 0) throw new Error("Milestone validation requires objective criteria");
  const lifecycle = requireMilestoneLifecycle(context, input.milestoneId);
  const claimedAt = requireTimestamp(input.claimedAt ?? new Date().toISOString(), "claimedAt");
  const requestedCriteria = new Set(input.criteria.map((criterion) =>
    `${criterion.criterionKey}\u0000${criterion.requirementId ?? ""}`
  ));
  for (const criterion of currentTechnicalCriteria(context.projectId, lifecycle.lifecycle_id)) {
    const identity = `${criterion.criterion_key}\u0000${criterion.requirement_id ?? ""}`;
    if (Boolean(criterion.required) && !requestedCriteria.has(identity)) {
      ensureTechnicalCriterion(context, lifecycle.lifecycle_id, {
        criterionKey: criterion.criterion_key,
        evidenceClass: criterion.evidence_class,
        description: criterion.description,
        required: false,
        ...(criterion.requirement_id ? { requirementId: criterion.requirement_id } : {}),
      }, claimedAt);
    }
  }
  const criteria = input.criteria.map((criterion) =>
    ensureTechnicalCriterion(context, lifecycle.lifecycle_id, criterion, claimedAt)
  );
  const prior = getDb().prepare(`
    SELECT attempt_id, attempt_number, attempt_state
    FROM workflow_execution_attempts
    WHERE project_id = :project_id AND lifecycle_id = :lifecycle_id
    ORDER BY attempt_number DESC LIMIT 1
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycle.lifecycle_id,
  }) as unknown as AttemptRow | undefined;
  if (prior && prior.attempt_state !== "settled") {
    throw new Error("Milestone validation lifecycle already has an active Attempt");
  }

  const attemptId = randomUUID();
  const attemptNumber = (prior?.attempt_number ?? 0) + 1;
  const retryOfAttemptId = prior?.attempt_id ?? null;
  getDb().prepare(`
    INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token,
      claimed_at, started_at, ended_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch,
      settle_operation_id, settle_project_revision, settle_authority_epoch
    ) VALUES (
      :attempt_id, :project_id, :lifecycle_id, :attempt_number, :retry_of_attempt_id,
      'claimed', NULL, NULL, NULL,
      :claimed_at, NULL, NULL,
      :operation_id, :project_revision, :authority_epoch,
      NULL, NULL, NULL
    )
  `).run({
    ":attempt_id": attemptId,
    ":project_id": context.projectId,
    ":lifecycle_id": lifecycle.lifecycle_id,
    ":attempt_number": attemptNumber,
    ":retry_of_attempt_id": retryOfAttemptId,
    ":claimed_at": claimedAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    milestoneId: input.milestoneId,
    lifecycleId: lifecycle.lifecycle_id,
    attemptId,
    attemptNumber,
    retryOfAttemptId,
    criteria,
  };
}

function settleMilestoneValidationAttemptRows(
  context: Readonly<DomainOperationContext>,
  input: SettleMilestoneValidationAttemptInput,
): SettleMilestoneValidationAttemptResult {
  requireNonBlank(input.attemptId, "attemptId");
  requireNonBlank(input.failureClass, "failureClass");
  const endedAt = requireTimestamp(input.endedAt ?? new Date().toISOString(), "endedAt");
  const attempt = getDb().prepare(`
    SELECT attempt.lifecycle_id, attempt.attempt_state, attempt.claimed_at,
           lifecycle.milestone_id
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    WHERE attempt.project_id = :project_id
      AND attempt.attempt_id = :attempt_id
      AND lifecycle.item_kind = 'milestone'
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
  `).get({
    ":project_id": context.projectId,
    ":attempt_id": input.attemptId,
  }) as Record<string, unknown> | undefined;
  if (!attempt) throw new Error("Milestone validation Attempt is missing");
  if (attempt["attempt_state"] !== "claimed") {
    throw new Error("Milestone validation settlement requires a claimed Attempt");
  }
  if (Date.parse(endedAt) < Date.parse(String(attempt["claimed_at"]))) {
    throw new Error("endedAt must not precede claimedAt");
  }

  const updated = getDb().prepare(`
    UPDATE workflow_execution_attempts
    SET attempt_state = 'settled', ended_at = :ended_at,
        settle_outcome = :outcome,
        settle_operation_id = :operation_id,
        settle_project_revision = :project_revision,
        settle_authority_epoch = :authority_epoch
    WHERE project_id = :project_id
      AND attempt_id = :attempt_id
      AND attempt_state = 'claimed'
  `).run({
    ":ended_at": endedAt,
    ":outcome": input.outcome,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
    ":project_id": context.projectId,
    ":attempt_id": input.attemptId,
  });
  if (changedRows(updated) !== 1) throw new Error("Milestone validation settlement did not update one Attempt");

  const resultId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_attempt_results (
      result_id, project_id, lifecycle_id, attempt_id, outcome,
      failure_class, summary, output_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :result_id, :project_id, :lifecycle_id, :attempt_id, :outcome,
      :failure_class, :summary, :output_json, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":result_id": resultId,
    ":project_id": context.projectId,
    ":lifecycle_id": attempt["lifecycle_id"],
    ":attempt_id": input.attemptId,
    ":outcome": input.outcome,
    ":failure_class": input.failureClass,
    ":summary": input.summary,
    ":output_json": canonicalDomainJson(input.output),
    ":created_at": endedAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return {
    milestoneId: String(attempt["milestone_id"]),
    lifecycleId: String(attempt["lifecycle_id"]),
    attemptId: input.attemptId,
    resultId,
    outcome: input.outcome,
    endedAt,
  };
}

function requireSettledAttemptScope(
  context: Readonly<DomainOperationContext>,
  attemptId: string,
): SettledAttemptScope {
  const scope = getDb().prepare(`
    SELECT attempt.attempt_id, attempt.lifecycle_id, lifecycle.milestone_id,
           result.result_id, result.outcome AS result_outcome,
           attempt.settle_project_revision
    FROM workflow_execution_attempts attempt
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    WHERE attempt.project_id = :project_id
      AND attempt.attempt_id = :attempt_id
      AND attempt.attempt_state = 'settled'
      AND lifecycle.item_kind = 'milestone'
      AND lifecycle.slice_id IS NULL
      AND lifecycle.task_id IS NULL
  `).get({
    ":project_id": context.projectId,
    ":attempt_id": attemptId,
  }) as unknown as SettledAttemptScope | undefined;
  if (!scope) throw new Error("Milestone validation recording requires a settled Milestone Attempt Result");
  return scope;
}

function currentTechnicalCriteria(projectId: string, lifecycleId: string): CurrentCriterionRow[] {
  return getDb().prepare(`
    SELECT criterion_id, criterion_key, requirement_id, evidence_class, required, description
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.project_id = :project_id
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_kind = 'technical'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
    ORDER BY criterion.criterion_key, criterion.criterion_id
  `).all({
    ":project_id": projectId,
    ":lifecycle_id": lifecycleId,
  }) as unknown as CurrentCriterionRow[];
}

function aggregateVerdict(results: MilestoneValidationCriterionResultWriteInput[]): MilestoneValidationVerdict {
  if (results.some((result) => result.verdict === "fail")) return "fail";
  if (results.some((result) => result.verdict === "inconclusive")) return "inconclusive";
  return "pass";
}

function validateEvidence(
  criterion: CurrentCriterionRow,
  result: MilestoneValidationCriterionResultWriteInput,
): void {
  requireNonBlank(result.rationale, "criterion rationale");
  if (result.evidence.length === 0) throw new Error("each criterion verdict requires evidence");
  for (const evidence of result.evidence) {
    if (evidence.evidenceClass !== criterion.evidence_class) {
      throw new Error(`evidence class does not match criterion ${criterion.criterion_key}`);
    }
    requireNonBlank(evidence.commandOrTool, "evidence commandOrTool");
    requireNonBlank(evidence.workingDirectory, "evidence workingDirectory");
    requireNonBlank(evidence.durableOutputRef, "evidence durableOutputRef");
    requireTimestamp(evidence.startedAt, "evidence startedAt");
    requireTimestamp(evidence.endedAt, "evidence endedAt");
    if (Date.parse(evidence.endedAt) < Date.parse(evidence.startedAt)) {
      throw new Error("evidence endedAt must not precede startedAt");
    }
    if (Object.keys(evidence.environment).length === 0) {
      throw new Error("evidence environment must not be empty");
    }
    if (evidence.evidenceClass === "command") {
      if (evidence.exitCode === undefined) {
        throw new Error("command evidence requires an exit code");
      }
      if (evidence.observation === "passed" && evidence.exitCode !== 0) {
        throw new Error("passing command evidence requires exit code 0");
      }
    }
  }
  const observations = result.evidence.map((evidence) => evidence.observation);
  if (result.verdict === "pass" && observations.some((observation) => observation !== "passed")) {
    throw new Error("passing criterion evidence must all be passed");
  }
  if (result.verdict === "fail" && !observations.includes("failed")) {
    throw new Error("failing criterion evidence must include a failed observation");
  }
  if (result.verdict === "inconclusive" && (
    observations.includes("failed") || !observations.includes("inconclusive")
  )) {
    throw new Error("inconclusive criterion evidence must include inconclusive and no failed observation");
  }
}

function insertEvidence(
  context: Readonly<DomainOperationContext>,
  scope: SettledAttemptScope,
  criterion: CurrentCriterionRow,
  verdictId: string,
  testedSourceRevision: string,
  evidence: MilestoneValidationEvidenceWriteInput,
  createdAt: string,
): string {
  const evidenceId = randomUUID();
  const payload: DomainJsonValue = {
    evidenceClass: evidence.evidenceClass,
    commandOrTool: evidence.commandOrTool,
    workingDirectory: evidence.workingDirectory,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    observation: evidence.observation,
    durableOutputRef: evidence.durableOutputRef,
    environment: evidence.environment,
  };
  if (evidence.exitCode !== undefined) payload["exitCode"] = evidence.exitCode;
  const contentHash = `sha256:${createHash("sha256").update(canonicalDomainJson(payload)).digest("hex")}`;
  getDb().prepare(`
    INSERT INTO workflow_verification_evidence (
      evidence_id, project_id, verdict_id, criterion_id, lifecycle_id, attempt_id,
      evidence_class, command_or_tool, working_directory, started_at, ended_at,
      exit_code, observation, source_revision, observed_project_revision,
      content_hash, durable_output_ref, environment_json, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :evidence_id, :project_id, :verdict_id, :criterion_id, :lifecycle_id, :attempt_id,
      :evidence_class, :command_or_tool, :working_directory, :started_at, :ended_at,
      :exit_code, :observation, :source_revision, :observed_project_revision,
      :content_hash, :durable_output_ref, :environment_json, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":evidence_id": evidenceId,
    ":project_id": context.projectId,
    ":verdict_id": verdictId,
    ":criterion_id": criterion.criterion_id,
    ":lifecycle_id": scope.lifecycle_id,
    ":attempt_id": scope.attempt_id,
    ":evidence_class": evidence.evidenceClass,
    ":command_or_tool": evidence.commandOrTool,
    ":working_directory": evidence.workingDirectory,
    ":started_at": evidence.startedAt,
    ":ended_at": evidence.endedAt,
    ":exit_code": evidence.exitCode ?? null,
    ":observation": evidence.observation,
    ":source_revision": testedSourceRevision,
    ":observed_project_revision": scope.settle_project_revision,
    ":content_hash": contentHash,
    ":durable_output_ref": evidence.durableOutputRef,
    ":environment_json": canonicalDomainJson(evidence.environment),
    ":created_at": createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return evidenceId;
}

function insertMilestoneValidationVerdicts(
  context: Readonly<DomainOperationContext>,
  input: InsertMilestoneValidationVerdictsInput,
): InsertMilestoneValidationVerdictsResult {
  requireNonBlank(input.attemptId, "attemptId");
  requireNonBlank(input.testedSourceRevision, "testedSourceRevision");
  requireNonBlank(input.policyId, "policyId");
  requireNonBlank(input.policyVersion, "policyVersion");
  const scope = requireSettledAttemptScope(context, input.attemptId);
  const criteria = currentTechnicalCriteria(context.projectId, scope.lifecycle_id);
  const byId = new Map(criteria.map((criterion) => [criterion.criterion_id, criterion]));
  const suppliedIds = new Set<string>();
  for (const result of input.criterionResults) {
    if (suppliedIds.has(result.criterionId)) throw new Error("criterion results must not contain duplicates");
    suppliedIds.add(result.criterionId);
    const criterion = byId.get(result.criterionId);
    if (!criterion) throw new Error("criterion result must reference a current technical criterion");
    validateEvidence(criterion, result);
  }
  const missingRequired = criteria.filter((criterion) => Boolean(criterion.required) && !suppliedIds.has(criterion.criterion_id));
  if (missingRequired.length > 0) {
    throw new Error("Milestone validation must cover all required current technical criteria");
  }
  if (input.criterionResults.length === 0) throw new Error("Milestone validation requires criterion results");
  if (aggregateVerdict(input.criterionResults) !== input.verdict) {
    throw new Error("Milestone validation aggregate verdict does not match its criterion verdicts");
  }
  if (input.verdict === "pass" && scope.result_outcome !== "succeeded") {
    throw new Error("passing Milestone validation requires a succeeded Attempt Result");
  }
  const alreadyRecorded = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_technical_verdicts
    WHERE project_id = :project_id
      AND lifecycle_id = :lifecycle_id
      AND attempt_id = :attempt_id
      AND tested_source_revision = :source_revision
    LIMIT 1
  `).get({
    ":project_id": context.projectId,
    ":lifecycle_id": scope.lifecycle_id,
    ":attempt_id": input.attemptId,
    ":source_revision": input.testedSourceRevision,
  });
  if (alreadyRecorded) throw new Error("Milestone validation Attempt already has a verdict for this source revision");

  const createdAt = requireTimestamp(input.createdAt ?? new Date().toISOString(), "createdAt");
  const verdicts = input.criterionResults.map((result): InsertedMilestoneValidationVerdict => {
    const criterion = byId.get(result.criterionId)!;
    const verdictId = randomUUID();
    getDb().prepare(`
      INSERT INTO workflow_technical_verdicts (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, verdict, policy_id, policy_version, rationale,
        supersedes_verdict_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (
        :verdict_id, :project_id, :criterion_id, :lifecycle_id, :attempt_id,
        :source_revision, :verdict, :policy_id, :policy_version, :rationale,
        NULL, :created_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":verdict_id": verdictId,
      ":project_id": context.projectId,
      ":criterion_id": result.criterionId,
      ":lifecycle_id": scope.lifecycle_id,
      ":attempt_id": input.attemptId,
      ":source_revision": input.testedSourceRevision,
      ":verdict": result.verdict,
      ":policy_id": input.policyId,
      ":policy_version": input.policyVersion,
      ":rationale": result.rationale,
      ":created_at": createdAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    const evidenceIds = result.evidence.map((evidence) =>
      insertEvidence(
        context,
        scope,
        criterion,
        verdictId,
        input.testedSourceRevision,
        evidence,
        createdAt,
      )
    );
    return { criterionId: result.criterionId, verdictId, verdict: result.verdict, evidenceIds };
  });
  return {
    milestoneId: scope.milestone_id,
    lifecycleId: scope.lifecycle_id,
    attemptId: input.attemptId,
    resultId: scope.result_id,
    verdict: input.verdict,
    verdicts,
  };
}

export function writeMilestoneValidation(
  context: Readonly<DomainOperationContext>,
  input: ValidateMilestoneWriteInput,
): ValidateMilestoneWriteResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.validate") {
    throw new Error("Combined Milestone validation requires a milestone.validate Domain Operation");
  }
  const prepared = prepareMilestoneValidationAttemptRows(context, {
    milestoneId: input.milestoneId,
    criteria: input.criteria.map((criterion) => ({
      criterionKey: criterion.criterionKey,
      evidenceClass: criterion.evidenceClass,
      description: criterion.description,
      required: criterion.required,
      ...(criterion.requirementId ? { requirementId: criterion.requirementId } : {}),
    })),
  });
  const settled = settleMilestoneValidationAttemptRows(context, {
    attemptId: prepared.attemptId,
    outcome: input.outcome,
    failureClass: input.failureClass,
    summary: input.summary,
    output: input.output,
  });
  const inserted = insertMilestoneValidationVerdicts(context, {
    attemptId: prepared.attemptId,
    testedSourceRevision: input.testedSourceRevision,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    verdict: input.verdict,
    criterionResults: prepared.criteria.map((criterion, index) => {
      const result = input.criteria[index]!;
      return {
        criterionId: criterion.criterionId,
        verdict: result.verdict,
        rationale: result.rationale,
        evidence: result.evidence,
      };
    }),
  });
  return {
    ...prepared,
    ...settled,
    ...inserted,
  };
}
