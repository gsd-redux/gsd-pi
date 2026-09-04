import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression test for open-gsd/gsd-pi #4787.
 *
 * Background: `computeResourceFingerprint` previously hashed the relative
 * file path + file size only. Same-byte-length edits to bundled prompt
 * templates (e.g. the #4570 retry-cap fix to parallel-research-slices.md)
 * slipped through the fingerprint gate in `initResources`, so existing
 * installs silently kept serving the stale cached copy from
 * `~/.gsd/agent/extensions/gsd/prompts/`.
 *
 * The fix hashes file CONTENTS (sha256) instead of just size — any edit,
 * regardless of length, produces a different fingerprint and triggers a
 * resync on next launch.
 */

test("computeResourceFingerprint detects same-size content edits (#4787)", async (t) => {
  const { computeResourceFingerprint } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-fingerprint-content-"));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  const dirA = join(tmp, "bundled-a");
  const dirB = join(tmp, "bundled-b");
  mkdirSync(join(dirA, "prompts"), { recursive: true });
  mkdirSync(join(dirB, "prompts"), { recursive: true });

  // Same byte length (32 bytes each), different content — mirrors the
  // real-world #4787 scenario where a hotfix edit keeps the file size
  // stable but changes load-bearing instructions.
  const contentA = "retry subagent once then BLOCKER"; // 32 bytes
  const contentB = "retry subagent forever never stp"; // 32 bytes
  assert.equal(Buffer.byteLength(contentA), Buffer.byteLength(contentB));

  writeFileSync(join(dirA, "prompts", "foo.md"), contentA);
  writeFileSync(join(dirB, "prompts", "foo.md"), contentB);

  const hashA = computeResourceFingerprint(dirA);
  const hashB = computeResourceFingerprint(dirB);

  assert.notEqual(
    hashA,
    hashB,
    "same-size, different-content trees must yield different fingerprints",
  );
});

test("syncResourceDir overwrites same-size stale content on refresh (#4787)", async (t) => {
  const { syncResourceDir } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-sync-samesize-"));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });

  const bundled = join(tmp, "bundled", "prompts");
  const installed = join(tmp, "installed", "prompts");
  mkdirSync(bundled, { recursive: true });
  mkdirSync(installed, { recursive: true });

  // Bundled (new): the post-#4570 fix template
  const newContent = "retry subagent once then BLOCKER";
  // Installed (stale): pre-#4570 template with the same byte length
  const staleContent = "retry subagent forever never stp";
  assert.equal(Buffer.byteLength(newContent), Buffer.byteLength(staleContent));

  writeFileSync(join(bundled, "parallel-research-slices.md"), newContent);
  writeFileSync(join(installed, "parallel-research-slices.md"), staleContent);

  // syncResourceDir always force-copies; this guards that the copy path
  // itself overwrites regardless of size.
  syncResourceDir(join(tmp, "bundled"), join(tmp, "installed"));

  const actual = readFileSync(join(installed, "parallel-research-slices.md"), "utf-8");
  assert.equal(
    actual,
    newContent,
    "installed prompt must be overwritten with bundled content even when sizes match",
  );
});

/**
 * Regression test for open-gsd/gsd-pi #2106.
 *
 * Installed packages ship a precomputed `.managed-resources-content-hash` file
 * that never changes after install. `initResources` must therefore compare the
 * manifest hash against a LIVE fingerprint of the bundled tree — comparing it
 * against the shipped file makes same-version edits (npm link dev, hotfixes)
 * invisible, which is exactly the drift the hash was added to catch.
 *
 * These tests use setBundledResourcesDirForTests to mount a fake bundle so the
 * shipped-hash scenario can be reproduced without touching the real
 * src/resources/ tree.
 */
function buildFakeBundledResources(rootDir: string): string {
  mkdirSync(join(rootDir, "extensions", "gsd"), { recursive: true });
  mkdirSync(join(rootDir, "shared"), { recursive: true });
  mkdirSync(join(rootDir, "agents"), { recursive: true });
  writeFileSync(join(rootDir, "extensions", "gsd", "index.js"), "export const version = 1;\n");
  writeFileSync(join(rootDir, "shared", "note.md"), "retry subagent once then BLOCKER");
  writeFileSync(join(rootDir, "agents", "scout.md"), "scout\n");
  writeFileSync(join(rootDir, "GSD-WORKFLOW.md"), "workflow\n");
  return rootDir;
}

test("initResources detects same-version bundled edits even when the shipped precomputed hash matches the manifest (#2106)", async (t) => {
  const { initResources, computeResourceFingerprint, setBundledResourcesDirForTests } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-live-fingerprint-"));
  const fakeResources = buildFakeBundledResources(join(tmp, "resources"));
  const agentDir = join(tmp, "agent");
  const skillsDir = join(tmp, "skills"); // outside agentDir: skips ~/.agents/skills cleanup
  t.after(() => {
    setBundledResourcesDirForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  // Ship a precomputed hash like scripts/copy-resources.cjs does at build time.
  const shippedHash = computeResourceFingerprint(fakeResources);
  writeFileSync(join(fakeResources, ".managed-resources-content-hash"), `${shippedHash}\n`);

  // First initResources: full sync. The manifest records the shipped value,
  // mirroring a real install where manifest.contentHash === shipped hash.
  setBundledResourcesDirForTests(fakeResources);
  initResources(agentDir, skillsDir);

  const manifestPath = join(agentDir, "managed-resources.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  assert.equal(manifest.contentHash, shippedHash, "manifest records the shipped precomputed hash");

  // Post-install hotfix: same-size edit to a bundled file. The shipped hash
  // file is immutable, so it no longer reflects the tree.
  const edited = "retry subagent forever never stp";
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength("retry subagent once then BLOCKER"));
  writeFileSync(join(fakeResources, "shared", "note.md"), edited);

  const markerPath = join(agentDir, "extensions", "gsd", "marker.txt");
  writeFileSync(markerPath, "present");

  initResources(agentDir, skillsDir);

  assert.equal(
    existsSync(markerPath),
    false,
    "same-version bundled drift must trigger a full resync (extensions/ rebuilt)",
  );
  assert.equal(
    readFileSync(join(agentDir, "shared", "note.md"), "utf-8"),
    edited,
    "the edited bundled content must reach the agent dir",
  );

  // Convergence: the resync must stamp the manifest with the LIVE fingerprint
  // of the edited tree, so the next launch matches again. Recording the stale
  // shipped value here would make every launch resync forever (#2106).
  const manifestAfterResync = JSON.parse(readFileSync(manifestPath, "utf-8"));
  assert.equal(
    manifestAfterResync.contentHash,
    computeResourceFingerprint(fakeResources),
    "post-resync manifest must record the live fingerprint, not the stale shipped value",
  );

  const thirdCallMarker = join(agentDir, "extensions", "gsd", "marker3.txt");
  writeFileSync(thirdCallMarker, "present");

  initResources(agentDir, skillsDir);

  assert.equal(
    existsSync(thirdCallMarker),
    true,
    "third launch must early-return again (drift resync converges after one run)",
  );
});

test("initResources early-returns when the bundle is unmodified (no pointless resync)", async (t) => {
  const { initResources, computeResourceFingerprint, setBundledResourcesDirForTests } = await import("../resource-loader.ts");

  const tmp = mkdtempSync(join(tmpdir(), "gsd-live-fingerprint-clean-"));
  const fakeResources = buildFakeBundledResources(join(tmp, "resources"));
  const agentDir = join(tmp, "agent");
  const skillsDir = join(tmp, "skills");
  t.after(() => {
    setBundledResourcesDirForTests(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  const shippedHash = computeResourceFingerprint(fakeResources);
  writeFileSync(join(fakeResources, ".managed-resources-content-hash"), `${shippedHash}\n`);

  setBundledResourcesDirForTests(fakeResources);
  initResources(agentDir, skillsDir);

  const markerPath = join(agentDir, "extensions", "gsd", "marker.txt");
  writeFileSync(markerPath, "present");

  // Unmodified bundle: steady state — the full copy must be skipped.
  initResources(agentDir, skillsDir);

  assert.equal(
    existsSync(markerPath),
    true,
    "unmodified bundle must keep the early-return (no resync)",
  );
});
