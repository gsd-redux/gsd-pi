// Project/App: gsd-pi
// File Purpose: Single authority for projection key-family → projection kind identity.
//
// trg_workflow_projection_lineage (db-projection-import-kernel-closeout-
// foundation-schema.ts) makes projection kind immutable per (project, key)
// chain: a head enqueued under the wrong kind permanently blocks every
// future canonical enqueue for that key (#1659). Any writer that derives a
// kind from a projection key must consume this module so a new key family
// cannot silently default to "markdown" and re-create that wedge (#1661).

export const MILESTONE_LIFECYCLE_PROJECTION_KIND = "milestone-lifecycle";
export const SLICE_LIFECYCLE_PROJECTION_KIND = "slice-lifecycle";
export const TASK_LIFECYCLE_PROJECTION_KIND = "task-lifecycle";
export const MARKDOWN_PROJECTION_KIND = "markdown";

export const LIFECYCLE_PROJECTION_KEY_PREFIX = "lifecycle/";

export function isLifecycleProjectionKey(projectionKey: string): boolean {
  return projectionKey.startsWith(LIFECYCLE_PROJECTION_KEY_PREFIX);
}

/**
 * The kind the canonical lifecycle domain operations enqueue for a
 * `lifecycle/*` projection key: `lifecycle/<milestone>` → milestone,
 * `lifecycle/<milestone>/<slice>` → slice, deeper → task.
 */
export function lifecycleProjectionKind(projectionKey: string): string {
  const segments = projectionKey.split("/").length;
  if (segments === 2) return MILESTONE_LIFECYCLE_PROJECTION_KIND;
  if (segments === 3) return SLICE_LIFECYCLE_PROJECTION_KIND;
  return TASK_LIFECYCLE_PROJECTION_KIND;
}

/**
 * The canonical projection kind for a projection key family that markdown
 * projection writers (legacy import, planning tools) may enqueue. Lifecycle
 * keys belong to the lifecycle domain operations; everything else in that
 * key universe (planning/*, legacy-import/*) is genuinely markdown-kind.
 */
export function canonicalProjectionKind(projectionKey: string): string {
  if (!isLifecycleProjectionKey(projectionKey)) return MARKDOWN_PROJECTION_KIND;
  return lifecycleProjectionKind(projectionKey);
}
