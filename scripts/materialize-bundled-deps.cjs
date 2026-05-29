#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'materialized-bundled-deps.json');

function depInstallPath(dep) {
  if (dep.startsWith('@')) {
    const [scope, name] = dep.split('/');
    return path.join(ROOT, 'node_modules', scope, name);
  }
  return path.join(ROOT, 'node_modules', dep);
}

function resolveSymlinkTarget(linkPath) {
  const linkTarget = fs.readlinkSync(linkPath);
  return path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(linkPath), linkTarget);
}

// Entries copied when materializing an internal @gsd/* workspace package. We
// deliberately exclude node_modules: a @gsd package's runtime externals (openai,
// undici, the AI SDKs, …) are all declared on the ROOT package's dependencies and
// resolve from the root node_modules at runtime. Copying the package's own nested
// node_modules would make npm's bundle walker recurse the entire pnpm virtual store
// (node_modules/.pnpm) into the tarball — the source of the 85k-file / 537MB bloat.
const GSD_SHIP_ENTRIES = ['dist', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];

function materializeGsdPackage(dep, target, manifest) {
  const linkTarget = fs.readlinkSync(target);
  const source = resolveSymlinkTarget(target);
  fs.unlinkSync(target);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of GSD_SHIP_ENTRIES) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, entry), { recursive: true, dereference: true });
  }
  // Strip the dependency fields from the SHIPPED manifest. npm's bundle walker
  // reads these and resolves each entry up to the root node_modules, which would
  // bundle the entire external closure (@aws-sdk, @smithy, the AI SDKs, …) and
  // recurse through node_modules/.pnpm. At runtime Node resolves these externals
  // by walking up to the root node_modules (where they are declared as root
  // dependencies), so the @gsd manifest does not need to declare them.
  const shippedPkgPath = path.join(target, 'package.json');
  if (fs.existsSync(shippedPkgPath)) {
    const shippedPkg = JSON.parse(fs.readFileSync(shippedPkgPath, 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      delete shippedPkg[field];
    }
    fs.writeFileSync(shippedPkgPath, `${JSON.stringify(shippedPkg, null, 2)}\n`);
  }
  manifest.push({ dep, linkTarget, flattened: true });
}

function materialize() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bundled = rootPkg.bundledDependencies || [];
  const manifest = [];

  for (const dep of bundled) {
    const target = depInstallPath(dep);
    if (!fs.existsSync(target)) {
      throw new Error(`[materialize-bundled-deps] Missing bundled dependency in node_modules: ${dep}`);
    }
    if (!fs.lstatSync(target).isSymbolicLink()) continue;

    if (dep.startsWith('@gsd/')) {
      // Internal workspace package: ship dist only, never its nested node_modules.
      materializeGsdPackage(dep, target, manifest);
      continue;
    }

    const linkTarget = fs.readlinkSync(target);
    const source = resolveSymlinkTarget(target);
    fs.unlinkSync(target);
    fs.cpSync(source, target, { recursive: true });
    manifest.push({ dep, linkTarget });
  }

  if (manifest.length > 0) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[materialize-bundled-deps] Materialized ${manifest.length} symlinked bundled dependencies for npm pack`);
  }
}

function restore() {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of manifest) {
    const target = depInstallPath(entry.dep);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.symlinkSync(entry.linkTarget, target);
  }
  fs.rmSync(MANIFEST_PATH, { force: true });
  console.log('[materialize-bundled-deps] Restored symlinked bundled dependencies');
}

const mode = process.argv[2] ?? 'materialize';
if (mode === 'restore') {
  restore();
} else {
  materialize();
}
