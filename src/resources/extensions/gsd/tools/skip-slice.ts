/**
 * skip-slice handler — the core operation behind gsd_skip_slice.
 *
 * Marks a slice as skipped and cascades the skip to every non-closed task in
 * that slice. Without the task cascade the deep-check in
 * executeCompleteMilestone reports pending tasks inside the skipped slice and
 * blocks milestone completion (see #4375).
 *
 * This function performs DB writes only. The MCP wrapper in
 * bootstrap/db-tools.ts handles state-cache invalidation and STATE.md rebuild.
 */

import { isDbAvailable } from "../gsd-db.js";
import {
  cancelSlice,
  SliceLifecycleValidationError,
} from "../slice-lifecycle-domain-operation.js";
import type { ExecutionInvocation } from "../execution-invocation.js";

/**
 * Input parameters for {@link handleSkipSlice}.
 *
 * - `milestoneId` / `sliceId` identify the target slice.
 * - `reason` is a free-form note surfaced in the MCP response; optional
 *   because the caller (e.g. rethink flow) may not have a structured reason.
 */
export interface SkipSliceParams {
  milestoneId: string;
  sliceId: string;
  reason?: string;
  actorName?: string;
  triggerReason?: string;
}

/**
 * Stable machine-readable error codes for {@link SkipSliceResult.error}.
 * Keep in sync with the wrapper in bootstrap/db-tools.ts.
 */
export type SkipSliceErrorCode = "slice_not_found" | "already_complete" | "invalid_state";

/**
 * Result of a {@link handleSkipSlice} call.
 *
 * - `tasksSkipped` — count of tasks whose status was cascaded to "skipped".
 *   Zero is a valid success (slice had no non-closed tasks).
 * - `wasAlreadySkipped` — true when the slice was in "skipped" status on
 *   entry; callers can use this to distinguish first-skip from re-skip.
 * - `error` / `errorCode` — set together for recoverable validation failures
 *   (unknown slice, slice already complete). Both absent on success. DB
 *   errors propagate as thrown exceptions and should be caught by the caller.
 */
export interface SkipSliceResult {
  milestoneId: string;
  sliceId: string;
  tasksSkipped: number;
  wasAlreadySkipped: boolean;
  reason?: string;
  error?: string;
  errorCode?: SkipSliceErrorCode;
}

function validationErrorCode(message: string): SkipSliceErrorCode {
  if (/not found/i.test(message)) return "slice_not_found";
  if (/already complete/i.test(message)) return "already_complete";
  return "invalid_state";
}

/**
 * Mark a slice as "skipped" and cascade the skip to every non-closed task in
 * that slice. Runs as a single transaction so slice status and task statuses
 * are always consistent.
 *
 * Behaviour summary:
 * - Unknown slice → returns {@link SkipSliceResult} with `error`.
 * - Slice already complete/done → returns `error` (cannot un-complete).
 * - Slice already skipped → still cascades leftover non-closed tasks
 *   (heals inconsistent historical state from projects that ran older
 *   versions before the #4375 cascade fix).
 * - Tasks in closed status (complete/done/skipped) are never downgraded.
 */
export function handleSkipSlice(
  params: SkipSliceParams,
  invocation: ExecutionInvocation,
): SkipSliceResult {
  const base: SkipSliceResult = {
    milestoneId: params.milestoneId,
    sliceId: params.sliceId,
    tasksSkipped: 0,
    wasAlreadySkipped: false,
    reason: params.reason,
  };

  // Fail loudly on a closed DB so a `null` from getSlice() inside the
  // transaction unambiguously means "slice not found", never "DB unavailable".
  // The MCP wrapper in bootstrap/db-tools.ts runs ensureDbOpen() before calling
  // this helper; this guard protects direct callers (tests, future code).
  if (!isDbAvailable()) {
    throw new Error("handleSkipSlice: GSD database is not available");
  }

  try {
    const result = cancelSlice({
      invocation,
      slice: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      reason: params.reason?.trim() || "User-directed skip",
      audit: { actorName: params.actorName, triggerReason: params.triggerReason },
    });
    return {
      ...base,
      tasksSkipped: result.tasksSkipped,
      wasAlreadySkipped: result.wasAlreadySkipped,
    };
  } catch (error) {
    if (!(error instanceof SliceLifecycleValidationError)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = validationErrorCode(message);
    return { ...base, error: message, errorCode };
  }
}
