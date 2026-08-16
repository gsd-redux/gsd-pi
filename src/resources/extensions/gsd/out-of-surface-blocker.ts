// Named execute-task / run-uat blocker when a plan needs a tool the unit cannot call.

export const OUT_OF_SURFACE_TOOL_BLOCKER = "out-of-surface-tool";

export type BlockerRoute = "surface-widen" | "replan";

const CATEGORY_RE = /\bout-of-surface-tool\b/i;

export function extractBlockerCategory(
  ...texts: Array<string | undefined | null>
): string | undefined {
  for (const text of texts) {
    if (typeof text === "string" && CATEGORY_RE.test(text)) {
      return OUT_OF_SURFACE_TOOL_BLOCKER;
    }
  }
  return undefined;
}

export function routeBlockerCategory(category: string | undefined | null): BlockerRoute {
  return category === OUT_OF_SURFACE_TOOL_BLOCKER ? "surface-widen" : "replan";
}

export function outOfSurfaceBlockerGuidance(taskId: string, sliceId: string): string {
  return [
    `Task ${taskId} reported blocker category ${OUT_OF_SURFACE_TOOL_BLOCKER}.`,
    `The plan needs a tool outside this unit's surface.`,
    `Do not retry the same unit — that burns a failed attempt.`,
    `Widen the unit tool contract for the missing tool, or replan slice ${sliceId} so the work stays inside the current surface.`,
    `Then run /gsd auto to resume.`,
  ].join(" ");
}
