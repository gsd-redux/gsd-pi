// gsd-pi + scripts/lib/npm-release-packages.cjs
// Single source of truth for WHICH packages must reach npm for a release.
//
// Why this exists: the publish list used to be hardcoded in build-native.yml as
// "@opengsd/contracts @opengsd/rpc-client @opengsd/mcp-server", which silently
// omitted @opengsd/cloud-mcp-gateway and @opengsd/daemon — so two releases went
// out with those packages missing from npm. This module derives the set from
// each package's own manifest so adding a publishable package can never again be
// forgotten by an out-of-date list.
//
// The required npm set for a release is:
//   1. the root package (@opengsd/gsd-pi)
//   2. the native platform packages (@opengsd/engine-*), one per platform
//   3. every pnpm workspace package that opts in via "publishConfig"
//      (the @gsd/* packages have no publishConfig — they ship bundled inside the
//      gsd-pi tarball and are linked at install time, so they are NOT published)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PLATFORM_PACKAGE_DIRS, RELEASE_WORKSPACE_PACKAGE_DIRS } = require('./version-sync.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const INTERNAL_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getWorkspacePatterns(workspacePath) {
  const patterns = [];
  let inPackages = false;
  for (const line of fs.readFileSync(workspacePath, 'utf8').split(/\r?\n/)) {
    if (/^packages:\s*(?:#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^#\s]+))/);
    if (match) patterns.push(match[1] ?? match[2] ?? match[3]);
  }
  return patterns;
}

function expandWorkspacePattern(repoRoot, pattern) {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  const segments = normalized.split('/');
  if (path.isAbsolute(normalized) || segments.includes('..')) {
    throw new Error(`Unsafe pnpm workspace pattern: ${pattern}`);
  }
  if (segments.some((segment) => segment !== '*' && /[*?{}[\]]/.test(segment))) {
    throw new Error(`Unsupported pnpm workspace pattern: ${pattern}`);
  }

  let directories = [''];
  for (const segment of segments) {
    if (segment !== '*') {
      directories = directories.map((directory) => path.join(directory, segment));
      continue;
    }
    directories = directories.flatMap((directory) => {
      const absolute = path.join(repoRoot, directory);
      if (!fs.existsSync(absolute)) return [];
      return fs.readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name));
    });
  }
  return directories.filter((directory) => fs.existsSync(path.join(repoRoot, directory, 'package.json')));
}

function getWorkspaceManifestPaths(repoRoot) {
  const workspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspacePath)) return [];
  const patterns = getWorkspacePatterns(workspacePath);
  const excluded = new Set(
    patterns
      .filter((pattern) => pattern.startsWith('!'))
      .flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern.slice(1))),
  );
  return [...new Set(
    patterns
      .filter((pattern) => !pattern.startsWith('!'))
      .flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern))
      .filter((directory) => !excluded.has(directory)),
  )].map((directory) => path.join(directory, 'package.json'));
}

/** Root package name (@opengsd/gsd-pi). */
function getRootPackageName() {
  return readJson(path.join(REPO_ROOT, 'package.json')).name;
}

/** Native platform package names, derived from version-sync's platform list. */
function getEnginePackageNames() {
  return PLATFORM_PACKAGE_DIRS.map((dir) => `@opengsd/engine-${dir.replace('native/npm/', '')}`);
}

/**
 * Workspace packages that opt into npm publishing via
 * "publishConfig" (and are not marked private). Returns { dir, name, deps }
 * where deps is the subset of this set that the package depends on.
 */
function getPublishableWorkspacePackages(repoRoot = REPO_ROOT) {
  const workspaces = getWorkspaceManifestPaths(repoRoot).map((manifest) => {
    const pkgJsonPath = path.join(repoRoot, manifest);
    const pkg = readJson(pkgJsonPath);
    const dir = path.dirname(manifest).replaceAll('\\', '/');
    return { dir, name: pkg.name, pkg };
  }).filter(({ name }) => name);
  const pkgs = workspaces.filter(({ pkg }) => pkg.private !== true && pkg.publishConfig);
  const workspaceNames = new Set(workspaces.map((p) => p.name));
  const names = new Set(pkgs.map((p) => p.name));
  return pkgs.map(({ dir, name, pkg }) => {
    const deps = new Set();
    for (const field of INTERNAL_DEP_FIELDS) {
      for (const dep of Object.keys(pkg[field] || {})) {
        if (!workspaceNames.has(dep)) continue;
        if (!names.has(dep)) {
          throw new Error(`${name} is publishable but ${field} contains unpublished workspace dependency ${dep}`);
        }
        deps.add(dep);
      }
    }
    return { dir, name, deps: [...deps] };
  });
}

function assertReleaseWorkspacePreparationCoverage(packages) {
  const preparedDirectories = new Set(RELEASE_WORKSPACE_PACKAGE_DIRS);
  for (const pkg of packages) {
    if (!preparedDirectories.has(pkg.dir)) {
      throw new Error(`${pkg.name} is publishable but ${pkg.dir} is not included in release preparation`);
    }
  }
}

/**
 * Publishable workspace packages in DEPENDENCY order (a package always appears
 * after every package it depends on) so `npm publish` of one never references a
 * not-yet-published internal package. Throws on a dependency cycle.
 */
function getOrderedWorkspacePublishList() {
  const packages = getPublishableWorkspacePackages();
  assertReleaseWorkspacePreparationCoverage(packages);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const ordered = [];
  const placed = new Set();
  const visiting = new Set();

  const visit = (name) => {
    if (placed.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Dependency cycle among publishable workspace packages involving ${name}`);
    }
    visiting.add(name);
    for (const dep of byName.get(name).deps) visit(dep);
    visiting.delete(name);
    placed.add(name);
    ordered.push(byName.get(name));
  };

  // Stable input order keeps output deterministic for equal-rank packages.
  for (const p of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(p.name);
  return ordered;
}

/**
 * Every package name that MUST exist on npm at the release version, in publish
 * order: workspace deps first, then engines, then the root package. Used by both
 * the publish step and the pre-release verification gate.
 */
function getRequiredNpmPackageNames() {
  return [
    ...getOrderedWorkspacePublishList().map((p) => p.name),
    ...getEnginePackageNames(),
    getRootPackageName(),
  ];
}

module.exports = {
  REPO_ROOT,
  getRootPackageName,
  getEnginePackageNames,
  getPublishableWorkspacePackages,
  assertReleaseWorkspacePreparationCoverage,
  getOrderedWorkspacePublishList,
  getRequiredNpmPackageNames,
};

if (require.main === module) {
  // `node scripts/lib/npm-release-packages.cjs [--workspace-dirs]`
  // --workspace-dirs emits "<name>:<workspace-dir>" lines in dependency order
  // (consumed by scripts/publish-workspace-packages.sh, which publishes each
  // package from its own directory). Default emits the full required name list.
  // Guard: only write when non-empty so `mapfile -t` in bash doesn't receive a
  // lone '\n' that loads one blank element and bypasses the empty-list exit.
  const arg = process.argv[2];
  if (arg === '--workspace-dirs') {
    const entries = getOrderedWorkspacePublishList().map((p) => `${p.name}:${p.dir}`);
    if (entries.length) process.stdout.write(entries.join('\n') + '\n');
  } else {
    const names = getRequiredNpmPackageNames();
    if (names.length) process.stdout.write(names.join('\n') + '\n');
  }
}
