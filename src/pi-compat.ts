// GSD-2 + src/pi-compat.ts — Compatibility helpers for adapting upstream Pi runtime to GSD
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export interface PiCompatibilityEnvOptions {
	gsdRoot: string
	agentDir: string
	gsdVersion: string
	invokedBinPath?: string
	sourceLoaderPath?: string
	devCliPath?: string
	explicitCliPath?: string
	existingNodePath?: string
	pathExists?: (path: string) => boolean
}

export interface PiCompatibilityEnv {
	PI_PACKAGE_DIR: string
	PI_SKIP_VERSION_CHECK: string
	GSD_CODING_AGENT_DIR: string
	GSD_PKG_ROOT: string
	GSD_VERSION: string
	GSD_BIN_PATH?: string
	GSD_CLI_PATH?: string
	NODE_PATH: string
}

export function buildPiCompatibilityEnv(options: PiCompatibilityEnvOptions): PiCompatibilityEnv {
	const pathExists = options.pathExists ?? existsSync
	const pkgDir = resolve(options.gsdRoot, 'pkg')
	const invokedBinPath = options.invokedBinPath ? resolve(options.invokedBinPath) : undefined
	const sourceLoaderPath = options.sourceLoaderPath ? resolve(options.sourceLoaderPath) : undefined
	const devCliPath = options.devCliPath ? resolve(options.devCliPath) : undefined
	const explicitCliPath = options.explicitCliPath?.trim()
	const isSourceLoader = Boolean(invokedBinPath && sourceLoaderPath && invokedBinPath === sourceLoaderPath)
	const rawGsdBinPath = explicitCliPath || (isSourceLoader && devCliPath && pathExists(devCliPath) ? devCliPath : invokedBinPath)
	const resolvedGsdBinPath = rawGsdBinPath ? resolve(rawGsdBinPath) : undefined

	return {
		PI_PACKAGE_DIR: pkgDir,
		PI_SKIP_VERSION_CHECK: '1',
		GSD_CODING_AGENT_DIR: options.agentDir,
		GSD_PKG_ROOT: options.gsdRoot,
		GSD_VERSION: options.gsdVersion,
		GSD_BIN_PATH: resolvedGsdBinPath,
		GSD_CLI_PATH: resolvedGsdBinPath,
		NODE_PATH: [join(options.gsdRoot, 'node_modules'), options.existingNodePath]
			.filter(Boolean)
			.join(delimiter),
	}
}
