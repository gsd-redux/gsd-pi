// Project/App: gsd-pi
// File Purpose: Regression tests for installer package dependencies.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/** External deps that postinstall repair must be able to materialize from the package root. */
const REQUIRED_ROOT_EXTERNALS = [
  "@modelcontextprotocol/sdk",
  "minimatch",
  "picomatch",
  "proper-lockfile",
  "undici",
  "yaml",
];

test("installer deps module exposes postinstall orchestration", async () => {
  const { runPostinstallDeps, linkWorkspacePackages, repairPackageDependencies } =
    await import("../install/deps.js");
  assert.equal(typeof runPostinstallDeps, "function");
  assert.equal(typeof linkWorkspacePackages, "function");
  assert.equal(typeof repairPackageDependencies, "function");
});

test("installer package manager detection ignores unrelated pnpm directory names", async () => {
  const { detectPackageManager } = await import("../install/npm-global.js");
  assert.equal(
    detectPackageManager({}, "/home/user/projects/pnpm/app/node_modules/@opengsd/gsd-pi/dist/loader.js"),
    "npm",
  );
  assert.equal(
    detectPackageManager({ npm_execpath: "/opt/tools/pnpm/wrapper/npm-cli.js" }, ""),
    "npm",
  );
  assert.equal(
    detectPackageManager({}, "/opt/library/pnpm/wrapper/npm-cli.js"),
    "npm",
  );
});

test("installer package manager detection uses precise pnpm bin directories", async () => {
  const { detectPackageManager } = await import("../install/npm-global.js");
  assert.equal(
    detectPackageManager({ PNPM_HOME: "/custom/pnpm-home" }, "/custom/pnpm-home/gsd"),
    "pnpm",
  );
  assert.equal(
    detectPackageManager(
      { PNPM_HOME: "/custom/pnpm-home", npm_config_user_agent: "npm/10.0.0 node/v22.0.0" },
      "/custom/pnpm-home/gsd",
    ),
    "npm",
  );
});

test("installer tarball declares extension-critical externals at the package root", () => {
  for (const dep of REQUIRED_ROOT_EXTERNALS) {
    assert.ok(pkg.dependencies[dep], `root package must depend on ${dep}`);
  }
});

test("workspace package bins point to checked-in shims instead of ignored dist output", () => {
  const packages = [
    "packages/pi-ai/package.json",
    "packages/mcp-server/package.json",
    "packages/daemon/package.json",
  ];

  for (const packageJsonPath of packages) {
    const workspacePkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    for (const [binName, binPath] of Object.entries(workspacePkg.bin ?? {})) {
      assert.ok(
        !String(binPath).startsWith("./dist/"),
        `${workspacePkg.name} bin ${binName} must not target ignored dist output`,
      );

      const resolvedBin = join(dirname(packageJsonPath), String(binPath));
      assert.ok(existsSync(resolvedBin), `${workspacePkg.name} bin ${binName} target must exist before build`);
    }
  }
});
