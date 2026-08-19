import { deleteRuntimeKv, getRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import type { MigrationAutoCheckResult } from "./migration-auto-check.js";

const MARKDOWN_AUTO_REBUILD_BACKOFF_KEY = "markdown_auto_rebuild_nonconvergent";

interface MarkdownAutoRebuildBackoff {
  signature: string;
}

function recoverySignature(result: MigrationAutoCheckResult): string {
  return JSON.stringify({
    recoveryFingerprint: result.recoveryFingerprint ?? null,
    reason: result.reason,
    recoveryCommand: result.recoveryCommand ?? null,
    markdown: result.markdown,
    beforeDb: result.beforeDb,
  });
}

/** Return false after the same recovery verdict already survived an auto-rebuild. */
export function shouldAttemptMarkdownAutoRebuild(result: MigrationAutoCheckResult): boolean {
  const backoff = getRuntimeKv<MarkdownAutoRebuildBackoff>(
    "global",
    "",
    MARKDOWN_AUTO_REBUILD_BACKOFF_KEY,
  );
  return backoff?.signature !== recoverySignature(result);
}

/** Persist a non-convergent verdict so later launches do not repeat the rebuild. */
export function recordMarkdownAutoRebuildFailure(result: MigrationAutoCheckResult): void {
  setRuntimeKv("global", "", MARKDOWN_AUTO_REBUILD_BACKOFF_KEY, {
    signature: recoverySignature(result),
  } satisfies MarkdownAutoRebuildBackoff);
}

/** Clear backoff as soon as the hierarchy converges or the recovery direction changes. */
export function clearMarkdownAutoRebuildBackoff(): void {
  if (getRuntimeKv("global", "", MARKDOWN_AUTO_REBUILD_BACKOFF_KEY) === null) return;
  deleteRuntimeKv("global", "", MARKDOWN_AUTO_REBUILD_BACKOFF_KEY);
}
