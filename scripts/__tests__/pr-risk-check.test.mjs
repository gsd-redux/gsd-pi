// Project/App: gsd-pi
// File Purpose: Regression tests for the PR risk checker CLI output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/pr-risk-check.mjs");

// `codex review` has no --adversarial flag, and --base cannot be combined
// with a custom [PROMPT] (clap conflict). `--base main` reviews the PR diff
// against the repo's default base, matching this script's own default.
const expectedCommand = "codex review --base main";

// src/project-sessions.ts maps to State Machine (critical) in
// docs/dev/FILE-SYSTEM-MAP.md, which triggers the Codex suggestion.
function runRiskCheck(extraArgs) {
  return spawnSync(process.execPath, [script, "--files", "src/project-sessions.ts", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

test("console report suggests a valid codex review command", () => {
  const result = runRiskCheck([]);

  assert.match(result.stdout, /Have a Codex subscription\? Run: /);
  assert.ok(result.stdout.includes(expectedCommand), result.stdout);
  assert.doesNotMatch(result.stdout, /--adversarial/);
});

test("github summary suggests a valid codex review command", () => {
  const result = runRiskCheck(["--github"]);

  assert.match(result.stdout, /Have a Codex subscription\?/);
  assert.ok(result.stdout.includes(`\`${expectedCommand}\``), result.stdout);
  assert.doesNotMatch(result.stdout, /--adversarial/);
});
