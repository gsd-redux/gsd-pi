// Project/App: gsd-pi
// File Purpose: Single workflow projection flush seam for mutation exits.

import { renderAllProjections } from "./workflow-projections.js";

export interface ProjectionFlushScope {
  milestoneId: string;
}

export interface ProjectionFlushResult {
  milestoneId: string;
  stale: boolean;
}

export async function flushWorkflowProjections(
  basePath: string,
  scope: ProjectionFlushScope,
): Promise<ProjectionFlushResult> {
  const rendered = await renderAllProjections(basePath, scope.milestoneId);
  return { milestoneId: scope.milestoneId, stale: rendered.stale };
}
