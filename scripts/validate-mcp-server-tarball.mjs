#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { getOrderedWorkspacePublishList } = require("./lib/npm-release-packages.cjs");
const targetName = "@opengsd/mcp-server";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packDir = mkdtempSync(join(tmpdir(), "mcp-server-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "mcp-server-install-"));
const npmCacheDir = mkdtempSync(join(tmpdir(), "mcp-server-npm-cache-"));

function runNpm(args, options = {}) {
  return execFileSync(npmCommand, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: npmCacheDir,
      npm_config_fund: "false",
      npm_config_loglevel: "error",
    },
    ...options,
  });
}

function getPackageClosure(packages, packageName) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const closure = new Set();

  function visit(name) {
    if (closure.has(name)) return;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`Publishable workspace package not found: ${name}`);
    for (const dependency of pkg.deps) visit(dependency);
    closure.add(name);
  }

  visit(packageName);
  return packages.filter((pkg) => closure.has(pkg.name));
}

try {
  const packages = getPackageClosure(getOrderedWorkspacePublishList(), targetName);
  for (const pkg of packages) {
    const distDir = join(root, pkg.dir, "dist");
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.name} build output is missing; run pnpm run build:mcp-server first`);
    }
  }

  execFileSync(process.execPath, [join(root, "scripts", "prepack-resolve-workspace.cjs")], {
    cwd: root,
    stdio: "inherit",
  });

  const tarballs = new Map();
  for (const pkg of packages) {
    const output = runNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      { cwd: join(root, pkg.dir) },
    );
    const packed = JSON.parse(output)[0];
    if (!packed?.filename) throw new Error(`npm pack returned no tarball for ${pkg.name}`);
    tarballs.set(pkg.name, join(packDir, packed.filename));
  }

  const dependencies = Object.fromEntries(
    packages.map((pkg) => [pkg.name, pathToFileURL(tarballs.get(pkg.name)).href]),
  );
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "mcp-server-tarball-smoke", private: true, dependencies }, null, 2)}\n`,
  );
  runNpm(["install", "--ignore-scripts"], { cwd: installDir });

  const installedManifestPath = join(installDir, "node_modules", "@opengsd", "mcp-server", "package.json");
  const installedManifestText = readFileSync(installedManifestPath, "utf8");
  if (installedManifestText.includes("workspace:") || installedManifestText.includes("@gsd/pi-ai")) {
    throw new Error("packed @opengsd/mcp-server manifest contains an unpublished workspace dependency");
  }
  const installedManifest = JSON.parse(installedManifestText);

  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", "const m = await import('@opengsd/mcp-server'); if (typeof m.createMcpServer !== 'function') process.exit(1)"],
    { cwd: installDir, stdio: "inherit" },
  );

  const binEntry = installedManifest.bin?.["gsd-mcp-server"];
  if (typeof binEntry !== "string") throw new Error("packed @opengsd/mcp-server has no gsd-mcp-server bin");
  const binUrl = pathToFileURL(resolve(dirname(installedManifestPath), binEntry)).href;
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `process.stdin.destroy(); await import(${JSON.stringify(binUrl)})`,
  ], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });

  console.log("@opengsd/mcp-server standalone tarball install, import, and bin are valid.");
} finally {
  try {
    execFileSync(process.execPath, [join(root, "scripts", "postpack-restore-workspace.cjs")], {
      cwd: root,
      stdio: "inherit",
    });
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}
