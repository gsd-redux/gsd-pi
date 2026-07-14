// Project/App: gsd-pi
// File Purpose: Rebuild Milestone summary projections from durable completion events.

import { getDb } from "./db/engine.js";
import type { MilestoneCompletionCloseout } from "./milestone-lifecycle-domain-operation.js";

export interface MilestoneCompletionProjection {
  operationId: string;
  completedAt: string;
  closeout: MilestoneCompletionCloseout;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Milestone completion event ${field} is corrupt`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Milestone completion event closeout.${field} is corrupt`);
  }
  return value as string[];
}

function stripMilestonePrefix(title: string, milestoneId: string): string {
  const prefix = `${milestoneId}: `;
  let displayTitle = title;
  while (displayTitle.startsWith(prefix)) displayTitle = displayTitle.slice(prefix.length);
  return displayTitle.trim() || title;
}

export function readMilestoneCompletionProjection(
  milestoneId: string,
): MilestoneCompletionProjection | null {
  const row = getDb().prepare(`
    SELECT operation_id, payload_json
    FROM workflow_domain_events
    WHERE event_type = 'milestone.completed'
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  if (!row) return null;

  const parsed = JSON.parse(String(row["payload_json"])) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Milestone completion event payload is corrupt");
  }
  const payload = parsed as Record<string, unknown>;
  const closeoutValue = payload["closeout"];
  if (!closeoutValue || typeof closeoutValue !== "object" || Array.isArray(closeoutValue)) {
    throw new Error("Milestone completion event closeout is corrupt");
  }
  const closeout = closeoutValue as Record<string, unknown>;

  return {
    operationId: requiredString(row["operation_id"], "operationId"),
    completedAt: requiredString(payload["completedAt"], "completedAt"),
    closeout: {
      title: requiredString(closeout["title"], "closeout.title"),
      oneLiner: requiredString(closeout["oneLiner"], "closeout.oneLiner"),
      narrative: requiredString(closeout["narrative"], "closeout.narrative"),
      successCriteriaResults: requiredString(
        closeout["successCriteriaResults"],
        "closeout.successCriteriaResults",
      ),
      definitionOfDoneResults: requiredString(
        closeout["definitionOfDoneResults"],
        "closeout.definitionOfDoneResults",
      ),
      requirementOutcomes: requiredString(
        closeout["requirementOutcomes"],
        "closeout.requirementOutcomes",
      ),
      keyDecisions: stringList(closeout["keyDecisions"], "keyDecisions"),
      keyFiles: stringList(closeout["keyFiles"], "keyFiles"),
      lessonsLearned: stringList(closeout["lessonsLearned"], "lessonsLearned"),
      followUps: requiredString(closeout["followUps"], "closeout.followUps"),
      deviations: requiredString(closeout["deviations"], "closeout.deviations"),
    },
  };
}

export function renderMilestoneSummaryMarkdown(
  milestoneId: string,
  completedAt: string,
  closeout: MilestoneCompletionCloseout,
): string {
  const displayTitle = stripMilestonePrefix(closeout.title, milestoneId);
  const keyDecisionsYaml = closeout.keyDecisions.length > 0
    ? `\n${closeout.keyDecisions.map((decision) => `  - ${decision}`).join("\n")}`
    : " []";
  const keyFilesYaml = closeout.keyFiles.length > 0
    ? `\n${closeout.keyFiles.map((file) => `  - ${file}`).join("\n")}`
    : " []";
  const lessonsYaml = closeout.lessonsLearned.length > 0
    ? closeout.lessonsLearned.map((lesson) => `  - ${lesson}`).join("\n")
    : "  - (none)";

  return `---
id: ${milestoneId}
title: "${displayTitle}"
status: complete
completed_at: ${completedAt}
key_decisions:${keyDecisionsYaml}
key_files:${keyFilesYaml}
lessons_learned:
${lessonsYaml}
---

# ${milestoneId}: ${displayTitle}

**${closeout.oneLiner}**

## What Happened

${closeout.narrative}

## Success Criteria Results

${closeout.successCriteriaResults || "Not provided."}

## Definition of Done Results

${closeout.definitionOfDoneResults || "Not provided."}

## Requirement Outcomes

${closeout.requirementOutcomes || "Not provided."}

## Deviations

${closeout.deviations || "None."}

## Follow-ups

${closeout.followUps || "None."}
`;
}
