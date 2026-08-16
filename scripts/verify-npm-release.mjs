#!/usr/bin/env node
// gsd-pi + scripts/verify-npm-release.mjs
//
// Pre-release gate: confirm EVERY package that must reach npm for a release is
// actually published at the target version, BEFORE the GitHub release is cut.
// Two releases previously shipped with publishable workspaces missing from npm;
// this turns that class of failure into a hard,
// loud stop instead of a silent half-release.
//
// Usage:
//   node scripts/verify-npm-release.mjs [version]
//   RELEASE_VERSION=1.2.3 node scripts/verify-npm-release.mjs
// Version resolution: explicit arg > RELEASE_VERSION env > root package.json.
//
// Exit 0 = every required package is on npm at the version. Exit 1 = something is
// missing (the report lists exactly which packages, so the gap is obvious).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getRequiredNpmPackageNames, REPO_ROOT } = require('./lib/npm-release-packages.cjs');

const args = process.argv.slice(2);
// --once skips the registry-propagation retry (fast local check); CI keeps the
// retry so it tolerates the lag right after publishing.
const noRetry = args.includes('--once');
const version =
  args.find((a) => !a.startsWith('--')) ||
  process.env.RELEASE_VERSION ||
  require(`${REPO_ROOT}/package.json`).version;

if (!version) {
  console.error('verify-npm-release: could not resolve a version to check.');
  process.exit(1);
}

/** Returns the published version string for pkg@version, or '' if not present. */
function publishedVersion(pkg) {
  try {
    return execFileSync('npm', ['view', `${pkg}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Registry propagation lag is real right after publish — retry with backoff
// before declaring a package missing, mirroring the publish steps.
async function resolveWithRetry(pkg) {
  let delay = 5_000;
  const maxAttempts = noRetry ? 1 : 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (publishedVersion(pkg) === version) return true;
    if (attempt === maxAttempts) return false;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
  return false;
}

const required = getRequiredNpmPackageNames();
console.log(`Verifying ${required.length} package(s) are published on npm at ${version}:`);

const missing = [];
for (const pkg of required) {
  const ok = await resolveWithRetry(pkg);
  console.log(`  ${ok ? '✓' : '✗'} ${pkg}@${version}`);
  if (!ok) missing.push(pkg);
}

if (missing.length > 0) {
  console.error('');
  console.error(`::error::Release blocked — ${missing.length} required package(s) are NOT on npm at ${version}:`);
  for (const pkg of missing) console.error(`::error::  - ${pkg}@${version}`);
  console.error('Do NOT cut the GitHub release until every package above is published.');
  process.exit(1);
}

console.log(`\nAll ${required.length} required packages are published at ${version}. Safe to cut the release.`);
