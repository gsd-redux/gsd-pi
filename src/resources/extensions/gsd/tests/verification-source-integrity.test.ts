// Project/App: gsd-pi
// File Purpose: Executable contract for deterministic fail-closed verification source snapshots.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  captureVerificationSourceSnapshot,
  confirmVerificationSourceSnapshot,
  verificationSourceChanged,
} from "../verification-source-integrity.js";

const tempDirs = new Set<string>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(name: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `gsd-source-${name}-`));
  tempDirs.add(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  writeFileSync(join(cwd, "tracked.txt"), "base\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

function capture(targets: Array<{ id: string; cwd: string }>) {
  const result = captureVerificationSourceSnapshot(targets);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.snapshot;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("source revision changes for staged, unstaged, and untracked content", () => {
  const cwd = createRepository("changes");
  const base = capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  git(cwd, ["add", "tracked.txt"]);
  const staged = capture([{ id: "root", cwd }]);
  assert.notEqual(staged.aggregateRevision, base.aggregateRevision);

  writeFileSync(join(cwd, "tracked.txt"), "unstaged\n");
  const unstaged = capture([{ id: "root", cwd }]);
  assert.notEqual(unstaged.aggregateRevision, staged.aggregateRevision);

  writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
  const untracked = capture([{ id: "root", cwd }]);
  assert.notEqual(untracked.aggregateRevision, unstaged.aggregateRevision);
});

test("multi-target proof is deterministic and keyed by target identity", () => {
  const alpha = createRepository("alpha");
  const beta = createRepository("beta");
  writeFileSync(join(beta, "tracked.txt"), "beta\n");

  const forward = capture([{ id: "alpha", cwd: alpha }, { id: "beta", cwd: beta }]);
  const reverse = capture([{ id: "beta", cwd: beta }, { id: "alpha", cwd: alpha }]);

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.targets.map((target) => target.targetId), ["alpha", "beta"]);
  assert.notEqual(forward.targets[0]?.revision, forward.targets[1]?.revision);
});

test("capture fails closed when any target cannot produce a Git snapshot", () => {
  const valid = createRepository("valid");
  const invalid = mkdtempSync(join(tmpdir(), "gsd-source-invalid-"));
  tempDirs.add(invalid);

  const result = captureVerificationSourceSnapshot([
    { id: "valid", cwd: valid },
    { id: "invalid", cwd: invalid },
  ]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("non-repository target unexpectedly produced a source proof");
  assert.equal(result.targetId, "invalid");
  assert.match(result.error, /git|repository|snapshot/i);
});

test("pre/post snapshots detect verification-time source drift", () => {
  const cwd = createRepository("drift");
  const before = capture([{ id: "root", cwd }]);
  writeFileSync(join(cwd, "tracked.txt"), "changed during verification\n");
  const after = capture([{ id: "root", cwd }]);

  assert.equal(verificationSourceChanged(before, after), true);
  assert.equal(verificationSourceChanged(after, after), false);
});

test("stability confirmation fails when source mutates between samples", () => {
  const cwd = createRepository("unstable");
  const expected = capture([{ id: "root", cwd }]);
  writeFileSync(join(cwd, "tracked.txt"), "mutated between samples\n");

  const confirmation = confirmVerificationSourceSnapshot([{ id: "root", cwd }], expected);

  assert.equal(confirmation.ok, false);
  if (confirmation.ok) assert.fail("unstable source unexpectedly confirmed");
  assert.equal(confirmation.targetId, "root");
  assert.match(confirmation.error, /changed|stable|snapshot/i);
});

test("workflow state under .gsd does not change the tested source revision", () => {
  const cwd = createRepository("workflow-state");
  mkdirSync(join(cwd, ".gsd"), { recursive: true });
  writeFileSync(join(cwd, ".gsd", "state.json"), "{\"revision\":1}\n");
  git(cwd, ["add", "-f", ".gsd/state.json"]);
  git(cwd, ["commit", "-qm", "workflow state"]);
  const before = capture([{ id: "root", cwd }]);

  writeFileSync(join(cwd, ".gsd", "state.json"), "{\"revision\":2}\n");
  writeFileSync(join(cwd, ".gsd", "projection.md"), "generated\n");
  const after = capture([{ id: "root", cwd }]);

  assert.equal(after.aggregateRevision, before.aggregateRevision);
});
