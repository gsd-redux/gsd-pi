/**
 * skip-slice handler — the core operation behind gsd_skip_slice.
 *
 * Cancels a slice in one durable Domain Operation. Completed and already
 * cancelled tasks are preserved; other tasks are cancelled, with running
 * Attempts interrupted before settlement. The operation also records the
 * dependency-bypass decision in a Slice-scoped Waiver.
 *
 * This handler performs authoritative DB writes only. The shared workflow
 * executor handles cache invalidation and post-commit projections.
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
 * - `tasksSkipped` — count of tasks newly moved to cancellation.
 *   Zero is a valid success.
 * - `wasAlreadySkipped` — true when the slice was in "skipped" status on
 *   entry; callers can use this to distinguish first-skip from re-skip.
 * - `error` / `errorCode` — set together for recoverable validation failures.
 *   Both are absent on success. DB errors propagate as thrown exceptions and
 *   should be caught by the caller.
 */
export interface SkipSliceResult {
  milestoneId: string;
  sliceId: string;
  tasksSkipped: number;
  wasAlreadySkipped: boolean;
  duplicate?: boolean;
  superseded?: boolean;
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
 * Publish canonical cancellation and the legacy "skipped" projection in one
 * transaction so Slice, Task, Attempt, dispatch, and Waiver facts agree.
 *
 * Behaviour summary:
 * - Unknown slice → returns {@link SkipSliceResult} with `error`.
 * - Slice already complete/done → returns `error` (cannot un-complete).
 * - Slice already skipped → still cascades leftover non-closed tasks
 *   (heals inconsistent historical state from projects that ran older
 *   versions before the #4375 cascade fix).
 * - Completed and already cancelled tasks are never downgraded.
 * - A running Task Attempt is interrupted and settled before cancellation.
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
    if (!result.isCurrent) {
      return {
        ...base,
        tasksSkipped: result.tasksSkipped,
        wasAlreadySkipped: result.wasAlreadySkipped,
        duplicate: true,
        superseded: true,
      };
    }
    return {
      ...base,
      tasksSkipped: result.tasksSkipped,
      wasAlreadySkipped: result.wasAlreadySkipped,
      ...(result.status === "replayed" ? { duplicate: true } : {}),
    };
  } catch (error) {
    if (!(error instanceof SliceLifecycleValidationError)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = validationErrorCode(message);
    return { ...base, error: message, errorCode };
  }
}
