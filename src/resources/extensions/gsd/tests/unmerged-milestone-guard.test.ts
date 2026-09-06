// Project/App: gsd-pi
// File Purpose: Regression tests for blocking completed-but-unmerged milestone branches.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import {
  findUnmergedCompletedMilestones,
  formatUnmergedMilestoneBlockMessage,
  isUnmergedMilestoneAllowedCommand,
} from "../unmerged-milestone-guard.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

function seedMilestone(base: string, id: string, status = "complete"): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id, title: `${id}: Test milestone`, status });
}

function commitBranchFile(base: string, branch: string, filePath: string, content: string): void {
  git(base, "checkout", "-b", branch);
  const absolutePath = join(base, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  git(base, "add", filePath);
  git(base, "commit", "-m", `feat: update ${filePath}`);
  git(base, "checkout", "main");
}

test("findUnmergedCompletedMilestones blocks completed milestone branch product diffs", async () => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  try {
    seedMilestone(base, "M008");
    commitBranchFile(base, "milestone/M008", "index.html", "<h1>M008</h1>\n");

    const blockers = await findUnmergedCompletedMilestones(base);

    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].milestoneId, "M008");
    assert.equal(blockers[0].branch, "milestone/M008");
    assert.equal(blockers[0].integrationBranch, "main");
    assert.deepEqual(blockers[0].files, ["index.html"]);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("findUnmergedCompletedMilestones honors configured main branch without milestone metadata", async (t) => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  seedMilestone(base, "M013");
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "git:", "  main_branch: devel", "---", ""].join("\n"),
  );
  git(base, "checkout", "-b", "devel");
  commitBranchFile(base, "milestone/M013", "index.html", "<h1>M013</h1>\n");
  git(base, "checkout", "devel");
  git(base, "merge", "--ff-only", "milestone/M013");

  const blockers = await findUnmergedCompletedMilestones(base);

  assert.equal(blockers.length, 0);
});

test("findUnmergedCompletedMilestones does not block after a --no-ff merge that diverges from the branch tip", async () => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  try {
    seedMilestone(base, "M011");
    // Milestone branch adds a product file.
    commitBranchFile(base, "milestone/M011", "index.html", "<h1>M011</h1>\n");

    // Merge the branch into main with --no-ff, but resolve the file to main's
    // (empty) side so the merge result diverges from the milestone branch tip.
    // The branch is now an ancestor of main even though a raw diff is non-empty.
    git(base, "merge", "--no-ff", "--no-commit", "milestone/M011");
    writeFileSync(join(base, "index.html"), "<h1>main wins</h1>\n");
    git(base, "add", "index.html");
    git(base, "commit", "-m", "merge: take main side for index.html");

    // Sanity: the diff between main and the branch tip is non-empty...
    assert.notEqual(git(base, "diff", "--numstat", "main", "milestone/M011"), "");
    // ...but the branch tip is an ancestor of main (merge is done).

    const blockers = await findUnmergedCompletedMilestones(base);

    assert.equal(blockers.length, 0);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("findUnmergedCompletedMilestones ignores projection-only branch diffs", async () => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  try {
    seedMilestone(base, "M009");
    commitBranchFile(
      base,
      "milestone/M009",
      ".gsd/milestones/M009/M009-SUMMARY.md",
      "# M009 complete\n",
    );

    const blockers = await findUnmergedCompletedMilestones(base);

    assert.equal(blockers.length, 0);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("formatUnmergedMilestoneBlockMessage includes files, branch, and dirty overlap recovery", async () => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  try {
    seedMilestone(base, "M010");
    commitBranchFile(base, "milestone/M010", "index.html", "<h1>M010</h1>\n");
    writeFileSync(join(base, "index.html"), "<h1>dirty root</h1>\n");

    const [blocker] = await findUnmergedCompletedMilestones(base);
    assert.ok(blocker);

    const message = formatUnmergedMilestoneBlockMessage(blocker, "next");

    assert.match(message, /\/gsd next cannot start new workflow work/);
    assert.match(message, /M010 is complete but not merged/);
    assert.match(message, /Branch: milestone\/M010/);
    assert.match(message, /Target: main/);
    assert.match(message, /index\.html/);
    assert.match(message, /Project-root dirty files overlap/);
    assert.match(message, /Commit, stash, or discard/);
    assert.match(message, /\/gsd dispatch complete-milestone M010/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("findUnmergedCompletedMilestones reports dirty overlap without content fingerprints", async () => {
  const base = makeTempRepo("gsd-unmerged-guard-");
  try {
    const relPath = "build/output.bin";
    const absPath = join(base, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, "main artifact\n");
    git(base, "add", relPath);
    git(base, "commit", "-m", "test: track build output fixture");

    seedMilestone(base, "M012");
    commitBranchFile(base, "milestone/M012", relPath, "milestone artifact\n");
    writeFileSync(absPath, "dirty root artifact\n");

    const [blocker] = await findUnmergedCompletedMilestones(base);
    assert.ok(blocker);
    assert.deepEqual(blocker.files, [relPath]);
    assert.deepEqual(blocker.dirtyOverlap, [{ path: relPath, status: "M" }]);
    assert.equal(Object.hasOwn(blocker.dirtyOverlap[0], "fingerprint"), false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("isUnmergedMilestoneAllowedCommand permits inspection and explicit recovery commands", () => {
  assert.equal(isUnmergedMilestoneAllowedCommand(""), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("auto"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("next"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("parallel start"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("start"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("workflow run release"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("do mark all complete"), false);
  assert.equal(isUnmergedMilestoneAllowedCommand("status"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("forensics"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("capture hello"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("knowledge rule foo"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("codebase stats"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("prefs"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("discuss"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("queue"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("quick"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("config"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("progress"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("progress --forensic"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("parallel status"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("parallel watch"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("worktree list"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("dispatch complete"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("dispatch complete M008"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("dispatch complete-milestone"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("dispatch complete-milestone M008"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("docs-update --verify-only"), true);
  assert.equal(isUnmergedMilestoneAllowedCommand("phase list"), true);
});

test("isUnmergedMilestoneAllowedCommand blocks direct dispatch aliases", () => {
  const aliases = [
    "execute-task",
    "research-milestone",
    "plan-slice",
    "plan-milestone",
    "research-slice",
    "complete-slice",
    "validate-milestone",
    "complete-milestone",
    "docs-update",
    "review-backlog",
    "import",
    "ingest-docs",
    "secure-phase",
    "plan-review-convergence",
    "resume-work",
    "progress --next",
    'progress --do "fix the login bug"',
    "parallel start",
    "parallel resume",
    "parallel merge",
    "parallel pause",
  ];

  for (const alias of aliases) {
    assert.equal(isUnmergedMilestoneAllowedCommand(alias), false, alias);
  }
});

test("isUnmergedMilestoneAllowedCommand blocks mutating phase subcommands", () => {
  const commands = [
    "phase add M009",
    "phase create M009",
    "phase new M009",
    "phase insert M009 after M008",
    "phase remove M008",
    "phase edit M008",
  ];

  for (const command of commands) {
    assert.equal(isUnmergedMilestoneAllowedCommand(command), false, command);
  }
});
