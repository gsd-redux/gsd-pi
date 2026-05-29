#!/usr/bin/env node
'use strict';

/**
 * prune-bundled-externals.cjs
 *
 * Runs during `prepack` (after materialize-bundled-deps) and is reverted by
 * `postpack`. It temporarily removes external dependencies from node_modules so
 * `npm pack` does NOT bundle them into the published tarball.
 *
 * Why: `npm` bundles the full dependency *closure* of everything listed in
 * `bundledDependencies`. The private @gsd/* workspace packages must be bundled
 * (they are not published to the registry), but bundling them drags in their
 * entire external closure — the AI-provider SDKs (@aws-sdk, openai, @mistralai,
 * @anthropic-ai, @google/genai, …), playwright, sharp, etc. That blew the tarball
 * from the npm-era ~9.6k files to ~76k files, which the npm registry rejects on
 * publish ("too many files").
 *
 * The npm-era package bundled nothing and installed every dependency from the
 * registry. We keep that model for the heavy externals while still bundling the
 * small set needed for the offline `npm install -g --ignore-scripts` (npx) path:
 * the explicitly listed external `bundledDependencies` plus their transitive
 * `dependencies` closure. Everything else is pruned from node_modules before pack
 * and therefore installs from the registry at user-install time (it remains
 * declared as a dependency of the bundled @gsd/* packages, so npm resolves it).
 *
 * Internal workspace packages (@gsd/*, @opengsd/*) and the pnpm virtual store
 * (.pnpm) are always kept.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const BACKUP_DIR = path.join(ROOT, '.prepack-prune-backup');

function isScope(name) {
  return name.startsWith('@');
}

function readPkgDeps(dep) {
  const pkgPath = path.join(NODE_MODULES, dep, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

// The transitive `dependencies` closure of the external (non-@gsd) bundled deps.
// These stay bundled so the offline --ignore-scripts install path keeps working.
function computeKeepClosure() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const externalBundled = (rootPkg.bundledDependencies || []).filter((d) => !d.startsWith('@gsd/'));
  const keep = new Set();
  const stack = [...externalBundled];
  while (stack.length) {
    const dep = stack.pop();
    if (keep.has(dep)) continue;
    keep.add(dep);
    const pkg = readPkgDeps(dep);
    if (!pkg) continue;
    for (const child of Object.keys(pkg.dependencies || {})) {
      if (!keep.has(child)) stack.push(child);
    }
  }
  return keep;
}

// Internal workspace packages are vendored inside the tarball and must never be
// pruned (they are not resolvable from the public registry).
function isInternal(name) {
  return name.startsWith('@gsd/') || name.startsWith('@opengsd/');
}

function listInstalledPackages() {
  const out = [];
  for (const entry of fs.readdirSync(NODE_MODULES)) {
    if (entry.startsWith('.')) continue; // .pnpm, .bin, .modules.yaml — leave untouched
    if (isScope(entry)) {
      const scopePath = path.join(NODE_MODULES, entry);
      let children;
      try {
        children = fs.readdirSync(scopePath);
      } catch {
        continue;
      }
      for (const child of children) out.push(`${entry}/${child}`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

function prune() {
  if (!fs.existsSync(NODE_MODULES)) return;
  const keep = computeKeepClosure();
  const manifest = [];
  for (const dep of listInstalledPackages()) {
    if (isInternal(dep) || keep.has(dep)) continue;
    const src = path.join(NODE_MODULES, dep);
    let stat;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    const dst = path.join(BACKUP_DIR, dep);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    manifest.push(dep);
  }
  if (manifest.length > 0) {
    fs.writeFileSync(
      path.join(BACKUP_DIR, 'pruned-externals.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(`[prune-bundled-externals] Pruned ${manifest.length} external packages from the publish tarball (they install from the registry)`);
  }
}

function restore() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  for (const dep of listBackupPackages()) {
    const src = path.join(BACKUP_DIR, dep);
    const dst = path.join(NODE_MODULES, dep);
    if (fs.existsSync(dst)) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log('[prune-bundled-externals] Restored pruned external packages');
}

function listBackupPackages() {
  const out = [];
  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    if (entry === 'pruned-externals.json') continue;
    if (isScope(entry)) {
      for (const child of fs.readdirSync(path.join(BACKUP_DIR, entry))) out.push(`${entry}/${child}`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

const mode = process.argv[2] ?? 'prune';
if (mode === 'restore') {
  restore();
} else {
  prune();
}
