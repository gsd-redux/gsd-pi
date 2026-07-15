// Project/App: gsd-pi
// File Purpose: Forwarded validation evidence rules for milestone validation.

import { getArtifact, getMilestone, getMilestoneSlices } from "./gsd-db.js";
import { loadFile } from "./files.js";
import { resolveSliceFile } from "./paths.js";
import {
  compactTextParts,
  hasBrowserEvidenceText,
  hasBrowserRequiredText,
} from "./browser-evidence.js";

export interface MilestoneValidationEvidenceParams {
  milestoneId: string;
  verdict: "pass" | "needs-attention" | "needs-remediation";
  successCriteriaChecklist: string;
  verificationClasses?: string;
  verdictRationale: string;
  remediationPlan?: string;
  verificationEvidence?: Array<{
    verificationClass?: string;
    evidenceClass?: string;
    commandOrTool?: string;
    observation?: string;
    sliceId?: string;
  }>;
}

export function browserEvidenceRequired(
  params: MilestoneValidationEvidenceParams,
): boolean {
  const milestone = getMilestone(params.milestoneId);
  const slices = getMilestoneSlices(params.milestoneId);
  return hasBrowserRequiredText(compactTextParts([
    milestone?.vision,
    milestone?.success_criteria,
    milestone?.verification_uat,
    params.successCriteriaChecklist,
    params.verificationClasses,
    ...slices.flatMap((slice) => [slice.demo, slice.goal, slice.success_criteria]),
  ]));
}

export function hasRuntimeExecutableUatEvidenceText(text: string): boolean {
  if (!/\buatType:\s*runtime-executable\b/i.test(text)) return false;
  if (!/\bverdict:\s*PASS\b/i.test(text)) return false;
  return /^\|\s*[^|\n]+\s*\|\s*runtime\s*\|\s*PASS\s*\|[^|\n]*\bgsd_uat_exec\b/mi.test(text);
}

export async function browserEvidenceGateRequiresAttention(
  params: MilestoneValidationEvidenceParams,
  basePath: string,
  options?: { structuredOnly?: boolean },
): Promise<boolean> {
  if (params.verdict !== "pass") return false;
  if (!browserEvidenceRequired(params)) return false;
  if (options?.structuredOnly) {
    const qualifyingEvidence = (params.verificationEvidence ?? []).filter((evidence) =>
      evidence.verificationClass === "UAT" &&
      evidence.observation === "passed" && (
        evidence.evidenceClass === "browser" ||
        (
          evidence.evidenceClass === "runtime" &&
          /\bgsd_uat_exec\b/i.test(evidence.commandOrTool ?? "")
        )
      )
    );
    const browserRequiringSlices = getMilestoneSlices(params.milestoneId).filter((slice) =>
      hasBrowserRequiredText(compactTextParts([slice.demo, slice.goal, slice.success_criteria])),
    );
    if (browserRequiringSlices.length === 0) return qualifyingEvidence.length === 0;
    return browserRequiringSlices.some((slice) =>
      !qualifyingEvidence.some((evidence) => evidence.sliceId === slice.id)
    );
  }

  const slices = getMilestoneSlices(params.milestoneId);

  const sliceEvidencePairs: Array<{ sliceRequirementText: string; evidenceText: string }> = [];
  for (const slice of slices) {
    const chunks: string[] = [];
    const artifactPath = `milestones/${params.milestoneId}/slices/${slice.id}/${slice.id}-ASSESSMENT.md`;
    const artifact = getArtifact(artifactPath);
    if (artifact?.full_content) chunks.push(artifact.full_content);
    const assessmentPath = resolveSliceFile(basePath, params.milestoneId, slice.id, "ASSESSMENT");
    const assessmentContent = assessmentPath ? await loadFile(assessmentPath) : null;
    if (assessmentContent) chunks.push(assessmentContent);
    sliceEvidencePairs.push({
      sliceRequirementText: compactTextParts([slice.demo, slice.goal, slice.success_criteria]),
      evidenceText: chunks.join("\n\n"),
    });
  }

  const browserRequiringSlices = sliceEvidencePairs.filter((slice) =>
    hasBrowserRequiredText(slice.sliceRequirementText),
  );
  const runtimeBypasses =
    browserRequiringSlices.length > 0
      ? browserRequiringSlices.every((slice) => hasRuntimeExecutableUatEvidenceText(slice.evidenceText))
      : sliceEvidencePairs.some((slice) => hasRuntimeExecutableUatEvidenceText(slice.evidenceText));
  if (runtimeBypasses) return false;

  const persistedEvidence = sliceEvidencePairs.map((slice) => slice.evidenceText).join("\n\n");
  const validationEvidence = compactTextParts([
    params.successCriteriaChecklist,
    params.verificationClasses,
    params.verdictRationale,
    params.remediationPlan,
  ]);
  return !hasBrowserEvidenceText(`${persistedEvidence}\n\n${validationEvidence}`);
}

export function applyBrowserEvidenceGate<T extends MilestoneValidationEvidenceParams>(
  params: T,
): Omit<T, "verdict" | "verdictRationale"> & { verdict: "needs-attention"; verdictRationale: string } {
  const note = "Browser evidence gate: Browser-observable acceptance criteria were detected, but no persisted ASSESSMENT or validation evidence recorded browser actions with assertions. Downgraded from pass to needs-attention.";
  return {
    ...params,
    verdict: "needs-attention",
    verdictRationale: params.verdictRationale.trim()
      ? `${params.verdictRationale.trim()}\n\n${note}`
      : note,
  };
}
