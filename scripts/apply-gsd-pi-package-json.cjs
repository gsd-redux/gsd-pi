#!/usr/bin/env node
/**
 * apply-gsd-pi-package-json.cjs — merge GSD workspace metadata with upstream v0.75.5 deps.
 */
'use strict'

const { readFileSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')

const GSD_BASE = {
  'pi-agent-core': {
    name: '@gsd/pi-agent-core',
    description: 'General-purpose agent core (vendored from earendil-works/pi)',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-ai': {
    name: '@gsd/pi-ai',
    description: 'Unified LLM API (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './oauth': { types: './dist/oauth.d.ts', import: './dist/oauth.js' },
      './bedrock-provider': { types: './bedrock-provider.d.ts', import: './bedrock-provider.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-tui': {
    name: '@gsd/pi-tui',
    description: 'Terminal UI library (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-coding-agent': {
    name: '@gsd/pi-coding-agent',
    description: 'Coding agent CLI (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './*': { types: './dist/*.d.ts', import: './dist/*' },
      './hooks': { types: './dist/core/hooks/index.d.ts', import: './dist/core/hooks/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false && pnpm run copy-assets',
    extraScripts: { 'copy-assets': 'node scripts/copy-assets.cjs' },
    piConfig: { name: 'gsd', configDir: '.gsd' },
  },
}

const UPSTREAM_MAP = {
  'pi-agent-core': 'packages/agent',
  'pi-ai': 'packages/ai',
  'pi-tui': 'packages/tui',
  'pi-coding-agent': 'packages/coding-agent',
}

for (const dir of Object.keys(GSD_BASE)) {
  const pkgPath = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  const upstreamPath = join(ROOT, '.cache/pi-upstream', UPSTREAM_MAP[dir], 'package.json')
  const upstream = existsSync(upstreamPath)
    ? JSON.parse(readFileSync(upstreamPath, 'utf8'))
    : JSON.parse(readFileSync(pkgPath, 'utf8'))
  const base = GSD_BASE[dir]
  let headPkg = {}
  try {
    const { execSync } = require('child_process')
    headPkg = JSON.parse(
      execSync(`git show HEAD:packages/${dir}/package.json`, { cwd: ROOT, encoding: 'utf8' }),
    )
  } catch {
    /* no HEAD baseline */
  }
  const headDeps = headPkg.dependencies || {}

  const merged = {
    name: base.name,
    version: '1.0.2',
    description: base.description,
    type: 'module',
    gsd: { linkable: true, scope: '@gsd', name: dir },
    ...(base.piConfig ? { piConfig: base.piConfig } : {}),
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: base.exports,
    scripts: {
      build: base.build,
      ...(base.extraScripts || {}),
    },
    dependencies: {
      ...upstream.dependencies,
      // GSD-only additions (do not override upstream vendor versions)
      ...(headDeps['@gsd/native'] ? { '@gsd/native': headDeps['@gsd/native'] } : {}),
    },
    devDependencies: {
      ...(upstream.devDependencies || {}),
    },
    optionalDependencies: upstream.optionalDependencies,
  }

  if (dir === 'pi-coding-agent') {
    delete merged.dependencies['@opengsd/contracts']
  }

  for (const key of Object.keys(merged.dependencies || {})) {
    if (key.startsWith('@earendil-works/')) {
      const local = key.replace('@earendil-works/', '@gsd/')
      merged.dependencies[local] = '^1.0.2'
      delete merged.dependencies[key]
    }
    if (key.startsWith('@gsd/pi-') && /^\^?0\./.test(String(merged.dependencies[key]))) {
      merged.dependencies[key] = '^1.0.2'
    }
  }

  // GSD loader/extensions use @sinclair/typebox; upstream v0.75.5 uses unscoped `typebox`.
  merged.dependencies['@sinclair/typebox'] = '^0.34.41'

  writeFileSync(pkgPath, JSON.stringify(merged, null, 2) + '\n')
  process.stderr.write(`apply-gsd-pi-package-json: ${dir}\n`)
}
