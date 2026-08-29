// Project/App: gsd-pi
// File Purpose: Unit tests for the npm-publish fold-step guard (#2067). The
// detection expression here decides whether a release commit ships a lockfile
// that breaks every downstream frozen-lockfile install, so it is exercised
// against real pnpm lockfile serialization instead of only being trusted to
// the release run that happens to execute it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENGINE_PLATFORMS,
  missingEngines,
} from "../release-lockfile-guard.mjs";

const COMPLETE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "optionalDependencies:",
  "  '@opengsd/engine-darwin-arm64@1.17.0':",
  "    specifier: 1.17.0",
  "  '@opengsd/engine-darwin-x64@1.17.0':",
  "    specifier: 1.17.0",
  "  '@opengsd/engine-linux-arm64-gnu@1.17.0':",
  "    specifier: 1.17.0",
  "  '@opengsd/engine-linux-x64-gnu@1.17.0':",
  "    specifier: 1.17.0",
  "  '@opengsd/engine-win32-x64-msvc@1.17.0':",
  "    specifier: 1.17.0",
  "",
].join("\n");

test("ENGINE_PLATFORMS is the canonical five-platform engine set", () => {
  assert.deepEqual(ENGINE_PLATFORMS, [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64-gnu",
    "linux-x64-gnu",
    "win32-x64-msvc",
  ]);
});

test("missingEngines accepts a complete lockfile", () => {
  assert.deepEqual(
    missingEngines({ lockfileContent: COMPLETE_LOCKFILE, version: "1.17.0" }),
    [],
  );
});

test("missingEngines rejects a lockfile with no engine entries", () => {
  assert.deepEqual(
    missingEngines({ lockfileContent: "lockfileVersion: '9.0'\n", version: "1.17.0" }),
    [...ENGINE_PLATFORMS],
  );
});

test("missingEngines names only the platforms that are absent", () => {
  const partial = COMPLETE_LOCKFILE.replace(
    /'@opengsd\/engine-win32-x64-msvc@1\.17\.0':\n\s+specifier: 1\.17\.0\n/,
    "",
  );
  assert.deepEqual(
    missingEngines({ lockfileContent: partial, version: "1.17.0" }),
    ["win32-x64-msvc"],
  );
});

test("missingEngines is version-sensitive: a complete older lockfile is not complete", () => {
  assert.deepEqual(
    missingEngines({ lockfileContent: COMPLETE_LOCKFILE, version: "1.18.0" }),
    [...ENGINE_PLATFORMS],
  );
});

test("missingEngines does not confuse a version prefix with an exact entry", () => {
  // '1.17.0' must not satisfy a probe for '1.17' — the trailing colon in the
  // key match is what keeps exact-version semantics.
  const tricky = COMPLETE_LOCKFILE.replace(/1\.17\.0/g, "1.17.01");
  assert.deepEqual(
    missingEngines({ lockfileContent: tricky, version: "1.17.0" }),
    [...ENGINE_PLATFORMS],
  );
});

test("CLI verify-lockfile exits 0 and reports success for a complete lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-guard-"));
  try {
    const lockfile = join(dir, "pnpm-lock.yaml");
    writeFileSync(lockfile, COMPLETE_LOCKFILE);
    const res = spawnSync(
      process.execPath,
      [new URL("../release-lockfile-guard.mjs", import.meta.url).pathname, "verify-lockfile", "--version", "1.17.0", "--lockfile", lockfile],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /All 5 engine packages resolve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI verify-lockfile exits 1 and lists missing engines", () => {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-guard-"));
  try {
    const lockfile = join(dir, "pnpm-lock.yaml");
    writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
    const res = spawnSync(
      process.execPath,
      [new URL("../release-lockfile-guard.mjs", import.meta.url).pathname, "verify-lockfile", "--version", "1.17.0", "--lockfile", lockfile],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /win32-x64-msvc/);
    assert.match(res.stderr, /darwin-arm64/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI verify-lockfile exits 2 on usage errors", () => {
  const guardCli = new URL("../release-lockfile-guard.mjs", import.meta.url).pathname;
  const res = spawnSync(process.execPath, [guardCli], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage:/);
});
