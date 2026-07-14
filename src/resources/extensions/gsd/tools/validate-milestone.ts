// Project/App: gsd-pi
// File Purpose: Validate-milestone tool handler for GSD workflow quality gates.

/**
 * validate-milestone handler — the core operation behind gsd_validate_milestone.
 *
 * Persists milestone validation results to the assessments table and
 * quality_gates table, renders VALIDATION.md to disk, and invalidates caches.
 *
 * #2945 Bug 4: Previously only wrote to assessments — quality_gates records
 * were never persisted, causing M002+ milestones to have zero gate records
 * despite passing validation.
 */

import {
  transaction,
  insertAssessment,
  getMilestoneSlices,
  getMilestone,
} from "../gsd-db.js";
import { clearPathCache, targetMilestoneFile } from "../paths.js";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { VALIDATION_VERDICTS, isValidMilestoneVerdict } from "../verdict-parser.js";
import { insertMilestoneValidationGates } from "../milestone-validation-gates.js";
import { logWarning } from "../workflow-logger.js";
import { UokGateRunner } from "../uok/gate-runner.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { resolveUokFlags } from "../uok/flags.js";
import {
  applyBrowserEvidenceGate,
  browserEvidenceGateRequiresAttention,
} from "../milestone-validation-evidence.js";
import type { ExecutionInvocation } from "../execution-invocation.js";
import {
  prepareMilestoneValidation,
  recordMilestoneValidation,
  settleMilestoneValidation,
  type MilestoneValidationEvidenceInput,
  type RecordMilestoneValidationReceipt,
} from "../milestone-validation-domain-operation.js";
import {
  captureVerificationSourceSnapshot,
  confirmVerificationSourceSnapshot,
  resolveVerificationRepositoryTargets,
} from "../verification-source-integrity.js";

export type MilestoneVerificationClass = "Contract" | "Integration" | "Operational" | "UAT";

export interface MilestoneVerificationEvidence extends MilestoneValidationEvidenceInput {
  verificationClass: MilestoneVerificationClass;
  testedSourceRevision: string;
  rationale: string;
}

export interface ValidateMilestoneParams {
  milestoneId: string;
  verdict: "pass" | "needs-attention" | "needs-remediation";
  remediationRound: number;
  successCriteriaChecklist: string;
  sliceDeliveryAudit: string;
  crossSliceIntegration: string;
  requirementCoverage: string;
  verificationClasses?: string;
  verificationEvidence?: MilestoneVerificationEvidence[];
  verdictRationale: string;
  remediationPlan?: string;
}

export interface ValidateMilestoneResult {
  milestoneId: string;
  verdict: string;
  validationPath: string;
  operationId?: string;
  resultingRevision?: number;
  attemptId?: string;
  resultId?: string;
  duplicate?: boolean;
  stale?: boolean;
}

export interface ValidateMilestoneOptions {
  uokGatesEnabled?: boolean;
  traceId?: string;
  turnId?: string;
  skipBrowserEvidenceGate?: boolean;
  invocation?: ExecutionInvocation;
}

function derivedInvocation(
  invocation: ExecutionInvocation,
  suffix: "prepare" | "settle",
): ExecutionInvocation {
  return {
    ...invocation,
    idempotencyKey: `${invocation.idempotencyKey}/${suffix}`,
  };
}

function canonicalVerdict(
  verdict: ValidateMilestoneParams["verdict"],
): "pass" | "fail" | "inconclusive" {
  switch (verdict) {
    case "pass":
      return "pass";
    case "needs-remediation":
      return "fail";
    case "needs-attention":
      return "inconclusive";
  }
}

function canonicalObservation(
  verdict: ValidateMilestoneParams["verdict"],
): "passed" | "failed" | "inconclusive" {
  switch (verdict) {
    case "pass":
      return "passed";
    case "needs-remediation":
      return "failed";
    case "needs-attention":
      return "inconclusive";
  }
}

function evidenceVerdict(
  evidence: MilestoneVerificationEvidence[],
): "pass" | "fail" | "inconclusive" {
  if (evidence.some((entry) => entry.observation === "failed")) return "fail";
  if (evidence.some((entry) => entry.observation === "inconclusive")) return "inconclusive";
  return "pass";
}

function isVerificationNotApplicable(value: string): boolean {
  const v = (value ?? "").toLowerCase().trim().replace(/[.\s]+$/, "");
  if (!v || v === "none") return true;
  return /^(?:none(?:[\s._\u2014-]+[\s\S]*)?|n\/?a(?:[\s._\u2014-]+[\s\S]*)?|not[\s._-]+(?:applicable|required|needed|provided)(?:[\s._\u2014-]+[\s\S]*)?|no[\s._-]+operational[\s\S]*)$/i.test(v);
}

function getRequiredVerificationClasses(milestoneId: string): string[] {
  const milestone = getMilestone(milestoneId);
  if (!milestone) return [];

  const required: string[] = [];
  if (!isVerificationNotApplicable(milestone.verification_contract)) required.push("Contract");
  if (!isVerificationNotApplicable(milestone.verification_integration)) required.push("Integration");
  if (!isVerificationNotApplicable(milestone.verification_operational)) required.push("Operational");
  if (!isVerificationNotApplicable(milestone.verification_uat)) required.push("UAT");
  return required;
}

function renderValidationMarkdown(params: ValidateMilestoneParams): string {
  let md = `---
verdict: ${params.verdict}
remediation_round: ${params.remediationRound}
---

# Milestone Validation: ${params.milestoneId}

## Success Criteria Checklist
${params.successCriteriaChecklist}

## Slice Delivery Audit
${params.sliceDeliveryAudit}

## Cross-Slice Integration
${params.crossSliceIntegration}

## Requirement Coverage
${params.requirementCoverage}

${params.verificationClasses ? `## Verification Class Compliance
${params.verificationClasses}

` : ""}
## Verdict Rationale
${params.verdictRationale}
`;

  if (params.verdict === "needs-remediation" && params.remediationPlan) {
    md += `\n## Remediation Plan\n${params.remediationPlan}\n`;
  }

  return md;
}

function recordCanonicalValidation(input: {
  params: ValidateMilestoneParams;
  validationMd: string;
  validationPath: string;
  artifactBasePath: string;
  requiredClasses: string[];
  invocation: ExecutionInvocation;
}): RecordMilestoneValidationReceipt | { error: string } {
  const evidenceByClass = new Map<string, MilestoneVerificationEvidence[]>();
  for (const evidence of input.params.verificationEvidence ?? []) {
    const className = evidence.verificationClass.toLowerCase();
    const group = evidenceByClass.get(className) ?? [];
    group.push(evidence);
    evidenceByClass.set(className, group);
  }
  const missingEvidence = input.requiredClasses.filter(
    (className) => (evidenceByClass.get(className.toLowerCase())?.length ?? 0) === 0,
  );
  if (missingEvidence.length > 0) {
    return {
      error: `planned ${missingEvidence.join(", ")} verification requires current structured database evidence; verificationClasses prose cannot authorize Milestone validation`,
    };
  }
  for (const className of input.requiredClasses) {
    const evidence = evidenceByClass.get(className.toLowerCase()) ?? [];
    if (new Set(evidence.map((entry) => entry.evidenceClass)).size > 1) {
      return { error: `${className} verification evidence must use one evidence class` };
    }
  }

  const preferences = loadEffectiveGSDPreferences()?.preferences;
  const resolvedTargets = resolveVerificationRepositoryTargets(
    input.artifactBasePath,
    preferences,
    null,
    null,
  );
  if (resolvedTargets.missingRepositoryIds.length > 0) {
    return {
      error: `verification source repositories are missing: ${resolvedTargets.missingRepositoryIds.join(", ")}`,
    };
  }
  const targets = resolvedTargets.repositories.map((repository) => ({
    id: repository.id,
    cwd: repository.root,
  }));
  const source = captureVerificationSourceSnapshot(targets);
  if (!source.ok) return { error: source.error };
  const staleEvidence = (input.params.verificationEvidence ?? []).find(
    (evidence) => evidence.testedSourceRevision !== source.snapshot.aggregateRevision,
  );
  if (staleEvidence) {
    return {
      error:
        `${staleEvidence.verificationClass} verification evidence was tested against ` +
        `${staleEvidence.testedSourceRevision}, but the current source revision is ` +
        `${source.snapshot.aggregateRevision}`,
    };
  }

  const prepared = prepareMilestoneValidation({
    invocation: derivedInvocation(input.invocation, "prepare"),
    milestoneId: input.params.milestoneId,
    criteria: [
      {
        criterionKey: "milestone-validation:aggregate",
        evidenceClass: "artifact",
        description: "The complete Milestone validation report must support its aggregate verdict.",
      },
      ...input.requiredClasses.map((className) => {
        const evidence = evidenceByClass.get(className.toLowerCase())!;
        return {
          criterionKey: `milestone-validation:${className.toLowerCase()}`,
          evidenceClass: evidence[0]!.evidenceClass,
          description: `${className} verification planned for this Milestone must be current and pass.`,
        };
      }),
    ],
  });
  const confirmedBeforeSettlement = confirmVerificationSourceSnapshot(targets, source.snapshot);
  if (!confirmedBeforeSettlement.ok) {
    settleMilestoneValidation({
      invocation: derivedInvocation(input.invocation, "settle"),
      attemptId: prepared.attemptId,
      outcome: "interrupted",
      failureClass: "verification-drift",
      summary: confirmedBeforeSettlement.error,
      output: { testedSourceRevision: source.snapshot.aggregateRevision },
    });
    return { error: confirmedBeforeSettlement.error };
  }

  const settled = settleMilestoneValidation({
    invocation: derivedInvocation(input.invocation, "settle"),
    attemptId: prepared.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: `Milestone validation recorded ${input.params.verdict}.`,
    output: {
      validationMarkdown: input.validationMd,
      validationPath: input.validationPath,
      verdict: input.params.verdict,
      remediationRound: input.params.remediationRound,
      testedSourceRevision: source.snapshot.aggregateRevision,
      sourceTargets: source.snapshot.targets.map((target) => ({
        id: target.targetId,
        revision: target.revision,
      })),
    },
  });
  const confirmedBeforeVerdict = confirmVerificationSourceSnapshot(targets, source.snapshot);
  if (!confirmedBeforeVerdict.ok) return { error: confirmedBeforeVerdict.error };

  const aggregateCriterion = prepared.criteria[0];
  if (!aggregateCriterion) return { error: "Milestone validation aggregate criterion is missing" };
  const verdict = canonicalVerdict(input.params.verdict);
  const observation = canonicalObservation(input.params.verdict);
  const classResults = input.requiredClasses.map((className) => {
    const criterionKey = `milestone-validation:${className.toLowerCase()}`;
    const criterion = prepared.criteria.find((entry) => entry.criterionKey === criterionKey);
    if (!criterion) throw new Error(`${className} validation criterion is missing`);
    const evidence = evidenceByClass.get(className.toLowerCase())!;
    return {
      criterionId: criterion.criterionId,
      verdict: evidenceVerdict(evidence),
      rationale: evidence.map((entry) => entry.rationale).join("\n"),
      evidence: evidence.map(({
        verificationClass: _verificationClass,
        testedSourceRevision: _testedSourceRevision,
        rationale: _rationale,
        ...entry
      }) => entry),
    };
  });
  return recordMilestoneValidation({
    invocation: input.invocation,
    attemptId: prepared.attemptId,
    testedSourceRevision: source.snapshot.aggregateRevision,
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict,
    rationale: input.params.verdictRationale,
    criterionResults: [
      {
        criterionId: aggregateCriterion.criterionId,
        verdict,
        rationale: input.params.verdictRationale,
        evidence: [{
          evidenceClass: "artifact",
          commandOrTool: "gsd_validate_milestone",
          workingDirectory: input.artifactBasePath,
          startedAt: settled.endedAt,
          endedAt: settled.endedAt,
          observation,
          durableOutputRef: `db://workflow_attempt_results/${settled.resultId}`,
          environment: {
            policy: "milestone-validation",
            sourceTargets: source.snapshot.targets.map((target) => ({
              id: target.targetId,
              revision: target.revision,
            })),
          },
        }],
      },
      ...classResults,
    ],
  });
}

export async function handleValidateMilestone(
  params: ValidateMilestoneParams,
  basePath: string,
  opts?: ValidateMilestoneOptions,
): Promise<ValidateMilestoneResult | { error: string }> {
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  if (!isValidMilestoneVerdict(params.verdict)) {
    return { error: `verdict must be one of: ${VALIDATION_VERDICTS.join(", ")}` };
  }
  const requiredClasses = getRequiredVerificationClasses(params.milestoneId);
  if (requiredClasses.length > 0) {
    const verificationClasses = params.verificationClasses ?? "";
    const missingClasses = requiredClasses.filter(
      (className) => !new RegExp(`\\b${className}\\b`, "i").test(verificationClasses),
    );
    if (missingClasses.length === 1) {
      const missingClass = missingClasses[0];
      return {
        error: `verificationClasses must include canonical row "${missingClass}" because this milestone planned ${missingClass.toLowerCase()} verification`,
      };
    }
    if (missingClasses.length > 1) {
      const quotedClasses = missingClasses.map((className) => `"${className}"`).join(", ");
      const plannedClasses = missingClasses.map((className) => className.toLowerCase()).join(", ");
      return {
        error: `verificationClasses must include canonical rows ${quotedClasses} because this milestone planned ${plannedClasses} verification`,
      };
    }
  }

  const artifactBasePath = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);
  const shouldApplyBrowserEvidenceGate = !opts?.skipBrowserEvidenceGate &&
    await browserEvidenceGateRequiresAttention(params, artifactBasePath);
  const effectiveParams = shouldApplyBrowserEvidenceGate
    ? applyBrowserEvidenceGate(params)
    : params;

  // ── Resolve paths and render markdown ────────────────────────────────
  // #4761: route through the canonical-root resolver so that when a live
  // worktree exists for this milestone, validation reads/writes the
  // worktree's artifacts instead of stale project-root state.
  const validationMd = renderValidationMarkdown(effectiveParams);
  const validationPath = targetMilestoneFile(
    artifactBasePath,
    effectiveParams.milestoneId,
    "VALIDATION",
    getMilestone(effectiveParams.milestoneId)?.title,
  );

  const canonical = opts?.invocation
    ? recordCanonicalValidation({
        params: effectiveParams,
        validationMd,
        validationPath,
        artifactBasePath,
        requiredClasses,
        invocation: opts.invocation,
      })
    : undefined;
  if (canonical && "error" in canonical) return canonical;
  if (canonical?.status === "replayed") {
    return {
      milestoneId: effectiveParams.milestoneId,
      verdict: effectiveParams.verdict,
      validationPath,
      operationId: canonical.operationId,
      resultingRevision: canonical.resultingRevision,
      attemptId: canonical.attemptId,
      resultId: canonical.resultId,
      duplicate: true,
    };
  }

  // ── DB write first — matches complete-task/complete-slice pattern ───
  // Write DB before disk so a crash between the two leaves a recoverable
  // state: the DB row exists but the file is missing, which projection
  // rendering can regenerate. The inverse (file exists, no DB row) is
  // harder to detect and recover from (#2725).
  const validatedAt = new Date().toISOString();
  const slices = getMilestoneSlices(effectiveParams.milestoneId);
  const gateSliceId = slices.length > 0 ? slices[0].id : "_milestone";

  transaction(() => {
    insertAssessment({
      path: validationPath,
      milestoneId: effectiveParams.milestoneId,
      sliceId: null,
      taskId: null,
      status: effectiveParams.verdict,
      scope: 'milestone-validation',
      fullContent: validationMd,
    });

    // #2945 Bug 4: persist quality_gates records alongside the assessment.
    // Previously only the assessment was written, leaving M002+ milestones
    // with zero quality_gate records despite passing validation.
    insertMilestoneValidationGates(
      effectiveParams.milestoneId,
      gateSliceId,
      effectiveParams.verdict,
      validatedAt,
    );
  });

  // ── Filesystem render (outside transaction) ────────────────────────────
  let projectionStale = false;
  try {
    await saveFile(validationPath, validationMd);
    const projectRoot = resolveWorktreeProjectRoot(basePath);
    if (projectRoot !== artifactBasePath) {
      // Mirror to project root using the project root's layout (same logic as above).
      const projectValidationPath = targetMilestoneFile(
        projectRoot,
        effectiveParams.milestoneId,
        "VALIDATION",
        getMilestone(effectiveParams.milestoneId)?.title,
      );
      try {
        await saveFile(projectValidationPath, validationMd);
      } catch (mirrorErr) {
        logWarning(
          "projection",
          `validate_milestone project-root VALIDATION mirror failed for ${effectiveParams.milestoneId}`,
          { error: (mirrorErr as Error).message },
        );
      }
    }
  } catch (renderErr) {
    projectionStale = true;
    logWarning("projection", `validate_milestone projection write failed for ${effectiveParams.milestoneId}; DB validation remains committed`, {
      error: (renderErr as Error).message,
    });
  }

  invalidateStateCache();
  clearPathCache();
  clearParseCache();

  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const gatesEnabled = opts?.uokGatesEnabled ?? resolveUokFlags(prefs).gates;
  if (gatesEnabled) {
    try {
      const gateRunner = new UokGateRunner();
      const nonPassVerdict = effectiveParams.verdict !== "pass";
      gateRunner.register({
        id: "milestone-validation-gates",
        type: "verification",
        execute: async () => ({
          outcome: nonPassVerdict ? "manual-attention" : "pass",
          failureClass: nonPassVerdict ? "manual-attention" : "none",
          rationale: `milestone validation verdict: ${effectiveParams.verdict}`,
          findings: nonPassVerdict
            ? [effectiveParams.verdictRationale, effectiveParams.remediationPlan ?? ""].filter(Boolean).join("\n")
            : "",
        }),
      });
      await gateRunner.run("milestone-validation-gates", {
        basePath: artifactBasePath,
        traceId: opts?.traceId ?? `validate-milestone:${effectiveParams.milestoneId}`,
        turnId: opts?.turnId ?? `${effectiveParams.milestoneId}:validate`,
        milestoneId: effectiveParams.milestoneId,
        sliceId: gateSliceId,
        unitType: "validate-milestone",
        unitId: effectiveParams.milestoneId,
      });
    } catch (err) {
      logWarning(
        "tool",
        `validate_milestone — failed to persist UOK gate result: ${(err as Error).message}`,
      );
    }
  }

  return {
    milestoneId: effectiveParams.milestoneId,
    verdict: effectiveParams.verdict,
    validationPath,
    ...(canonical
      ? {
          operationId: canonical.operationId,
          resultingRevision: canonical.resultingRevision,
          attemptId: canonical.attemptId,
          resultId: canonical.resultId,
        }
      : {}),
    ...(projectionStale ? { stale: true } : {}),
  };
}
