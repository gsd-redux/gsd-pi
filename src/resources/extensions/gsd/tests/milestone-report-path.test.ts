/**
 * milestone-report-path.test.ts — Regression test for milestone report path resolution.
 *
 * When running in a worktree, milestone reports must be written to the
 * original project root (originalBasePath), not the worktree path (basePath).
 *
 * Covers: _resolveReportBasePath from auto/phases.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { _resolveDispatchGuardBasePath, _resolveReportBasePath } from "../auto/phases.ts";

describe("_resolveReportBasePath", () => {
  test("uses originalBasePath when set (worktree scenario)", () => {
    const session = {
      originalBasePath: "/projects/my-app",
      basePath: "/projects/my-app/.claude/worktrees/agent-abc123",
    };

    assert.equal(_resolveReportBasePath(session), "/projects/my-app");
  });

  test("falls back to basePath when originalBasePath is empty", () => {
    const session = {
      originalBasePath: "",
      basePath: "/projects/my-app",
    };

    assert.equal(_resolveReportBasePath(session), "/projects/my-app");
  });

  test("falls back to basePath when originalBasePath is undefined", () => {
    const session = {
      originalBasePath: undefined as unknown as string,
      basePath: "/projects/my-app",
    };

    assert.equal(_resolveReportBasePath(session), "/projects/my-app");
  });

  test("uses originalBasePath even when basePath differs", () => {
    const session = {
      originalBasePath: "/home/user/repo",
      basePath: "/tmp/worktree-xyz",
    };

    assert.equal(_resolveReportBasePath(session), "/home/user/repo");
  });

  test("uses GSD_PROJECT_ROOT for symlink-resolved worktree paths", () => {
    const savedProjectRoot = process.env.GSD_PROJECT_ROOT;
    process.env.GSD_PROJECT_ROOT = "/real/project";
    try {
      const session = {
        originalBasePath: "",
        basePath: "/Users/dev/.gsd/projects/abc123/worktrees/M001/slices/S01",
      };

      assert.equal(_resolveReportBasePath(session), "/real/project");
      assert.equal(_resolveDispatchGuardBasePath(session), "/real/project");
    } finally {
      if (savedProjectRoot === undefined) delete process.env.GSD_PROJECT_ROOT;
      else process.env.GSD_PROJECT_ROOT = savedProjectRoot;
    }
  });
});
