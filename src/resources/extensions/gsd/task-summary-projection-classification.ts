// Project/App: gsd-pi
// File Purpose: Shared classification for DB-backed Task SUMMARY projections.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { stripProjectionStamp } from "./markdown-renderer.js";
import { gsdProjectionRoot, gsdRoot, targetTaskFile } from "./paths.js";
import { readLatestTaskAttempt } from "./task-execution-domain-operation.js";
import { readTaskTechnicalVerdict } from "./task-verification-domain-operation.js";

interface TaskSummaryProjectionArtifact {
  path: string;
  milestoneId: string | null;
  sliceId: string | null;
  taskId: string | null;
  fullContent: string;
}

interface TaskSummaryProjectionTask {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  status: string;
  fullSummaryMd: string;
}

function artifactPathCandidates(basePath: string, artifactPath: string): string[] {
  if (isAbsolute(artifactPath)) return [resolve(artifactPath)];
  const relativePath = artifactPath
    .replaceAll("\\", "/")
    .replace(/^\.gsd\//, "");
  return [
    resolve(join(gsdProjectionRoot(basePath), relativePath)),
    resolve(join(gsdRoot(basePath), relativePath)),
  ];
}

function hasCanonicalContent(
  basePath: string,
  artifact: TaskSummaryProjectionArtifact,
  task: TaskSummaryProjectionTask,
): boolean {
  if (
    artifact.milestoneId !== task.milestoneId ||
    artifact.sliceId !== task.sliceId ||
    artifact.taskId !== task.taskId
  ) {
    return false;
  }

  const canonicalPath = resolve(targetTaskFile(
    basePath,
    task.milestoneId,
    task.sliceId,
    task.taskId,
    "SUMMARY",
  ));
  if (!artifactPathCandidates(basePath, artifact.path).includes(canonicalPath)) return false;
  if (readFileSync(canonicalPath, "utf8") !== artifact.fullContent) return false;
  return stripProjectionStamp(artifact.fullContent) === stripProjectionStamp(task.fullSummaryMd);
}

export function isCanonicalStagedTaskSummaryProjection(
  basePath: string,
  artifact: TaskSummaryProjectionArtifact,
  task: TaskSummaryProjectionTask,
): boolean {
  try {
    if (
      task.status !== "in_progress" ||
      !task.fullSummaryMd ||
      !hasCanonicalContent(basePath, artifact, task)
    ) {
      return false;
    }

    const attempt = readLatestTaskAttempt({
      milestoneId: task.milestoneId,
      sliceId: task.sliceId,
      taskId: task.taskId,
    });
    if (attempt?.state !== "settled" || attempt.outcome !== "succeeded") {
      return false;
    }
    if (attempt.nextStage === "verify") return true;
    if (attempt.nextStage !== "route") return false;

    const verdict = readTaskTechnicalVerdict(attempt.attemptId);
    return verdict !== null && verdict.verdict !== "pass";
  } catch {
    return false;
  }
}
