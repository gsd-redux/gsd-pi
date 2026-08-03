// Project/App: gsd-pi
// File Purpose: Guard the npm release publish set against the drift that left
// @opengsd/cloud-mcp-gateway and @opengsd/daemon unpublished for two releases.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  getRequiredNpmPackageNames,
  getPublishableWorkspacePackages,
  getOrderedWorkspacePublishList,
  getEnginePackageNames,
  getRootPackageName,
  assertReleaseWorkspacePreparationCoverage,
} = require("../lib/npm-release-packages.cjs");
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

test("required npm set includes the previously-missing leaf packages", () => {
  const names = getRequiredNpmPackageNames();
  // The exact packages whose absence caused the broken releases.
  assert.ok(names.includes("@opengsd/cloud-mcp-gateway"), "cloud-mcp-gateway must be published");
  assert.ok(names.includes("@opengsd/daemon"), "daemon must be published");
});

test("required npm set = root + engines + every publishConfig workspace package", () => {
  const names = getRequiredNpmPackageNames();
  for (const expected of [
    getRootPackageName(),
    ...getEnginePackageNames(),
    "@opengsd/contracts",
    "@opengsd/rpc-client",
    "@opengsd/mcp-server",
    "@opengsd/cloud-mcp-gateway",
    "@opengsd/daemon",
  ]) {
    assert.ok(names.includes(expected), `${expected} must be in the required npm set`);
  }
});

test("bundled @gsd/* packages are NOT published", () => {
  const names = getRequiredNpmPackageNames();
  for (const bundled of [
    "@gsd/pi-coding-agent",
    "@gsd/pi-ai",
    "@gsd/pi-tui",
    "@gsd/agent-core",
    "@gsd/native",
  ]) {
    assert.ok(!names.includes(bundled), `${bundled} ships bundled and must not be published`);
  }
});

test("publishable workspaces do not depend on bundled workspaces at runtime", () => {
  const packages = getOrderedWorkspacePublishList();
  const publishedNames = new Set(packages.map((pkg) => pkg.name));

  for (const pkg of packages) {
    const manifestPath = path.join(repoRoot, pkg.dir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
        assert.ok(
          publishedNames.has(dependency),
          `${pkg.name} ${field} contains unpublished workspace dependency ${dependency}`,
        );
      }
    }
  }
});

test("release invariant covers every pnpm workspace root", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "npm-release-workspaces-"));
  try {
    writeFileSync(
      path.join(fixture, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n  - 'extensions/*'\n  - 'web'\n",
    );
    mkdirSync(path.join(fixture, "extensions", "publisher"), { recursive: true });
    writeFileSync(
      path.join(fixture, "extensions", "publisher", "package.json"),
      JSON.stringify({
        name: "@example/publisher",
        publishConfig: { access: "public" },
        dependencies: { "@example/private-web": "workspace:*" },
      }),
    );
    mkdirSync(path.join(fixture, "web"), { recursive: true });
    writeFileSync(
      path.join(fixture, "web", "package.json"),
      JSON.stringify({ name: "@example/private-web", private: true }),
    );

    assert.throws(
      () => getPublishableWorkspacePackages(fixture),
      /@example\/publisher is publishable but dependencies contains unpublished workspace dependency @example\/private-web/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("publish discovery cannot outrun version and prepack preparation", () => {
  assert.throws(
    () => assertReleaseWorkspacePreparationCoverage([
      { dir: "extensions/new-publisher", name: "@example/new-publisher", deps: [] },
    ]),
    /@example\/new-publisher is publishable but extensions\/new-publisher is not included in release preparation/,
  );
});

test("workspace discovery emits portable package directory IDs", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "npm-release-windows-paths-"));
  const workspaceDir = path.win32.join("packages", "mcp-server");
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  writeFileSync(
    path.join(fixture, "pnpm-workspace.yaml"),
    ["packages:", `  - '${workspaceDir}'`, ""].join("\n"),
  );
  mkdirSync(path.join(fixture, workspaceDir), { recursive: true });
  writeFileSync(
    path.join(fixture, workspaceDir, "package.json"),
    JSON.stringify({
      name: "@opengsd/mcp-server",
      publishConfig: { access: "public" },
    }),
  );

  const packages = getPublishableWorkspacePackages(fixture);
  assert.equal(packages[0]?.dir, "packages/mcp-server");
  assert.doesNotThrow(() => assertReleaseWorkspacePreparationCoverage(packages));
});

test("workspace packages are ordered so dependencies publish first", () => {
  const order = getOrderedWorkspacePublishList().map((p) => p.name);
  const idx = (name) => order.indexOf(name);
  // daemon depends on contracts, mcp-server, rpc-client
  assert.ok(idx("@opengsd/contracts") < idx("@opengsd/daemon"));
  assert.ok(idx("@opengsd/rpc-client") < idx("@opengsd/daemon"));
  assert.ok(idx("@opengsd/mcp-server") < idx("@opengsd/daemon"));
  // cloud-mcp-gateway depends on mcp-server; mcp-server depends on contracts + rpc-client
  assert.ok(idx("@opengsd/mcp-server") < idx("@opengsd/cloud-mcp-gateway"));
  assert.ok(idx("@opengsd/contracts") < idx("@opengsd/mcp-server"));
  assert.ok(idx("@opengsd/rpc-client") < idx("@opengsd/mcp-server"));
});

test("--workspace-dirs CLI output has no trailing blank line (regression: empty list must not emit a lone newline)", () => {
  // When getOrderedWorkspacePublishList() returns [], the previous code wrote
  // ''.join('\n') + '\n' = '\n', causing `mapfile -t` in bash to load one blank
  // element and bypass the ${#ENTRIES[@]} -eq 0 early-exit guard.
  const out = execSync("node scripts/lib/npm-release-packages.cjs --workspace-dirs", {
    cwd: repoRoot,
  }).toString();
  if (out === "") return; // empty list → no output at all is the correct fix
  const lines = out.split("\n");
  assert.strictEqual(lines[lines.length - 1], "", "output ends with exactly one trailing newline");
  assert.notStrictEqual(lines[lines.length - 2], "", "no blank line before the trailing newline");
});
