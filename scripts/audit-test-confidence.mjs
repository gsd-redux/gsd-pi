#!/usr/bin/env node
/**
 * Audit local verification tiers against CI jobs and surface test distribution gaps.
 *
 * Usage:
 *   node scripts/audit-test-confidence.mjs          # human-readable report
 *   node scripts/audit-test-confidence.mjs --json   # machine-readable
 *   node scripts/audit-test-confidence.mjs --strict # exit 1 if tier map drifts
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');
const strict = args.has('--strict');

const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js|cjs)$/;

/** Expected local npm script steps for each CI blocking PR job. */
const CI_PR_BLOCKING_MAP = [
  {
    ciJob: 'fast-gates',
    local: 'verify:fast',
    steps: ['bash scripts/ci-fast-gates.sh'],
    enforcement: 'block',
  },
  {
    ciJob: 'build',
    local: 'verify:merge',
    steps: [
      'build:core',
      'web ci + build:web-host',
      'typecheck:extensions',
      'validate-pack',
      'verify:workspace-coverage',
      'test:compile',
      'test:unit:compiled',
      'test:packages:compiled (native skipped unless portability-changed)',
      'playwright install chromium',
      'test:integration',
      'test:e2e (GSD_SMOKE_BINARY=dist/loader.js)',
    ],
    enforcement: 'block',
  },
];

const CI_AUXILIARY = [
  {
    ciJob: 'coverage-report',
    local: 'test:coverage + test:coverage:full',
    when: 'manual, weekly schedule, or PR labeled coverage',
    enforcement: 'separate-workflow',
  },
];

const CI_CONDITIONAL = [
  {
    ciJob: 'build / docker e2e step',
    local: 'test:e2e:docker',
    when: 'docker-changed=true',
    enforcement: 'block-when-triggered',
  },
  {
    ciJob: 'windows-portability',
    local: 'windows-portability.test.ts (+ package tests on Windows)',
    when: 'portability-changed=true',
    enforcement: 'block-when-triggered',
  },
  {
    ciJob: 'windows-smoke-e2e',
    local: 'test:e2e:windows-smoke',
    when: 'windows-e2e-changed=true',
    enforcement: 'warn',
    note: 'continue-on-error: true in ci.yml',
  },
];

const LOCAL_TIERS = [
  {
    name: 'verify:fast',
    when: 'Every push',
    matchesCi: ['fast-gates'],
    scriptKey: 'verify:fast',
  },
  {
    name: 'verify:pr',
    when: 'Fast iteration while editing',
    matchesCi: ['build (partial: build:core + unit tests)'],
    scriptKey: 'verify:pr',
    gapNote: 'Unit-only preflight; does not replace verify:merge before review.',
  },
  {
    name: 'verify:merge',
    when: 'Before requesting PR review (default merge confidence)',
    matchesCi: ['build'],
    scriptKey: 'verify:merge',
  },
  {
    name: 'test:coverage',
    when: 'Manual/scheduled coverage workflow or local spot-check',
    matchesCi: ['coverage-report'],
    scriptKey: 'test:coverage',
  },
];

function loadPackageScripts() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.scripts ?? {};
}

function collectTestFiles(dir, skip = new Set(['node_modules', 'dist', 'dist-test', '.cache'])) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(full, skip));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      results.push(relative(ROOT, full).replaceAll('\\', '/'));
    }
  }
  return results;
}

function countByPrefix(files, prefix) {
  return files.filter(f => f.startsWith(prefix)).length;
}

function countSourceFiles(dir, skip = new Set(['node_modules', 'dist', 'dist-test', '.cache'])) {
  let count = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countSourceFiles(full, skip);
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx|mjs|js)$/.test(entry.name) &&
      !TEST_FILE_RE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      count++;
    }
  }
  return count;
}

function verifyMergeScriptExists(scripts) {
  const issues = [];
  if (!scripts['verify:merge']) {
    issues.push('package.json missing scripts.verify:merge');
  }
  if (scripts['verify:full'] && !/run verify:merge$/.test(scripts['verify:full'])) {
    issues.push('verify:full should alias verify:merge for backward compatibility');
  }
  if (!existsSync(join(ROOT, 'scripts/verify-merge.sh'))) {
    issues.push('scripts/verify-merge.sh is missing');
  }
  return issues;
}

function buildReport() {
  const scripts = loadPackageScripts();
  const allTests = collectTestFiles(ROOT);
  const thinAreas = [
    { area: 'web/', tests: countByPrefix(allTests, 'web/'), sources: countSourceFiles(join(ROOT, 'web')) },
    { area: 'vscode-extension/', tests: countByPrefix(allTests, 'vscode-extension/'), sources: countSourceFiles(join(ROOT, 'vscode-extension')) },
  ].filter(row => row.sources > 0 && row.tests / row.sources < 0.05);

  const drift = verifyMergeScriptExists(scripts);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      testFiles: allTests.length,
      byArea: {
        gsdExtension: countByPrefix(allTests, 'src/resources/extensions/gsd/'),
        srcTests: countByPrefix(allTests, 'src/tests/'),
        packages: allTests.filter(f => f.startsWith('packages/')).length,
        e2e: countByPrefix(allTests, 'tests/e2e/'),
        scripts: countByPrefix(allTests, 'scripts/'),
      },
    },
    localTiers: LOCAL_TIERS.map(tier => ({
      ...tier,
      script: scripts[tier.scriptKey] ?? null,
    })),
    ciPrBlocking: CI_PR_BLOCKING_MAP,
    ciAuxiliary: CI_AUXILIARY,
    ciConditional: CI_CONDITIONAL,
    thinAreas,
    drift,
  };
}

function printHuman(report) {
  process.stdout.write('Test confidence stack audit\n');
  process.stdout.write('===========================\n\n');

  process.stdout.write(`Test files: ${report.totals.testFiles}\n`);
  process.stdout.write(
    `  GSD extension: ${report.totals.byArea.gsdExtension}, src/tests: ${report.totals.byArea.srcTests}, packages: ${report.totals.byArea.packages}, e2e: ${report.totals.byArea.e2e}\n\n`,
  );

  process.stdout.write('Local tiers\n');
  for (const tier of report.localTiers) {
    process.stdout.write(`  ${tier.name} — ${tier.when}\n`);
    process.stdout.write(`    CI: ${tier.matchesCi.join(', ')}\n`);
    if (tier.gapNote) process.stdout.write(`    Note: ${tier.gapNote}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('CI PR blocking jobs → local steps\n');
  for (const row of report.ciPrBlocking) {
    process.stdout.write(`  ${row.ciJob} (${row.enforcement}): ${row.steps.join(' → ')}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write('Auxiliary / conditional\n');
  for (const row of [...report.ciAuxiliary, ...report.ciConditional]) {
    const note = row.note ? ` — ${row.note}` : '';
    process.stdout.write(`  ${row.ciJob} [${row.enforcement}] when ${row.when}${note}\n`);
  }
  process.stdout.write('\n');

  if (report.thinAreas.length > 0) {
    process.stdout.write('Low test density (tests / source files < 5%)\n');
    for (const row of report.thinAreas) {
      const ratio = row.sources === 0 ? 'n/a' : `${((row.tests / row.sources) * 100).toFixed(1)}%`;
      process.stdout.write(`  ${row.area} ${row.tests} tests / ${row.sources} sources (${ratio})\n`);
    }
    process.stdout.write('\n');
  }

  if (report.drift.length > 0) {
    process.stdout.write('Tier map drift\n');
    for (const issue of report.drift) {
      process.stdout.write(`  ✗ ${issue}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write('Tier map drift: none detected ✓\n\n');
  }

  process.stdout.write('Full map: docs/dev/test-confidence-stack.md\n');
}

function main() {
  const report = buildReport();
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  if (strict && report.drift.length > 0) {
    process.exit(1);
  }
}

main();
