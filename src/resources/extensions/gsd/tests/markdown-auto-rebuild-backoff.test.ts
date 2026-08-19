import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  clearMarkdownAutoRebuildBackoff,
  recordMarkdownAutoRebuildFailure,
  shouldAttemptMarkdownAutoRebuild,
} from "../markdown-auto-rebuild-backoff.ts";
import type { MigrationAutoCheckResult } from "../migration-auto-check.ts";

function recoveryResult(tasks: number, recoveryFingerprint = `fingerprint-${tasks}`): MigrationAutoCheckResult {
  return {
    action: "recovery-required",
    reason: "count-mismatch",
    markdown: { milestones: 1, slices: 1, tasks },
    beforeDb: { milestones: 1, slices: 1, tasks: tasks + 1 },
    afterDb: { milestones: 1, slices: 1, tasks: tasks + 1 },
    recoveryCommand: "/gsd rebuild markdown",
    recoveryFingerprint,
  };
}

test("unchanged non-convergent recovery verdict persists an auto-rebuild backoff", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-markdown-rebuild-backoff-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    const verdict = recoveryResult(0);

    assert.equal(shouldAttemptMarkdownAutoRebuild(verdict), true);
    recordMarkdownAutoRebuildFailure(verdict);
    assert.equal(shouldAttemptMarkdownAutoRebuild(verdict), false);

    closeDatabase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    assert.equal(shouldAttemptMarkdownAutoRebuild(verdict), false, "backoff survives process-style DB reopen");
    assert.equal(shouldAttemptMarkdownAutoRebuild(recoveryResult(1)), true, "changed drift gets one new attempt");
    assert.equal(
      shouldAttemptMarkdownAutoRebuild(recoveryResult(0, "changed-identity")),
      true,
      "identity drift with unchanged counts gets one new attempt",
    );

    clearMarkdownAutoRebuildBackoff();
    assert.equal(shouldAttemptMarkdownAutoRebuild(verdict), true);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
