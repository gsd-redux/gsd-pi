import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveTaskRecoveryResumeBasePath,
  resolveWorkflowToolBasePath,
} from "../bootstrap/dynamic-tools.ts";
import { importWorkflowExecutorsModule } from "../workflow-mcp.ts";

test("resolveWorkflowToolBasePath routes milestone writes to auto-worktree", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-wt-base-"));
  const worktree = join(project, ".gsd", "worktrees", "M002-mskcfz");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n", "utf-8");

  try {
    const base = resolveWorkflowToolBasePath(
      { cwd: project },
      { milestone_id: "M002-mskcfz" },
    );
    assert.equal(base, worktree);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveTaskRecoveryResumeBasePath selects the worktree owning the recovery action", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-recovery-base-"));
  const first = join(project, ".gsd-worktrees", "M001-first");
  const second = join(project, ".gsd-worktrees", "M002-second");
  for (const worktree of [first, second]) {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /tmp/fake-git-dir\n", "utf-8");
  }

  try {
    assert.equal(resolveTaskRecoveryResumeBasePath(
      { cwd: project },
      "recovery-action-2",
      (_projectRoot, actionId) => actionId === "recovery-action-2" ? "M002-second" : null,
    ), second);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("importWorkflowExecutorsModule loads the required executor surface", async () => {
  const mod = await importWorkflowExecutorsModule();
  assert.equal(typeof mod.executeSummarySave, "function");
  assert.equal(typeof mod.executeSkipSlice, "function");
});
