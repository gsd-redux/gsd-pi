import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { installHermesPlugin, parseHermesInstallArgs, renderGsdYaml } from '../hermes-integration-install.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('parseHermesInstallArgs resolves Hermes home and project paths', () => {
  const opts = parseHermesInstallArgs([
    '--hermes-home', './tmp-hermes',
    '--plugin-source', './integrations/hermes',
    '--project', './project',
    '--skip-pip',
    '--skip-enable',
  ])

  assert.ok(opts.hermesHome.endsWith('tmp-hermes'))
  assert.ok(opts.pluginSource.endsWith('integrations/hermes'))
  assert.ok(opts.project?.endsWith('project'))
  assert.equal(opts.skipPip, true)
  assert.equal(opts.skipEnable, true)
})

test('installHermesPlugin copies plugin and writes starter gsd.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-hermes-install-'))
  const source = join(root, 'source')
  const hermesHome = join(root, 'hermes-home')
  const project = join(root, 'project')
  mkdirSync(source, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(source, 'plugin.yaml'), 'name: open-gsd-hermes\n')
  writeFileSync(join(source, 'README.md'), '# plugin\n')

  const result = installHermesPlugin({
    hermesHome,
    pluginSource: source,
    project,
    dryRun: false,
    skipPip: true,
    skipEnable: true,
  })

  assert.equal(result.pluginTarget, join(hermesHome, 'plugins', 'open-gsd-hermes'))
  assert.equal(existsSync(join(result.pluginTarget, 'plugin.yaml')), true)
  const config = readFileSync(result.configPath, 'utf8')
  assert.match(config, /gsd:/)
  assert.ok(config.includes(project))
})

test('installHermesPlugin leaves existing config unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-hermes-install-'))
  const source = join(root, 'source')
  const hermesHome = join(root, 'hermes-home')
  mkdirSync(source, { recursive: true })
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(source, 'plugin.yaml'), 'name: open-gsd-hermes\n')
  writeFileSync(join(hermesHome, 'gsd.yaml'), 'gsd:\n  default_project: /existing\n')

  const result = installHermesPlugin({
    hermesHome,
    pluginSource: source,
    dryRun: false,
    skipPip: true,
    skipEnable: true,
  })

  assert.equal(readFileSync(result.configPath, 'utf8'), 'gsd:\n  default_project: /existing\n')
  assert.ok(result.actions.some((action) => action.includes('Left existing')))
})

test('renderGsdYaml writes a version gate covering the installed gsd-pi version', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  const nextMajor = `${Number(pkg.version.split('.')[0]) + 1}.0.0`

  const config = parseYaml(renderGsdYaml(undefined)) as {
    gsd: { gsd_version_min: string; gsd_version_max: string }
  }

  assert.equal(config.gsd.gsd_version_min, pkg.version)
  assert.equal(config.gsd.gsd_version_max, nextMajor)
})

test('renderGsdYaml mcp_server_path matches a bin entry shipped in the package', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    bin: Record<string, string>
  }
  const config = parseYaml(renderGsdYaml(undefined)) as {
    gsd: { mcp_server_path: string }
  }
  const mcpServerPath = config.gsd.mcp_server_path
  const binTarget = pkg.bin[mcpServerPath]

  assert.equal(mcpServerPath, 'gsd-mcp-server')
  assert.equal(binTarget, 'packages/mcp-server/bin/gsd-mcp-server.js')
  assert.equal(existsSync(join(repoRoot, binTarget)), true)
})
