import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, delimiter as pathDelimiter, resolve as resolvePath } from 'node:path'
import { isPnpmInstall, pathStartsWith } from './package-manager-detection.js'

export interface GsdBrowserPathReconcileResult {
  action: 'none' | 'synced' | 'shadowed'
  pathCli?: string
  installedCli?: string
  syncTarget?: string
  message?: string
}

function isBunGlobalInstall(argv1: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if ('bun' in process.versions) return true
  if (!argv1) return false

  const bunBinDirs: string[] = []
  if (env.BUN_INSTALL) bunBinDirs.push(join(env.BUN_INSTALL, 'bin'))
  bunBinDirs.push(join(homedir(), '.bun', 'bin'))

  return bunBinDirs.some((dir) => pathStartsWith(argv1, dir))
}

function gsdBrowserBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'gsd-browser.cmd' : 'gsd-browser'
}

function tryResolveFromBinDir(binDir: string, platform: NodeJS.Platform): string | null {
  const primary = join(binDir, gsdBrowserBinaryName(platform))
  if (existsSync(primary)) return primary

  if (platform === 'win32') {
    const fallback = join(binDir, 'gsd-browser')
    if (existsSync(fallback)) return fallback
  }

  return null
}

function tryResolveFromPackageRoot(
  rootDir: string,
  platform: NodeJS.Platform,
): string | null {
  const candidate = join(rootDir, '@opengsd', 'gsd-browser', 'bin', gsdBrowserBinaryName(platform))
  if (existsSync(candidate)) return candidate

  if (platform === 'win32') {
    const fallback = join(rootDir, '@opengsd', 'gsd-browser', 'bin', 'gsd-browser')
    if (existsSync(fallback)) return fallback
  }

  return null
}

function tryExecLookup(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  resolve: (dir: string, platform: NodeJS.Platform) => string | null,
): string | null {
  try {
    const dir = execFileSync(command, args, {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
    return resolve(dir, platform)
  } catch {
    return null
  }
}

function resolvePathBinary(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    try {
      const out = execFileSync('where', ['gsd-browser'], {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim()
      const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      return first && existsSync(first) ? first : null
    } catch {
      return null
    }
  }

  for (const entry of (env.PATH ?? '').split(pathDelimiter)) {
    if (!entry) continue
    const candidate = join(entry, 'gsd-browser')
    if (existsSync(candidate)) return candidate
  }

  return null
}

function resolveRealPath(pathValue: string): string {
  try {
    return realpathSync(pathValue)
  } catch {
    return resolvePath(pathValue)
  }
}

function resolveSymlinkTarget(pathCli: string): string {
  try {
    const stat = lstatSync(pathCli)
    if (!stat.isSymbolicLink()) return pathCli

    const target = readlinkSync(pathCli)
    return isAbsolute(target) ? target : resolvePath(dirname(pathCli), target)
  } catch {
    // PATH entry vanished or is inaccessible between resolution and sync.
    // Fall back to the original path; subsequent sync will surface a useful
    // error rather than escaping as an unhandled throw.
    return pathCli
  }
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOME?.trim() || env.USERPROFILE?.trim()
  return resolvePath(fromEnv || homedir())
}

function canAutoSyncTarget(targetPath: string, env: NodeJS.ProcessEnv): boolean {
  const home = resolveHomeDir(env)
  const resolved = resolvePath(targetPath)
  return pathStartsWith(resolved, home)
}

function syncBinary(installedCli: string, targetPath: string, platform: NodeJS.Platform): void {
  const source = resolveRealPath(installedCli)
  copyFileSync(source, targetPath)
  if (platform !== 'win32') {
    chmodSync(targetPath, 0o755)
  }
}

/**
 * Resolve the gsd-browser binary installed by the active global package manager.
 */
function resolveGlobalGsdBrowserCliPath(
  options: { env?: NodeJS.ProcessEnv; argv1?: string; platform?: NodeJS.Platform } = {},
): string | null {
  const env = options.env ?? process.env
  const argv1 = options.argv1 ?? process.argv[1]
  const platform = options.platform ?? process.platform

  if (isBunGlobalInstall(argv1, env)) {
    return (
      tryExecLookup('bun', ['pm', 'bin', '-g'], env, platform, tryResolveFromBinDir)
      ?? (env.BUN_INSTALL ? tryResolveFromBinDir(join(env.BUN_INSTALL, 'bin'), platform) : null)
      ?? tryResolveFromBinDir(join(homedir(), '.bun', 'bin'), platform)
    )
  }

  if (isPnpmInstall(argv1, env)) {
    return (
      tryExecLookup('pnpm', ['bin', '-g'], env, platform, tryResolveFromBinDir)
      ?? tryExecLookup('pnpm', ['root', '-g'], env, platform, tryResolveFromPackageRoot)
    )
  }

  return (
    tryExecLookup('npm', ['bin', '-g'], env, platform, tryResolveFromBinDir)
    ?? tryExecLookup('npm', ['root', '-g'], env, platform, tryResolveFromPackageRoot)
  )
}

/**
 * Resolve the gsd-browser binary that wins on PATH (`command -v` / `where`).
 */
function resolveGsdBrowserOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolvePathBinary(env, platform)
}

/**
 * After a global gsd-browser install, ensure the PATH-resolved binary matches
 * the freshly installed global binary when an older copy is shadowing it.
 */
export function reconcileGsdBrowserPathAfterInstall(
  options: {
    latestVersion: string
    compareSemver: (a: string, b: string) => number
    resolvePathVersion: (env: NodeJS.ProcessEnv) => string | null
    env?: NodeJS.ProcessEnv
    argv1?: string
    platform?: NodeJS.Platform
  },
): GsdBrowserPathReconcileResult {
  const env = options.env ?? process.env
  const argv1 = options.argv1 ?? process.argv[1]
  const platform = options.platform ?? process.platform

  const installedCli = resolveGlobalGsdBrowserCliPath({ env, argv1, platform })
  if (!installedCli) {
    return { action: 'none' }
  }

  const pathCli = resolveGsdBrowserOnPath(env, platform)
  const installedReal = resolveRealPath(installedCli)
  if (pathCli && resolveRealPath(pathCli) === installedReal) {
    return { action: 'none', pathCli, installedCli }
  }

  const pathVersion = options.resolvePathVersion(env)
  if (pathVersion && options.compareSemver(pathVersion, options.latestVersion) >= 0) {
    return { action: 'none', pathCli: pathCli ?? undefined, installedCli }
  }

  if (!pathCli) {
    return {
      action: 'shadowed',
      installedCli,
      message:
        'Installed gsd-browser globally, but no gsd-browser was found on PATH. Add your package manager global bin directory to PATH.',
    }
  }

  const syncTarget = resolveSymlinkTarget(pathCli)
  if (!canAutoSyncTarget(syncTarget, env)) {
    return {
      action: 'shadowed',
      pathCli,
      installedCli,
      syncTarget,
      message:
        `PATH resolves gsd-browser to ${pathCli}, but the updated global install is at ${installedCli}. ` +
        'Move your package manager global bin directory ahead of the stale location on PATH, or update the stale binary manually.',
    }
  }

  let syncSucceeded = false
  try {
    syncBinary(installedCli, syncTarget, platform)
    syncSucceeded = true
  } catch {
    // Fall through to shadowed guidance.
  }

  if (syncSucceeded) {
    const refreshedVersion = options.resolvePathVersion(env)
    const verified = refreshedVersion !== null
      && options.compareSemver(refreshedVersion, options.latestVersion) >= 0
    return {
      action: 'synced',
      pathCli,
      installedCli,
      syncTarget,
      message: verified
        ? `Synced PATH-resolved gsd-browser at ${syncTarget} to the updated global install.`
        : `Synced PATH-resolved gsd-browser at ${syncTarget} to the updated global install. Could not verify the new version on PATH; restart your shell or rerun if it still reports the old version.`,
    }
  }

  return {
    action: 'shadowed',
    pathCli,
    installedCli,
    syncTarget,
    message:
      `PATH resolves gsd-browser to ${pathCli}, but the updated global install is at ${installedCli}. ` +
      'Move your package manager global bin directory ahead of the stale location on PATH, or update the stale binary manually.',
  }
}
