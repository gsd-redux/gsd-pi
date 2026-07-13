// Project/App: gsd-pi
// File Purpose: Context-bound acceptance criterion, Technical Verdict, and evidence writes.

import { createHash, randomUUID } from "node:crypto";

import {
  canonicalDomainJson,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

const HOST_TECHNICAL_CRITERION_KEY = "host-technical-verification";

export interface HostTechnicalAttemptScope {
  projectId: string;
  lifecycleId: string;
  attemptId: string;
  settleProjectRevision: number;
}

export interface HostTechnicalEvidenceInput {
  evidenceClass: "command";
  commandOrTool: string;
  workingDirectory: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  observation: "passed" | "failed" | "inconclusive";
  durableOutputRef: string;
  environment: { [key: string]: DomainJsonValue };
}

export interface HostTechnicalVerdictWriteInput {
  scope: HostTechnicalAttemptScope;
  criterionId: string;
  testedSourceRevision: string;
  verdict: "pass" | "fail" | "inconclusive";
  rationale: string;
  evidence: HostTechnicalEvidenceInput;
  createdAt: string;
}

export function currentHostTechnicalCriterionId(projectId: string, lifecycleId: string): string | undefined {
  const current = getDb().prepare(`
    SELECT criterion.criterion_id
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.project_id = :project_id
      AND criterion.lifecycle_id = :lifecycle_id
      AND criterion.criterion_key = :criterion_key
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
  `).get({
    ":project_id": projectId,
    ":lifecycle_id": lifecycleId,
    ":criterion_key": HOST_TECHNICAL_CRITERION_KEY,
  });
  return current ? String(current["criterion_id"]) : undefined;
}

export function ensureHostTechnicalCriterion(
  context: Readonly<DomainOperationContext>,
  input: { projectId: string; lifecycleId: string },
): void {
  if (requireActiveDomainOperationContext(context) !== "attempt.claim") {
    throw new Error("Host verification criterion creation requires an attempt.claim Domain Operation");
  }
  if (currentHostTechnicalCriterionId(input.projectId, input.lifecycleId)) return;

  getDb().prepare(`
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id,
      criterion_kind, evidence_class, required, description, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      :criterion_id, :criterion_key, :project_id, :lifecycle_id,
      'technical', 'command', 1, :description, :created_at,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":criterion_id": randomUUID(),
    ":criterion_key": HOST_TECHNICAL_CRITERION_KEY,
    ":project_id": input.projectId,
    ":lifecycle_id": input.lifecycleId,
    ":description": "Host-owned technical verification must pass before Task completion publication.",
    ":created_at": new Date().toISOString(),
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
}

export function insertHostTechnicalVerdict(
  context: Readonly<DomainOperationContext>,
  input: HostTechnicalVerdictWriteInput,
): { verdictId: string; evidenceId: string } {
  if (requireActiveDomainOperationContext(context) !== "attempt.verify") {
    throw new Error("Host Technical Verdict creation requires an attempt.verify Domain Operation");
  }
  const verdictId = randomUUID();
  const evidenceId = randomUUID();
  getDb().prepare(`
    INSERT INTO workflow_technical_verdicts (
      verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
      tested_source_revision, verdict, policy_id, policy_version, rationale,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (
      :verdict_id, :project_id, :criterion_id, :lifecycle_id, :attempt_id,
      :source_revision, :verdict, 'gsd-host-verification', '1', :rationale,
      :created_at, :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":verdict_id": verdictId,
    ":project_id": input.scope.projectId,
    ":criterion_id": input.criterionId,
    ":lifecycle_id": input.scope.lifecycleId,
    ":attempt_id": input.scope.attemptId,
    ":source_revision": input.testedSourceRevision,
    ":verdict": input.verdict,
    ":rationale": input.rationale,
    ":created_at": input.createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });

  const environmentJson = canonicalDomainJson(input.evidence.environment);
  const evidencePayload: DomainJsonValue = {
    evidenceClass: input.evidence.evidenceClass,
    commandOrTool: input.evidence.commandOrTool,
    workingDirectory: input.evidence.workingDirectory,
    startedAt: input.evidence.startedAt,
    endedAt: input.evidence.endedAt,
    observation: input.evidence.observation,
    durableOutputRef: input.evidence.durableOutputRef,
    environment: input.evidence.environment,
  };
  if (input.evidence.exitCode !== undefined) evidencePayload["exitCode"] = input.evidence.exitCode;
  const contentHash = `sha256:${createHash("sha256").update(canonicalDomainJson(evidencePayload)).digest("hex")}`;
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
    ":project_id": input.scope.projectId,
    ":verdict_id": verdictId,
    ":criterion_id": input.criterionId,
    ":lifecycle_id": input.scope.lifecycleId,
    ":attempt_id": input.scope.attemptId,
    ":evidence_class": input.evidence.evidenceClass,
    ":command_or_tool": input.evidence.commandOrTool,
    ":working_directory": input.evidence.workingDirectory,
    ":started_at": input.evidence.startedAt,
    ":ended_at": input.evidence.endedAt,
    ":exit_code": input.evidence.exitCode ?? null,
    ":observation": input.evidence.observation,
    ":source_revision": input.testedSourceRevision,
    ":observed_project_revision": input.scope.settleProjectRevision,
    ":content_hash": contentHash,
    ":durable_output_ref": input.evidence.durableOutputRef,
    ":environment_json": environmentJson,
    ":created_at": input.createdAt,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { verdictId, evidenceId };
}
