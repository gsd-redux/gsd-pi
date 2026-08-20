// Regression guard: test confidence tier map stays wired in package.json.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("verify:merge and verify:full alias stay aligned with CI PR blocking parity", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["verify:merge"], /verify-merge\.sh/);
  assert.match(pkg.scripts["verify:full"], /run verify:merge$/);
  assert.match(pkg.scripts["audit:test-confidence"], /audit-test-confidence\.mjs/);
});

test("verify:merge stages the native test addon like CI (#1582)", () => {
  const script = readFileSync("scripts/verify-merge.sh", "utf8");
  assert.match(script, /build:native:test/);
  assert.match(script, /dist-test\/native\/addon/);
  assert.match(script, /GSD_NATIVE_PREFER_LOCAL=1/);
});

test("audit:test-confidence --strict passes when tier map is intact", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-confidence.mjs", "--strict"], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || "audit:test-confidence --strict failed",
  );
});
