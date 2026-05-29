// validate-pack.js — Verify the npm tarball is installable before publishing.
//
// Usage: npm run validate-pack (or node scripts/validate-pack.js)
// Exit 0 = safe to publish, Exit 1 = broken package.

import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { getLinkablePackages, getCorePackages } = require('./lib/workspace-manifest.cjs');

let tarball = null;
let installDir = null;
let npmCacheDir = null;
const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function cleanNpmEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (!key.startsWith('npm_config_')) continue;
    const setting = key.slice('npm_config_'.length).replace(/_/g, '-');
    if (setting === 'verify-deps-before-run' || setting === 'auto-install-peers' || setting === '_jsr-registry') {
      delete env[key];
    }
  }
  return env;
}

function runNpm(args, options = {}) {
  return execFileSync(getNpmCommand(), args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: cleanNpmEnv({
      npm_config_cache: npmCacheDir ?? process.env.npm_config_cache,
    }),
    ...options,
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveBundledDepPkgJson(packageRoot, nodeModulesRoot, dep) {
  const segments = dep.startsWith('@') ? dep.split('/') : [dep];
  const candidates = [
    join(packageRoot, 'node_modules', ...segments, 'package.json'),
    join(nodeModulesRoot, ...segments, 'package.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return createRequire(join(packageRoot, 'package.json')).resolve(`${dep}/package.json`);
  } catch {
    return null;
  }
}

function resolveDependencyDir(packageRoot, nodeModulesRoot, dep) {
  const pkgJsonPath = resolveBundledDepPkgJson(packageRoot, nodeModulesRoot, dep);
  return pkgJsonPath ? dirname(pkgJsonPath) : null;
}

function seedGlobalDependencyFromLocal(globalRoot, globalNodeModules, localPackageRoot, localNodeModules, dep) {
  if (resolveBundledDepPkgJson(globalRoot, globalNodeModules, dep)) return true;
  const localDir = resolveDependencyDir(localPackageRoot, localNodeModules, dep);
  if (!localDir || !existsSync(join(localDir, 'package.json'))) return false;
  const segments = dep.startsWith('@') ? dep.split('/') : [dep];
  const target = join(globalRoot, 'node_modules', ...segments);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(localDir, target, { recursive: true, dereference: true });
  return true;
}

try {
  npmCacheDir = mkdtempSync(join(tmpdir(), 'validate-pack-npm-cache-'));
  mkdirSync(npmCacheDir, { recursive: true });

  // --- Guard: bundled @gsd/* workspace package graph must be fully covered ---
  // Internal @gsd/* packages are shipped inside the main tarball rather than
  // resolved from the public registry. Every @gsd/* dependency that appears in
  // a shipped workspace package must therefore also be listed in the root
  // package's bundledDependencies set.
  console.log('==> Checking bundled workspace package coverage for @gsd/* cross-deps...');
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const bundled = new Set(rootPkg.bundledDependencies || []);
  let crossFailed = false;

  for (const ws of getCorePackages()) {
    const pkg = JSON.parse(readFileSync(ws.packageJsonPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@gsd/'));
    const uncovered = deps.filter((dep) => !bundled.has(dep));
    if (uncovered.length) {
      console.log(`    UNCOVERED in ${ws.dir}: ${uncovered.join(', ')}`);
      crossFailed = true;
    }
  }

  const rootInternalDeps = Object.keys(rootPkg.dependencies || {}).filter((dep) => dep.startsWith('@gsd/'));
  const missingRootBundles = rootInternalDeps.filter((dep) => !bundled.has(dep));
  if (missingRootBundles.length) {
    console.log(`    ROOT bundledDependencies missing: ${missingRootBundles.join(', ')}`);
    crossFailed = true;
  }

  if (crossFailed) {
    console.log('ERROR: Internal @gsd/* dependencies are not fully bundled by the root package.');
    console.log('    Add every shipped @gsd/* dependency to root dependencies + bundledDependencies.');
    process.exit(1);
  }
  console.log('    Bundled dependency coverage is complete.');

  const rootExternalDeps = new Set(Object.keys(rootPkg.dependencies || {}));
  const missingExternal = new Map();
  const visitedBundled = new Set();
  const bundledTransitiveRoots = new Set(['proper-lockfile', 'minimatch']);

  function isInternalWorkspaceDep(dep) {
    return dep.startsWith('@gsd/') || dep.startsWith('@opengsd/') || dep.startsWith('@earendil-works/');
  }

  function readInstalledPackageJson(dep) {
    const pkgPath = join(ROOT, 'node_modules', dep, 'package.json');
    if (!existsSync(pkgPath)) return null;
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
  }

  // Small bundled packages ship without nested node_modules; their transitive
  // externals must be declared on the root package for tarball installs.
  function collectBundledSubtreeExternalDeps(dep, pkgJson) {
    for (const [externalDep, version] of Object.entries(pkgJson.dependencies || {})) {
      if (isInternalWorkspaceDep(externalDep)) continue;
      if (!rootExternalDeps.has(externalDep)) {
        missingExternal.set(externalDep, version);
      }
      if (visitedBundled.has(externalDep)) continue;
      visitedBundled.add(externalDep);
      const installed = readInstalledPackageJson(externalDep);
      if (installed) collectBundledSubtreeExternalDeps(externalDep, installed);
    }
  }

  for (const dep of bundled) {
    if (dep.startsWith('@gsd/')) {
      const ws = getCorePackages().find((entry) => entry.packageName === dep);
      if (!ws) continue;
      const pkg = JSON.parse(readFileSync(ws.packageJsonPath, 'utf8'));
      for (const [externalDep, version] of Object.entries(pkg.dependencies || {})) {
        if (isInternalWorkspaceDep(externalDep)) continue;
        if (!rootExternalDeps.has(externalDep)) {
          missingExternal.set(externalDep, version);
        }
      }
      continue;
    }

    if (!bundledTransitiveRoots.has(dep)) continue;

    const installed = readInstalledPackageJson(dep);
    if (installed) {
      collectBundledSubtreeExternalDeps(dep, installed);
    } else if (!rootExternalDeps.has(dep)) {
      missingExternal.set(dep, rootPkg.dependencies?.[dep] ?? 'unknown');
    }
  }

  if (missingExternal.size > 0) {
    console.log('ERROR: Bundled packages depend on externals missing from root dependencies:');
    for (const [dep, version] of [...missingExternal.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`    ${dep}@${version}`);
    }
    console.log('    Add these to root package.json dependencies so tarball installs resolve them.');
    process.exit(1);
  }
  console.log('    Bundled workspace external dependency coverage is complete.');

  // --- Pack tarball ---
  // npm pack --ignore-scripts skips prepack; resolve workspace:* for publishable tarballs.
  execFileSync(process.execPath, [join(__dirname, 'prepack-resolve-workspace.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [join(__dirname, 'materialize-bundled-deps.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  console.log('==> Packing tarball...');
  const packOutput = runNpm(['pack', '--json', '--ignore-scripts']);
  const packEntries = JSON.parse(packOutput);
  const packEntry = Array.isArray(packEntries) ? packEntries[0] : null;
  const tarballName = packEntry?.filename;
  tarball = join(ROOT, tarballName);

  if (!existsSync(tarball)) {
    console.log('ERROR: npm pack produced no tarball');
    process.exit(1);
  }

  const stats = statSync(tarball);
  console.log(`==> Tarball: ${tarballName} (${formatBytes(stats.size)} compressed)`);

  // --- Guard: fail loudly on tarball bloat ---
  // The npm->pnpm migration repeatedly shipped a 537MB / 85k-file tarball because
  // npm's bundle walker followed the pnpm virtual store (node_modules/.pnpm) and the
  // nested packages/*/node_modules trees. These assertions turn that silent bloat
  // into a hard failure before publish. Thresholds sit well above the legitimate
  // bundled payload (~15k files / ~220MB unpacked) with headroom for growth.
  const MAX_ENTRY_COUNT = 30000;
  const MAX_UNPACKED_BYTES = 350 * 1024 * 1024;
  const entryCount = packEntry?.entryCount ?? 0;
  const unpackedSize = packEntry?.unpackedSize ?? 0;
  const allPackedPaths = Array.isArray(packEntry?.files)
    ? packEntry.files.map((entry) => entry?.path).filter(Boolean)
    : [];
  const pnpmStorePaths = allPackedPaths.filter((p) => p.startsWith('node_modules/.pnpm/'));
  const nestedNmPaths = allPackedPaths.filter((p) => /^packages\/[^/]+\/node_modules\//.test(p));
  const bloatErrors = [];
  if (entryCount > MAX_ENTRY_COUNT) {
    bloatErrors.push(`entry count ${entryCount} exceeds ${MAX_ENTRY_COUNT} (pnpm store or nested node_modules likely leaked)`);
  }
  if (unpackedSize > MAX_UNPACKED_BYTES) {
    bloatErrors.push(`unpacked size ${formatBytes(unpackedSize)} exceeds ${formatBytes(MAX_UNPACKED_BYTES)}`);
  }
  if (pnpmStorePaths.length > 500) {
    bloatErrors.push(`${pnpmStorePaths.length} node_modules/.pnpm/* entries packed (e.g. ${pnpmStorePaths[0]}) — bundled deps are dragging in the pnpm virtual store`);
  }
  if (nestedNmPaths.length > 0) {
    bloatErrors.push(`${nestedNmPaths.length} packages/*/node_modules/* entries packed (e.g. ${nestedNmPaths[0]}) — files[] is shipping workspace node_modules`);
  }
  if (bloatErrors.length) {
    console.log('ERROR: Tarball bloat guard tripped:');
    for (const e of bloatErrors) console.log(`    ${e}`);
    console.log('    See scripts/materialize-bundled-deps.cjs (@gsd flatten) and package.json "files".');
    process.exit(1);
  }
  console.log(`    Size guard OK: ${entryCount} entries, ${formatBytes(unpackedSize)} unpacked, ${pnpmStorePaths.length} .pnpm entries.`);

  // npm install can consume/delete a cwd-local tarball; keep a temp copy for later smoke tests.
  const packedTarballPath = tarball;
  tarball = join(mkdtempSync(join(tmpdir(), 'validate-pack-tarball-')), tarballName);
  copyFileSync(packedTarballPath, tarball);
  rmSync(packedTarballPath, { force: true });

  execFileSync(process.execPath, [join(__dirname, 'postpack-restore-workspace.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // --- Check critical files using npm pack metadata ---
  console.log('==> Checking critical files...');
  const packedFiles = new Set(
    Array.isArray(packEntry?.files)
      ? packEntry.files.map((entry) => entry?.path).filter(Boolean)
      : [],
  );

  const requiredFiles = [
    'dist/loader.js',
    'packages/pi-coding-agent/dist/index.js',
    'packages/rpc-client/dist/index.js',
    'packages/mcp-server/dist/cli.js',
    'scripts/link-workspace-packages.cjs',
    'dist/web/standalone/server.js',
  ];

  let missing = false;
  for (const required of requiredFiles) {
    if (!packedFiles.has(required)) {
      console.log(`    MISSING: ${required}`);
      missing = true;
    }
  }

  for (const dep of rootPkg.bundledDependencies || []) {
    if (dep.startsWith('@gsd/')) continue;
    const segments = dep.startsWith('@') ? dep.split('/') : [dep];
    const bundledPath = join('node_modules', ...segments, 'package.json');
    if (!packedFiles.has(bundledPath)) {
      console.log(`    MISSING bundled dependency: ${bundledPath}`);
      missing = true;
    }
  }

  if (missing) {
    console.log('ERROR: Critical files missing from tarball.');
    process.exit(1);
  }
  console.log('    Critical files present.');

  // --- Install test ---
  console.log('==> Testing install in isolated directory...');
  installDir = mkdtempSync(join(tmpdir(), 'validate-pack-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'test-install', version: '1.0.0', private: true }, null, 2));

  try {
    const installOutput = execFileSync(getNpmCommand(), ['install', tarball], {
      cwd: installDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: cleanNpmEnv({
        npm_config_cache: npmCacheDir,
      }),
    });
    console.log(installOutput);
    console.log('==> Install succeeded.');
  } catch (err) {
    console.log('');
    console.log('ERROR: npm install of tarball failed.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Verify every linkable workspace package resolved correctly post-install ---
  // This catches the Windows-style failure where symlinkSync fails silently and
  // node_modules/@gsd/ is never populated, causing ERR_MODULE_NOT_FOUND at runtime.
  // Checks every package with `gsd.linkable: true` — not just a hand-picked subset —
  // so any future addition is automatically covered.
  console.log('==> Verifying workspace package resolution (every linkable package)...');
  const installedRoot = join(installDir, 'node_modules', '@opengsd', 'gsd-pi');
  let resolutionFailed = false;
  for (const pkg of getLinkablePackages()) {
    const pkgPath = join(installedRoot, 'node_modules', pkg.scope, pkg.name);
    const fallbackPath = join(installedRoot, 'packages', pkg.dir);
    if (!existsSync(pkgPath)) {
      if (existsSync(fallbackPath)) {
        console.log(`    MISSING symlink/copy: node_modules/${pkg.scope}/${pkg.name} (packages/${pkg.dir} exists — postinstall may not have run)`);
      } else {
        console.log(`    MISSING: node_modules/${pkg.scope}/${pkg.name} (packages/${pkg.dir} also absent — package is broken)`);
      }
      resolutionFailed = true;
    }
  }
  if (resolutionFailed) {
    console.log('ERROR: Linkable workspace packages are not resolvable after install.');
    console.log('    This will cause ERR_MODULE_NOT_FOUND on first run (especially on Windows).');
    process.exit(1);
  }
  console.log(`    All ${getLinkablePackages().length} linkable packages are resolvable.`);

  // --- Run the binary to confirm end-to-end resolution ---
  console.log('==> Running installed binary (gsd -v)...');
  const loaderPath = join(installedRoot, 'dist', 'loader.js');
  const bundledWorkflowMcpCliPath = join(installedRoot, 'packages', 'mcp-server', 'dist', 'cli.js');
  if (!existsSync(bundledWorkflowMcpCliPath)) {
    console.log('ERROR: Bundled workflow MCP CLI missing after install.');
    console.log(`    Expected: ${bundledWorkflowMcpCliPath}`);
    process.exit(1);
  }
  try {
    const versionOutput = execFileSync(process.execPath, [loaderPath, '-v'], {
      cwd: installDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: DEFAULT_MAX_BUFFER,
    }).trim();
    console.log(`    gsd -v => ${versionOutput}`);
    if (!versionOutput.match(/^\d+\.\d+\.\d+/)) {
      console.log('ERROR: gsd -v returned unexpected output (expected a version string).');
      process.exit(1);
    }
  } catch (err) {
    console.log('ERROR: Running gsd -v failed after install.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Verify undici resolves for bundled pi-coding-agent (global install regression) ---
  console.log('==> Verifying undici resolves for pi-coding-agent/http-dispatcher...');
  const httpDispatcherPath = join(
    installedRoot,
    'node_modules',
    '@gsd',
    'pi-coding-agent',
    'dist',
    'core',
    'http-dispatcher.js',
  );
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify('file://' + httpDispatcherPath.replace(/\\/g, '/'))});`,
      ],
      {
        cwd: installDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      },
    );
    console.log('    pi-coding-agent/core/http-dispatcher resolves undici.');
  } catch (err) {
    console.log('ERROR: pi-coding-agent failed to resolve undici after install.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Verify pi-coding-agent re-exports resolve bundled @gsd/agent-core ---
  // Relative ../../../gsd-agent-core paths break after npm install (folder is @gsd/agent-core).
  console.log('==> Verifying pi-coding-agent @gsd/agent-core re-exports...');
  const lifecycleHooksPath = join(
    installedRoot,
    'node_modules',
    '@gsd',
    'pi-coding-agent',
    'dist',
    'core',
    'lifecycle-hooks.js',
  );
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify('file://' + lifecycleHooksPath.replace(/\\/g, '/'))});`,
      ],
      {
        cwd: installDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      },
    );
    console.log('    pi-coding-agent/core/lifecycle-hooks resolves @gsd/agent-core.');
  } catch (err) {
    console.log('ERROR: pi-coding-agent re-export failed to resolve @gsd/agent-core after install.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Verify installer CLI surface ---
  console.log('==> Verifying installer CLI...');
  const installScriptPath = join(installedRoot, 'scripts', 'install.js');
  const installDepsPath = join(installedRoot, 'scripts', 'install', 'deps.js');
  if (!existsSync(installDepsPath)) {
    console.log('ERROR: Modular installer deps missing after install.');
    console.log(`    Expected: ${installDepsPath}`);
    process.exit(1);
  }
  try {
    const helpOutput = execFileSync(process.execPath, [installScriptPath, '--help'], {
      cwd: installDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
    if (!helpOutput.includes('--yes')) {
      console.log('ERROR: install.js --help missing --yes flag documentation.');
      process.exit(1);
    }
    console.log('    install.js --help OK');
  } catch (err) {
    console.log('ERROR: install.js --help failed after install.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  }

  // --- Global install smoke (npx path: --ignore-scripts, then repair) ---
  console.log('==> Testing global install (--ignore-scripts, bundled deps + repair)...');
  const globalPrefix = mkdtempSync(join(tmpdir(), 'validate-pack-global-'));
  try {
    execFileSync(getNpmCommand(), ['install', '-g', tarball, '--ignore-scripts', '--prefix', globalPrefix], {
      cwd: installDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: cleanNpmEnv({
        npm_config_cache: npmCacheDir,
      }),
    });
    const globalNodeModules = execFileSync(getNpmCommand(), ['root', '-g', '--prefix', globalPrefix], {
      cwd: installDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: cleanNpmEnv({
        npm_config_cache: npmCacheDir,
      }),
    }).trim();
    const globalRoot = join(globalNodeModules, '@opengsd', 'gsd-pi');

    const bundledExternalDeps = [
      '@modelcontextprotocol/sdk',
      'minimatch',
      'picomatch',
      'proper-lockfile',
      'undici',
      'yaml',
    ];
    for (const dep of bundledExternalDeps) {
      const pkgJsonPath = resolveBundledDepPkgJson(globalRoot, globalNodeModules, dep);
      if (!pkgJsonPath) {
        console.log(`ERROR: Global --ignore-scripts install left bundled dep unresolved: ${dep}`);
        console.log(`    Checked nested and hoisted node_modules under ${globalRoot}`);
        process.exit(1);
      }
    }

    const linkScript = join(globalRoot, 'scripts', 'link-workspace-packages.cjs');
    execFileSync(process.execPath, [linkScript], {
      cwd: globalRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
    // Seed runtime deps from the local tarball install instead of npm install in
    // the global package tree, which OOMs resolving the full dependency graph.
    const localNodeModules = join(installDir, 'node_modules');
    for (const dep of Object.keys(rootPkg.dependencies || {})) {
      if (dep.startsWith('@gsd/') || dep.startsWith('@opengsd/') || dep.startsWith('@earendil-works/')) {
        continue;
      }
      seedGlobalDependencyFromLocal(globalRoot, globalNodeModules, installedRoot, localNodeModules, dep);
    }

    if (!resolveBundledDepPkgJson(globalRoot, globalNodeModules, 'openai')) {
      console.log('ERROR: Global install left node_modules/openai unresolved after repair.');
      console.log(`    Checked nested and hoisted node_modules under ${globalRoot}`);
      process.exit(1);
    }

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify('file://' + join(globalRoot, 'node_modules', '@gsd', 'pi-coding-agent', 'dist', 'core', 'http-dispatcher.js').replace(/\\/g, '/'))});`,
      ],
      {
        cwd: globalPrefix,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      },
    );
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import('yaml'); await import('minimatch');`,
      ],
      {
        cwd: globalRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      },
    );
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify('file://' + join(globalRoot, 'node_modules', '@gsd', 'pi-ai', 'dist', 'providers', 'openai-responses.js').replace(/\\/g, '/'))});`,
      ],
      {
        cwd: globalPrefix,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      },
    );
    console.log('    Global --ignore-scripts install keeps bundled deps and repair resolves openai/pi-ai.');
  } catch (err) {
    console.log('ERROR: Global install smoke test failed.');
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.log(err.stderr);
    process.exit(1);
  } finally {
    rmSync(globalPrefix, { recursive: true, force: true });
  }

  console.log('');
  console.log('Package is installable. Safe to publish.');
  process.exit(0);
} finally {
  try {
    execFileSync(process.execPath, [join(__dirname, 'postpack-restore-workspace.cjs')], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  } catch {
    // postpack restore is best-effort when pack fails before npm postpack runs
  }
  if (installDir && existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
  }
  if (tarball && existsSync(tarball)) {
    rmSync(tarball, { force: true });
  }
  if (npmCacheDir && existsSync(npmCacheDir)) {
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}
