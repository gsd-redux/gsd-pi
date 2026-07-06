// Project/App: gsd-pi
// File Purpose: DB → .planning/ projection. Parallel to writer.ts (which
// emits .gsd/). Produces the .planning/ markdown shape that gsd-core reads.
//
// Layout policy (spec §4.4): emits the layout recorded in the compat marker.
// v1 supports flat-phases; multi-milestone and legacy-milestone-dir are stubbed
// with a clear error until fixtures exist to validate them.

import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";

import { getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.js";
import { saveFile } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import type { PlanningLayout } from "../compat/compat-marker.js";
import {
  applyPlanningProjectionWrites,
  type PlanningProjectionWrite,
} from "../compat/planning-compat.js";

export interface PlanningWrittenFiles {
  paths: string[];
  layout: PlanningLayout;
}

function planningRoot(basePath: string): string {
  return join(basePath, ".planning");
}

function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Format a roadmap for the flat-phases layout. Mirrors the checkbox line
 * format that parsers.ts parsePhaseEntry recognizes: `- [x] NN — Title`.
 */
function formatPlanningRoadmapFlat(
  entries: Array<{ number: number; title: string; done: boolean }>,
): string {
  const lines = ["# Roadmap", "", "## Phases", ""];
  for (const e of entries) {
    const box = e.done ? "[x]" : "[ ]";
    lines.push(`- ${box} ${pad(e.number)} — ${e.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Format STATE.md in gsd-core's phase-progress schema. gsd-pi is authoritative
 * for status; this is a one-way DB→projection (edits to STATE.md are not
 * re-imported — see spec §7).
 */
function formatPlanningState(
  activeMilestone: string,
  totalPhases: number,
  completedPhases: number,
): string {
  const pct = totalPhases === 0 ? 0 : Math.round((completedPhases / totalPhases) * 100);
  const ts = new Date().toISOString();
  return [
    "---",
    "gsd_state_version: 1.0",
    `milestone: ${activeMilestone}`,
    'milestone_name: "milestone"',
    "status: active",
    `stopped_at: Phase 01 — in progress`,
    `last_updated: "${ts}"`,
    `last_activity: ${ts.slice(0, 10)}`,
    "progress:",
    `  total_phases: ${totalPhases}`,
    `  completed_phases: ${completedPhases}`,
    `  total_plans: ${totalPhases}`,
    `  completed_plans: ${completedPhases}`,
    `  percent: ${pct}`,
    "---",
    "",
    "# Project State",
    "",
    "Current Phase: **01**",
    "Status: **active**",
    "",
  ].join("\n");
}

function formatPlanningProject(title: string): string {
  return `# ${title}\n`;
}

/**
 * Format a phase plan file with the XML-tagged structure parsers.ts
 * parseOldPlan recognizes: <objective>, <tasks>, <verification>.
 */
function formatPlanningPlan(
  phaseNum: number,
  planNum: number,
  title: string,
  tasks: Array<{ id: string; title: string; estimate?: string; done?: boolean }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${pad(phaseNum)}-${pad(planNum)}: ${title}`, "");
  lines.push("<objective>");
  lines.push(`${title}.`);
  lines.push("</objective>");
  lines.push("");
  lines.push("<tasks>");
  for (const t of tasks) {
    const est = t.estimate ? ` _(${t.estimate})_` : "";
    // Render the checkbox from the task's DB status so a DB→.planning
    // projection preserves completion. Hardcoding `[ ]` here silently reset
    // every completed historical task to unchecked on each reconcile (#1276).
    const box = t.done ? "[x]" : "[ ]";
    lines.push(`- ${box} **${t.id}**: ${t.title}${est}`);
  }
  lines.push("</tasks>");
  lines.push("");
  lines.push("<verification>");
  lines.push("All tasks complete and tests pass.");
  lines.push("</verification>");
  lines.push("");
  return lines.join("\n");
}

/**
 * Project DB state to .planning/ in the recorded layout.
 * Reads DB directly (canonical source). Writes via saveFile (atomic).
 *
 * v1: flat-phases only. Each milestone's slices become sequentially-numbered
 * phase dirs; each task within a slice becomes a plan file (NN-MM-PLAN.md).
 */
export async function writePlanningDirectory(
  basePath: string,
  layout: PlanningLayout,
): Promise<PlanningWrittenFiles> {
  if (layout !== "flat-phases") {
    // v1: flat-phases only. multi-milestone and legacy-milestone-dir need
    // fixtures to validate the reverse-mapping (transformer.ts is non-injective
    // — three layouts collapse to one .gsd/ shape); stub until then.
    throw new Error(
      `writePlanningDirectory: layout "${layout}" not yet supported (v1 supports flat-phases only)`,
    );
  }

  const root = planningRoot(basePath);
  mkdirSync(root, { recursive: true });
  const paths: string[] = [];
  const projectionWrites: PlanningProjectionWrite[] = [];
  const toPlanningRel = (absPath: string): string =>
    relative(root, absPath).replace(/\\/g, "/");

  const milestones = getAllMilestones();
  if (milestones.length === 0) {
    return { paths, layout };
  }

  // Flat-phases: each slice becomes one phase. Tasks within become plan files.
  let phaseNum = 0;
  const roadmapEntries: Array<{ number: number; title: string; done: boolean }> = [];

  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id);
    for (const slice of slices) {
      phaseNum++;
      const phaseSlug = slugify(slice.title || slice.id, slice.id.toLowerCase());
      const phaseDirName = `${pad(phaseNum)}-${phaseSlug}`;
      const phaseDir = join(root, "phases", phaseDirName);
      mkdirSync(phaseDir, { recursive: true });

      const tasks = getSliceTasks(milestone.id, slice.id);
      const isDone =
        tasks.length > 0 && tasks.every((t) => isClosedStatus(t.status));
      roadmapEntries.push({
        number: phaseNum,
        title: slice.title || slice.id,
        done: isDone,
      });

      if (tasks.length === 0) {
        // Empty phase — write a single placeholder plan so the dir isn't empty.
        const planPath = join(phaseDir, `${pad(phaseNum)}-01-PLAN.md`);
        await saveFile(
          planPath,
          formatPlanningPlan(phaseNum, 1, slice.title || slice.id, []),
        );
        paths.push(planPath);
        projectionWrites.push({
          relPath: toPlanningRel(planPath),
          entities: [`${milestone.id}/${slice.id}`],
        });
      } else {
        for (let ti = 0; ti < tasks.length; ti++) {
          const task = tasks[ti]!;
          const planNum = ti + 1;
          const planPath = join(phaseDir, `${pad(phaseNum)}-${pad(planNum)}-PLAN.md`);
          await saveFile(
            planPath,
            formatPlanningPlan(phaseNum, planNum, task.title || task.id, [
              {
                id: task.id,
                title: task.title || task.id,
                estimate: task.estimate || undefined,
                done: isClosedStatus(task.status),
              },
            ]),
          );
          paths.push(planPath);
          projectionWrites.push({
            relPath: toPlanningRel(planPath),
            entities: [`${milestone.id}/${slice.id}/${task.id}`],
          });
        }
      }
    }
  }

  // If no slices produced any phases, write a single empty phase so ROADMAP.md
  // isn't blank and the layout is still discoverable.
  if (roadmapEntries.length === 0) {
    const phaseDirName = `${pad(1)}-milestone`;
    const phaseDir = join(root, "phases", phaseDirName);
    mkdirSync(phaseDir, { recursive: true });
    const planPath = join(phaseDir, `${pad(1)}-01-PLAN.md`);
    await saveFile(planPath, formatPlanningPlan(1, 1, milestones[0]!.title || milestones[0]!.id, []));
    paths.push(planPath);
    projectionWrites.push({
      relPath: toPlanningRel(planPath),
      entities: [milestones[0]!.id],
    });
    roadmapEntries.push({ number: 1, title: milestones[0]!.title || milestones[0]!.id, done: false });
  }

  // Root files
  const milestoneEntities = milestones.map((m) => m.id);
  const roadmapPath = join(root, "ROADMAP.md");
  await saveFile(roadmapPath, formatPlanningRoadmapFlat(roadmapEntries));
  paths.push(roadmapPath);
  projectionWrites.push({ relPath: toPlanningRel(roadmapPath), entities: milestoneEntities });

  const completedPhases = roadmapEntries.filter((e) => e.done).length;
  const statePath = join(root, "STATE.md");
  await saveFile(
    statePath,
    formatPlanningState(milestones[0]!.id, roadmapEntries.length, completedPhases),
  );
  paths.push(statePath);
  projectionWrites.push({ relPath: toPlanningRel(statePath), entities: [milestones[0]!.id] });

  const projectPath = join(root, "PROJECT.md");
  await saveFile(projectPath, formatPlanningProject(milestones[0]!.title || milestones[0]!.id));
  paths.push(projectPath);
  projectionWrites.push({ relPath: toPlanningRel(projectPath), entities: [milestones[0]!.id] });

  applyPlanningProjectionWrites(basePath, projectionWrites);
  return { paths, layout };
}
