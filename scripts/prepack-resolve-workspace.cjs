#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');

const {
  INTERNAL_PACKAGE_NAMES,
  RELEASE_WORKSPACE_PACKAGE_DIRS,
} = require('./lib/version-sync.cjs');

const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');
const STANDALONE_WEB_PACKAGE_JSON = path.join(ROOT, 'dist', 'web', 'standalone', 'package.json');
const TARGET_PACKAGE_JSONS = [
  ROOT_PACKAGE_JSON,
  STANDALONE_WEB_PACKAGE_JSON,
  ...RELEASE_WORKSPACE_PACKAGE_DIRS.map((dir) => path.join(ROOT, dir, 'package.json')),
];
const DROP_INTERNAL_DEPS_PACKAGE_JSONS = new Set([
  STANDALONE_WEB_PACKAGE_JSON,
]);

// Root internal deps are resolved to ^version (not dropped) so the published
// manifest lists them — npm then satisfies those ranges from the
// bundleDependencies copies packed under node_modules/@gsd (see
// materializeBundleCopies below), which also makes --ignore-scripts installs
// work without the postinstall link step (#2061).

// Recover from a backup left behind by a previous prepack that was hard-killed
// before postpack could restore (SIGKILL skips the EXIT trap). The manifests on
// disk are in the mutated (^version / dropped-deps) state; restore the canonical
// workspace:* originals from the leftover backup BEFORE doing any new work, so we
// never re-resolve already-resolved manifests or — worse — delete the only copy
// of the originals further down when nothing appears to need resolving.
function restoreFromBackupDir(currentDir, relativeDir = '') {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const sourcePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      restoreFromBackupDir(sourcePath, relPath);
      continue;
    }
    const targetPath = path.join(ROOT, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function recoverStaleBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  console.warn('[prepack] Found a stale .prepack-backup from an interrupted run; restoring originals before resolving.');
  restoreFromBackupDir(BACKUP_DIR);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function usesWorkspaceProtocol(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range === 'workspace:*' || range === '*') return true;
    }
  }
  return false;
}

function resolvePackageJson(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const pkg = readJson(filePath);
  if (!usesWorkspaceProtocol(pkg)) return false;

  const version = pkg.version;
  const dropInternalDeps = DROP_INTERNAL_DEPS_PACKAGE_JSONS.has(filePath);
  const relPath = path.relative(ROOT, filePath);
  const backupPath = path.join(BACKUP_DIR, relPath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);

  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range !== 'workspace:*' && range !== '*') continue;
      if (dropInternalDeps) {
        // The published root no longer bundles workspace packages. Internal @gsd/@opengsd
        // packages are NOT on the public registry — they ship inside this tarball under
        // packages/*/dist and are symlinked into node_modules at postinstall by
        // link-workspace-packages.cjs. The staged Next standalone package.json is also
        // packed under dist/web/standalone and is scanned by npm during global install.
        // Leaving internal workspace ranges in either manifest makes npm fail before
        // postinstall can repair links. Drop them; runtime resolution goes through the
        // root package and generated standalone server bundle.
        delete pkg[field][dep];
        changed = true;
      } else {
        // Workspace package manifests ship as files (never npm-installed), so their
        // internal ranges are informational only. Pin to ^version for a clean tarball.
        const resolved = `^${version}`;
        if (pkg[field][dep] !== resolved) {
          pkg[field][dep] = resolved;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeJson(filePath, pkg);
    console.log(
      dropInternalDeps
        ? `[prepack] Removed internal workspace deps from ${relPath} (shipped via files + postinstall link)`
        : `[prepack] Resolved workspace:* internal deps in ${relPath} to ^${version}`,
    );
  }
  return changed;
}

recoverStaleBackup();

let resolvedAny = false;
for (const filePath of TARGET_PACKAGE_JSONS) {
  if (resolvePackageJson(filePath)) {
    resolvedAny = true;
  }
}

if (!resolvedAny && fs.existsSync(BACKUP_DIR)) {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

// Materialize clean (symlink-free) copies of the workspace packages that
// compiled dist code imports as @gsd/*. npm's bundleDependencies walker packs
// whatever sits in node_modules, and pnpm's node_modules/@gsd entries are
// symlinks whose nested node_modules drag in the pnpm virtual store — the
// 537MB-tarball failure that validate-pack's bloat guard exists for. Copying
// package.json + dist (excluding node_modules) gives the bundler real, lean
// directories, and link-workspace-packages.cjs already leaves real directories
// alone, so postinstall coexists with these copies.
const BUNDLED_GSD_PACKAGES = [
  'agent-core',
  'agent-modes',
  'native',
  'pi-agent-core',
  'pi-ai',
  'pi-coding-agent',
  'pi-tui',
];
const BUNDLE_COPY_ENTRIES = ['package.json', 'dist'];

// Package directory names do not all match their @gsd/* import names
// (@gsd/agent-core lives in packages/gsd-agent-core), so resolve by reading
// each candidate's package.json name.
function findPackageDirFor(name) {
  for (const dir of RELEASE_WORKSPACE_PACKAGE_DIRS) {
    const manifestPath = path.join(ROOT, dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      if (readJson(manifestPath).name === `@gsd/${name}`) return path.join(ROOT, dir);
    } catch {
      // unreadable manifest — not our package
    }
  }
  return null;
}

function materializeBundleCopies() {
  const scopeDir = path.join(ROOT, 'node_modules', '@gsd');
  fs.mkdirSync(scopeDir, { recursive: true });
  const failures = [];
  let materialized = 0;
  for (const name of BUNDLED_GSD_PACKAGES) {
    const sourceDir = findPackageDirFor(name);
    if (sourceDir === null || !fs.existsSync(path.join(sourceDir, 'package.json'))) {
      failures.push(`@gsd/${name}: no packages/* directory declares this package name`);
      continue;
    }
    const targetDir = path.join(scopeDir, name);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of BUNDLE_COPY_ENTRIES) {
      const from = path.join(sourceDir, entry);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(targetDir, entry), { recursive: true, verbatimSymlinks: false });
    }
    // Strip dependency fields from the bundled manifest: npm's bundler resolves
    // and packs each declared dep, which under pnpm means dragging the virtual
    // store into the tarball. Bundled copies resolve externals by walking up to
    // the root node_modules — the same mechanism the linked install uses — so
    // the fields are unnecessary and harmful here.
    const bundledPkgPath = path.join(targetDir, 'package.json');
    const bundledPkg = readJson(bundledPkgPath);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      delete bundledPkg[field];
    }
    writeJson(bundledPkgPath, bundledPkg);
    materialized++;
  }
  // A leftover symlink here makes npm's bundle walker dereference the pnpm
  // virtual store — the 537MB tarball failure. Never pack without real dirs.
  for (const name of BUNDLED_GSD_PACKAGES) {
    const target = path.join(scopeDir, name);
    if (!existsSyncF(target)) failures.push(`@gsd/${name}: bundle copy missing under node_modules/@gsd`);
  }
  if (failures.length > 0) {
    console.error('[prepack] ERROR: could not materialize bundle copies:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[prepack] Materialized ${materialized} bundled @gsd/* copies under node_modules/@gsd for --ignore-scripts installs.`);
}

function existsSyncF(target) {
  try {
    return fs.existsSync(target) && fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

materializeBundleCopies();
