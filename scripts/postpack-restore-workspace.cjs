#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');

function restoreDir(currentDir, relativeDir = '') {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === 'materialized-bundled-deps.json') continue;
    const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const sourcePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      restoreDir(sourcePath, relPath);
      continue;
    }
    const targetPath = path.join(ROOT, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`[postpack] Restored ${relPath}`);
  }
}

// Restore externals pruned from node_modules for the publish tarball. This is
// independent of the workspace:* backup below and must run even when no
// workspace ranges were rewritten.
spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'prune-bundled-externals.cjs'), 'restore'], {
  stdio: 'inherit',
});

if (!fs.existsSync(BACKUP_DIR)) {
  process.exit(0);
}

spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'materialize-bundled-deps.cjs'), 'restore'], {
  stdio: 'inherit',
});

restoreDir(BACKUP_DIR);
fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
console.log('[postpack] Restored workspace:* internal dependency ranges');
