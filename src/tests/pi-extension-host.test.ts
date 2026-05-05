// GSD-2 + src/tests/pi-extension-host.test.ts — Tests for the Pi extension host boundary
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolvePiExtensionEntries } from '../pi-extension-host.ts'

function writeExtension(dir: string, id: string, tier: 'bundled' | 'community' = 'bundled'): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'extension-manifest.json'), JSON.stringify({
		id,
		name: id,
		version: '1.0.0',
		description: `${id} extension`,
		tier,
		requires: { platform: '>=2.80.0' },
		provides: { tools: [id] },
	}, null, 2))
	writeFileSync(join(dir, 'index.ts'), `export default function ${id.replace(/[^a-zA-Z0-9_$]/g, '_')}() {}`)
}

test('resolvePiExtensionEntries maps bundled resources to agent extension paths', () => {
	const root = mkdtempSync(join(tmpdir(), 'gsd-pi-host-'))
	const resourcesDir = join(root, 'resources')
	const bundledDir = join(resourcesDir, 'extensions', 'demo')
	const agentDir = join(root, 'agent')
	writeExtension(bundledDir, 'demo')

	const entries = resolvePiExtensionEntries({ resourcesDir, agentDir })

	assert.deepEqual(entries, [join(agentDir, 'extensions', 'demo', 'index.ts')])
})

test('resolvePiExtensionEntries filters disabled bundled manifests before staging path remap', () => {
	const root = mkdtempSync(join(tmpdir(), 'gsd-pi-host-'))
	const resourcesDir = join(root, 'resources')
	const bundledDir = join(resourcesDir, 'extensions', 'disabled')
	const agentDir = join(root, 'agent')
	writeExtension(bundledDir, 'disabled')

	const entries = resolvePiExtensionEntries({
		resourcesDir,
		agentDir,
		isBundledExtensionEnabled: () => false,
	})

	assert.deepEqual(entries, [])
})

test('resolvePiExtensionEntries keeps extensions without manifests loadable', () => {
	const root = mkdtempSync(join(tmpdir(), 'gsd-pi-host-'))
	const resourcesDir = join(root, 'resources')
	const extensionDir = join(resourcesDir, 'extensions', 'legacy')
	const agentDir = join(root, 'agent')
	mkdirSync(extensionDir, { recursive: true })
	writeFileSync(join(extensionDir, 'index.ts'), 'export default function legacy() {}')

	const entries = resolvePiExtensionEntries({
		resourcesDir,
		agentDir,
		isBundledExtensionEnabled: () => false,
	})

	assert.deepEqual(entries, [join(agentDir, 'extensions', 'legacy', 'index.ts')])
})
