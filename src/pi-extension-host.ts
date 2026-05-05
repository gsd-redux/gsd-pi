// GSD-2 + src/pi-extension-host.ts — Extension host adapter between GSD resources and upstream Pi runtime
import { join, relative } from 'node:path'
import { discoverExtensionEntryPaths } from './extension-discovery.js'
import { readManifestFromEntryPath, type ExtensionManifest } from './extension-registry.js'

export interface ResolvePiExtensionEntriesOptions {
	resourcesDir: string
	agentDir: string
	isBundledExtensionEnabled?: (
		id: string,
		manifest: ExtensionManifest,
		sourceEntryPath: string,
	) => boolean
}

export function resolvePiExtensionEntries(options: ResolvePiExtensionEntriesOptions): string[] {
	const bundledExtDir = join(options.resourcesDir, 'extensions')
	const agentExtDir = join(options.agentDir, 'extensions')
	const isBundledExtensionEnabled = options.isBundledExtensionEnabled ?? (() => true)

	return discoverExtensionEntryPaths(bundledExtDir)
		.filter((sourceEntryPath) => {
			const manifest = readManifestFromEntryPath(sourceEntryPath)
			if (!manifest) return true
			return isBundledExtensionEnabled(manifest.id, manifest, sourceEntryPath)
		})
		.map((sourceEntryPath) => join(agentExtDir, relative(bundledExtDir, sourceEntryPath)))
}
