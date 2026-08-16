// Project/App: gsd-pi
// File Purpose: #1774 fixture contract — recovered ROADMAP must stay
// git-tracked so auto-start cannot migrate .gsd/ out from under pass-0
// reconciliation (roadmap-missing flake).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { hasGitTrackedGsdFiles } from "../gitignore.ts";
import { migrateToExternalState } from "../migrate-external.ts";
import { resolveMilestoneFile } from "../paths.ts";

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function writeRecoveredRoadmap(dir: string): string {
  const milestoneDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  const roadmapPath = join(milestoneDir, "M001-ROADMAP.md");
  writeFileSync(
    roadmapPath,
    [
      "# M001: Provider Pause Fixture",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Update answer** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
  );
  return roadmapPath;
}

function makeRepo(gitignore: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-1774-")));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "e2e@gsd.test"]);
  git(dir, ["config", "user.name", "GSD E2E"]);
  writeFileSync(join(dir, ".gitignore"), gitignore);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", ".gitignore", "README.md"]);
  git(dir, ["commit", "-m", "test: seed"]);
  return dir;
}

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
});

test("#1774: umbrella .gsd ignore leaves recovered ROADMAP untracked", () => {
  const dir = makeRepo(".gsd/\n");
  created.push(dir);
  writeRecoveredRoadmap(dir);
  assert.equal(
    hasGitTrackedGsdFiles(dir),
    false,
    "ignored ROADMAP must stay untracked — that is the flake setup",
  );
});

test("#1774: tracked recovered ROADMAP stays resolvable and skips external migration", () => {
  const dir = makeRepo(".gsd/worktrees/\n");
  created.push(dir);
  const roadmapPath = writeRecoveredRoadmap(dir);
  git(dir, ["add", ".gsd/milestones/M001/M001-ROADMAP.md"]);
  git(dir, ["commit", "-m", "test: seed recovered milestone projections"]);

  assert.equal(hasGitTrackedGsdFiles(dir), true, "committed ROADMAP must count as tracked .gsd state");

  const previousStateDir = process.env.GSD_STATE_DIR;
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-1774-state-")));
  created.push(stateDir);
  process.env.GSD_STATE_DIR = stateDir;
  try {
    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, false, "tracked projections must skip external migration");
    assert.equal(result.error, undefined, "skip is silent, not an error");
  } finally {
    if (previousStateDir === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = previousStateDir;
  }

  assert.ok(existsSync(roadmapPath), "ROADMAP must remain at the in-project path");
  assert.equal(
    resolveMilestoneFile(dir, "M001", "ROADMAP"),
    roadmapPath,
    "pass-0 reconciliation must see the recovered ROADMAP",
  );
});
