// GSD-2 + src/tests/pi-compat.test.ts — Tests for Pi runtime compatibility setup
import assert from 'node:assert/strict'
import { delimiter, resolve } from 'node:path'
import { test } from 'node:test'
import { buildPiCompatibilityEnv } from '../pi-compat.ts'

test('buildPiCompatibilityEnv points Pi config at the GSD package shim', () => {
	const root = resolve('/tmp/gsd-root')
	const env = buildPiCompatibilityEnv({
		gsdRoot: root,
		agentDir: resolve('/tmp/agent'),
		gsdVersion: '2.80.0',
		invokedBinPath: resolve('/tmp/gsd-root/dist/loader.js'),
	})

	assert.equal(env.PI_PACKAGE_DIR, resolve(root, 'pkg'))
	assert.equal(env.PI_SKIP_VERSION_CHECK, '1')
	assert.equal(env.GSD_CODING_AGENT_DIR, resolve('/tmp/agent'))
	assert.equal(env.GSD_PKG_ROOT, root)
	assert.equal(env.GSD_VERSION, '2.80.0')
	assert.equal(env.NODE_PATH, resolve(root, 'node_modules'))
})

test('buildPiCompatibilityEnv preserves explicit CLI paths', () => {
	const env = buildPiCompatibilityEnv({
		gsdRoot: resolve('/repo'),
		agentDir: resolve('/agent'),
		gsdVersion: '2.80.0',
		invokedBinPath: resolve('/repo/dist/loader.js'),
		explicitCliPath: resolve('/custom/gsd'),
	})

	assert.equal(env.GSD_BIN_PATH, resolve('/custom/gsd'))
	assert.equal(env.GSD_CLI_PATH, resolve('/custom/gsd'))
})

test('buildPiCompatibilityEnv uses the dev CLI for source-loader child processes', () => {
	const env = buildPiCompatibilityEnv({
		gsdRoot: resolve('/repo'),
		agentDir: resolve('/agent'),
		gsdVersion: '2.80.0',
		invokedBinPath: resolve('/repo/src/loader.ts'),
		sourceLoaderPath: resolve('/repo/src/loader.ts'),
		devCliPath: resolve('/repo/scripts/dev-cli.js'),
		pathExists: (path) => path === resolve('/repo/scripts/dev-cli.js'),
	})

	assert.equal(env.GSD_BIN_PATH, resolve('/repo/scripts/dev-cli.js'))
	assert.equal(env.GSD_CLI_PATH, resolve('/repo/scripts/dev-cli.js'))
})

test('buildPiCompatibilityEnv prepends GSD node_modules to existing NODE_PATH', () => {
	const env = buildPiCompatibilityEnv({
		gsdRoot: resolve('/repo'),
		agentDir: resolve('/agent'),
		gsdVersion: '2.80.0',
		existingNodePath: [resolve('/other/node_modules'), resolve('/third/node_modules')].join(delimiter),
	})

	assert.equal(
		env.NODE_PATH,
		[resolve('/repo/node_modules'), resolve('/other/node_modules'), resolve('/third/node_modules')].join(delimiter),
	)
})
