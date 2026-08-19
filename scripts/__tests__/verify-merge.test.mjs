import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";

const verifyMergeScript = readFileSync("scripts/verify-merge.sh", "utf8");
const verifyMergeNeededScript = readFileSync("scripts/verify-merge-needed.sh", "utf8");

test("verify:merge compiles test artifacts once and reuses compiled suites", () => {
  assert.equal((verifyMergeScript.match(/pnpm run test:compile/g) ?? []).length, 1);
  assert.match(verifyMergeScript, /pnpm run test:unit:compiled/);
  assert.match(verifyMergeScript, /pnpm run test:packages:compiled/);
  assert.doesNotMatch(verifyMergeScript, /pnpm run test:unit\b(?!:compiled)/);
  assert.doesNotMatch(verifyMergeScript, /pnpm run test:packages\b(?!:compiled)/);
});

test("verify:merge uses the stale-aware web host build path", () => {
  assert.match(verifyMergeScript, /node scripts\/build-web-if-stale\.cjs/);
  assert.doesNotMatch(verifyMergeScript, /pnpm run build:web-host/);
});

test("verify:merge mirrors CI portability gating for native package tests", () => {
  assert.match(verifyMergeScript, /bash scripts\/ci-classify-changes\.sh/);
  assert.ok(
    verifyMergeScript.includes("PORTABILITY_CHANGED=\"$(sed -n 's/^portability-changed=//p'"),
  );
  assert.match(verifyMergeScript, /GSD_SKIP_NATIVE_PACKAGE_TESTS=0 pnpm run test:packages:compiled/);
  assert.match(verifyMergeScript, /GSD_SKIP_NATIVE_PACKAGE_TESTS=1 pnpm run test:packages:compiled/);
});

test("verify:merge preserves pre-existing required checks", () => {
  assert.match(verifyMergeScript, /pnpm --filter @gsd\/pi-ai test/);
  assert.match(verifyMergeScript, /pnpm run test:integration/);
  assert.match(verifyMergeScript, /pnpm run test:e2e/);
  assert.match(verifyMergeScript, /pnpm run validate-pack/);
  assert.match(verifyMergeScript, /pnpm run verify:workspace-coverage/);
  assert.match(verifyMergeScript, /pnpm run verify:extension-coverage/);
});

test("verify:merge:needed tolerates the literal `--` that `pnpm run ... -- --base` forwards", () => {
  // Reproduces the exact invocation documented in CONTRIBUTING.md / package.json:
  // `pnpm run verify:merge:needed -- --base <ref> --head <ref>` forwards a literal
  // leading `--` token to the underlying script (npm/pnpm do not strip it).
  const result = spawnSync(
    "bash",
    ["scripts/verify-merge-needed.sh", "--", "--base", "HEAD", "--head", "HEAD"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Base ref: HEAD/);
  assert.match(result.stdout, /Head ref: HEAD/);
});

test("verify:merge:needed script is exposed in package.json and reuses CI classification", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["verify:merge:needed"], "bash scripts/verify-merge-needed.sh");
  assert.match(verifyMergeNeededScript, /bash scripts\/ci-classify-changes\.sh/);
  assert.match(verifyMergeNeededScript, /VERIFY_MERGE_VERBOSE/);
  assert.match(verifyMergeNeededScript, /verify:merge is not required/);
  assert.match(verifyMergeNeededScript, /verify:merge is required/);
});

test("verify:merge:needed rejects --base/--head with no value instead of an unbound-variable crash", () => {
  for (const flag of ["--base", "--head"]) {
    const result = spawnSync("bash", ["scripts/verify-merge-needed.sh", flag], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`${flag} requires a value`));
  }
});

test("verify:merge:needed rejects unknown flags with a usage message", () => {
  const result = spawnSync("bash", ["scripts/verify-merge-needed.sh", "--nope"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: bash scripts\/verify-merge-needed\.sh/);
});

test("verify:merge:needed warns when the working tree has uncommitted/untracked changes", () => {
  const scratchFile = "scripts/__tests__/.verify-merge-needed-scratch-file";
  writeFileSync(scratchFile, "scratch\n");
  try {
    const result = spawnSync(
      "bash",
      ["scripts/verify-merge-needed.sh", "--base", "HEAD", "--head", "HEAD"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /uncommitted or untracked changes present/);
  } finally {
    unlinkSync(scratchFile);
  }
});

test("verify:merge:needed does not warn about the working tree when --head is an explicit non-HEAD ref", () => {
  const scratchFile = "scripts/__tests__/.verify-merge-needed-scratch-file-2";
  writeFileSync(scratchFile, "scratch\n");
  try {
    const result = spawnSync(
      "bash",
      ["scripts/verify-merge-needed.sh", "--base", "HEAD~1", "--head", "HEAD~1"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /uncommitted or untracked changes present/);
  } finally {
    unlinkSync(scratchFile);
  }
});

test("verify:merge:needed fails safe (does not crash) when classification itself fails", (t) => {
  // Reproduces the exact CI failure this was written to fix: on a shallow/single-commit
  // checkout, `git diff --name-only <base> <head>` AND ci-classify-changes.sh's own
  // `HEAD~1` fallback both fail with exit 128 ("unknown revision"). A normal, full-history
  // local checkout can't reproduce that fallback failure organically (HEAD~1 always
  // resolves here), so this test forces the same failure mode directly by temporarily
  // swapping in a classify script that always fails, and restores the original after.
  const classifyPath = "scripts/ci-classify-changes.sh";
  const original = readFileSync(classifyPath, "utf8");
  writeFileSync(classifyPath, "#!/usr/bin/env bash\nexit 1\n");
  t.after(() => writeFileSync(classifyPath, original));

  const result = spawnSync(
    "bash",
    ["scripts/verify-merge-needed.sh", "--base", "HEAD~1", "--head", "HEAD"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /classification failed/);
  assert.match(result.stdout, /Recommendation: verify:merge is required/);
});

test("verify:merge and verify:merge:needed both wrap the classify call so a non-zero exit can't crash the script", () => {
  for (const script of [verifyMergeScript, verifyMergeNeededScript]) {
    assert.match(script, /bash scripts\/ci-classify-changes\.sh.*\|\| CLASSIFY_EXIT=\$\?/s);
    assert.match(script, /CLASSIFY_EXIT.*-ne 0.*-s.*CLASSIFY_OUTPUT/s);
  }
});
