#!/usr/bin/env node
// gsd-pi + scripts/validate-gsd-cloud-tarball.mjs
//
// Pre-publish tarball gate for @opengsd/gsd-cloud (CAGT-04 smoke). Runs
// `npm pack` exactly as a publish would, then asserts the tarball:
//   1. contains ONLY the intended files (package.json, README.md, bin/, dist/)
//      — no src/, no tests, no tsconfig, no .env, no secrets-shaped filenames;
//   2. ships a manifest with no `workspace:*` ranges and ONLY the runtime deps
//      the self-contained package declares (ws + yaml — no @opengsd/* pins);
//   3. carries no SaaS internals in file contents (only the intended
//      cloud.opengsd.net default; no relay URLs, cloud infra, or key material);
//   4. has a working bin — `node bin/gsd-cloud.js --help` from the EXTRACTED
//      tarball exits 0 and lists every public command.
//
// The package must be built first (`pnpm --filter @opengsd/gsd-cloud run build`)
// because the tarball ships dist/ and npm publish runs with --ignore-scripts.
//
// Usage:
//   node scripts/validate-gsd-cloud-tarball.mjs
//   pnpm --filter @opengsd/gsd-cloud run validate:tarball
//
// Exit 0 = the tarball is publishable. Exit 1 = a gate failed (each failure is
// printed; the temp dirs are always cleaned up).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PKG_DIR = join(REPO_ROOT, 'packages', 'gsd-cloud');
const EXPECTED_NAME = '@opengsd/gsd-cloud';
// The self-contained runtime contract: gsd-cloud deliberately depends ONLY on
// ws + yaml (no @opengsd/daemon — see docs/dev/gsd-cloud-publish-runbook.md).
const EXPECTED_RUNTIME_DEPS = ['ws', 'yaml'];
const INTENDED_GATEWAY = 'https://cloud.opengsd.net';

const failures = [];
const passes = [];
function check(label, ok, detail = '') {
  if (ok) {
    passes.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Files the tarball is allowed to contain (paths are npm's "package/..." form).
function isAllowedPath(path) {
  if (path === 'package/package.json') return true;
  if (path === 'package/README.md') return true;
  if (/^package\/LICEN[SC]E(\..*)?$/i.test(path)) return true; // npm auto-includes it when present
  if (path === 'package/bin/gsd-cloud.js') return true;
  if (path.startsWith('package/dist/')) return true;
  return false;
}

// Paths that must never ship, wherever they appear.
const FORBIDDEN_PATH_PATTERNS = [
  [/\.test\.[^/]*$/, 'compiled test file'],
  [/__tests__/, 'test directory'],
  [/\/src\//, 'TypeScript source (ship dist/ only)'],
  [/tsconfig[^/]*\.json$/, 'tsconfig'],
  [/(^|\/)\.env(\.|$)/i, 'env file'],
  [/(^|\/)\.npmrc$/, 'npmrc (may carry auth tokens)'],
  [/(^|\/)\.git(\/|$)/, 'git metadata'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'key material'],
  [/id_(rsa|ed25519|ecdsa)(\.pub)?$/i, 'ssh key'],
  [/(^|\/)(secrets?|credentials?)(\.|\/|$)/i, 'secrets-shaped filename'],
  [/(^|\/)\.htpasswd$/i, 'htpasswd file'],
];

// Content that must never appear inside any packed file (SaaS internals + key
// material). The intended public gateway default is asserted separately.
const FORBIDDEN_CONTENT_PATTERNS = [
  [/cloud-gateway\.opengsd\.net/i, 'relay hostname (learned from the server, never hardcoded)'],
  [/amazonaws\.com/i, 'cloud infra reference'],
  [/vercel\.(app|com)/i, 'hosting internals'],
  [/neon\.tech/i, 'database internals'],
  [/\.internal(\/|:|"|')/i, 'internal hostname'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/npm_[A-Za-z0-9]{30,}/, 'npm token'],
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// 1. The tarball ships dist/, so the package must be built up-front (npm
//    publish runs --ignore-scripts and will NOT build it for us).
const distDir = join(PKG_DIR, 'dist');
let distBuilt = false;
try {
  distBuilt = statSync(distDir).isDirectory() && readdirSync(distDir).length > 0;
} catch {
  distBuilt = false;
}
if (!distBuilt) {
  console.error('validate-gsd-cloud-tarball: packages/gsd-cloud/dist is missing or empty.');
  console.error('Build first: pnpm --filter @opengsd/gsd-cloud run build');
  process.exit(1);
}

const packDir = mkdtempSync(join(tmpdir(), 'gsd-cloud-pack-'));
// Extract INSIDE the package dir so Node resolves the tarball's runtime deps
// (ws, yaml) from the workspace node_modules during the bin smoke below.
const extractDir = mkdtempSync(join(PKG_DIR, '.pack-smoke-'));

try {
  // 2. Pack exactly as publish does (files whitelist + bin handling).
  const packJson = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const packResult = JSON.parse(packJson)[0];
  const tarballPath = join(packDir, packResult.filename);
  // npm reports paths relative to the package root; the tar layout prefixes
  // everything with "package/". Normalize to the tar form for all checks.
  const entries = packResult.files.map((f) => `package/${f.path}`);
  console.log(`Packed ${packResult.filename} (${entries.length} files).`);

  // 3. File-list gates.
  const outsideWhitelist = entries.filter((p) => !isAllowedPath(p));
  check(
    'tarball contains only package.json, README.md, bin/gsd-cloud.js, and dist/',
    outsideWhitelist.length === 0,
    `unexpected files: ${outsideWhitelist.join(', ')}`,
  );
  for (const [pattern, why] of FORBIDDEN_PATH_PATTERNS) {
    const hits = entries.filter((p) => pattern.test(p));
    check(`no ${why} in tarball`, hits.length === 0, hits.join(', '));
  }
  check(
    'no compiled tests shipped',
    !entries.some((p) => p.includes('.test.')),
    entries.filter((p) => p.includes('.test.')).join(', '),
  );
  for (const required of ['package/package.json', 'package/README.md', 'package/bin/gsd-cloud.js', 'package/dist/cli.js', 'package/dist/index.js']) {
    check(`tarball includes ${required}`, entries.includes(required));
  }

  // 4. Manifest gates (from the tarball, not the working tree).
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir], { stdio: ['ignore', 'ignore', 'inherit'] });
  const extractedRoot = join(extractDir, 'package');
  const packedPkg = JSON.parse(readFileSync(join(extractedRoot, 'package.json'), 'utf8'));
  const workingPkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

  check('manifest name is @opengsd/gsd-cloud', packedPkg.name === EXPECTED_NAME, packedPkg.name);
  check(
    'manifest version matches the working tree',
    packedPkg.version === workingPkg.version,
    `tarball=${packedPkg.version} tree=${workingPkg.version} (run the build again after a version bump)`,
  );
  check('bin entry gsd-cloud → ./bin/gsd-cloud.js', packedPkg.bin?.['gsd-cloud'] === './bin/gsd-cloud.js');
  check('files whitelist present', Array.isArray(packedPkg.files) && packedPkg.files.length > 0);
  check('license is MIT', packedPkg.license === 'MIT', packedPkg.license);
  check('engines requires Node >= 22', typeof packedPkg.engines?.node === 'string' && packedPkg.engines.node.includes('22'));

  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const workspaceRanges = [];
  for (const field of depFields) {
    for (const [dep, range] of Object.entries(packedPkg[field] || {})) {
      if (String(range).startsWith('workspace:')) workspaceRanges.push(`${field}.${dep}=${range}`);
    }
  }
  check('no workspace:* ranges in the packed manifest', workspaceRanges.length === 0, workspaceRanges.join(', '));

  const runtimeDeps = Object.keys(packedPkg.dependencies || {}).sort();
  check(
    'runtime deps are exactly ws + yaml (self-contained; no @opengsd/* pins)',
    JSON.stringify(runtimeDeps) === JSON.stringify([...EXPECTED_RUNTIME_DEPS].sort()),
    `got: ${runtimeDeps.join(', ')}`,
  );

  // 5. Content gates — scan every packed file for SaaS internals / key material.
  const packedFiles = walk(extractedRoot);
  for (const [pattern, why] of FORBIDDEN_CONTENT_PATTERNS) {
    const hits = [];
    for (const file of packedFiles) {
      const text = readFileSync(file, 'utf8');
      if (pattern.test(text)) hits.push(relative(extractedRoot, file));
    }
    check(`no ${why} in packed contents`, hits.length === 0, hits.join(', '));
  }
  const distText = packedFiles
    .filter((f) => f.includes(`${join('package', 'dist')}`) || f.endsWith('gsd-cloud.js'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  check('intended default gateway present (cloud.opengsd.net)', distText.includes(INTENDED_GATEWAY));

  // 6. Bin smoke from the EXTRACTED tarball — proves what ships actually runs.
  let helpOut = '';
  let helpOk = false;
  try {
    helpOut = execFileSync('node', [join(extractedRoot, 'bin', 'gsd-cloud.js'), '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    helpOk = true;
  } catch (err) {
    helpOut = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`;
  }
  check('bin/gsd-cloud.js --help exits 0 from the extracted tarball', helpOk, helpOk ? '' : helpOut.slice(0, 400));
  for (const command of ['login', 'pair', 'status', 'connect', 'stop', 'disconnect', 'service']) {
    check(`--help lists \`${command}\``, helpOut.includes(command));
  }
  check('--help documents the cloud.opengsd.net default', helpOut.includes('cloud.opengsd.net'));
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error(`validate-gsd-cloud-tarball: FAILED — ${failures.length} gate(s) did not pass:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('Do NOT publish until every gate passes.');
  process.exit(1);
}
console.log(`validate-gsd-cloud-tarball: OK — ${passes.length} gates passed; tarball is publishable.`);
