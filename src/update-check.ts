import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { dirname, join, resolve as resolvePath, sep, win32 as pathWin32 } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import chalk from 'chalk'
import { appRoot } from './app-paths.js'
import { isPnpmInstall } from './resources/shared/package-manager-detection.js'

export { isPnpmInstall }

export const GSD_PI_PACKAGE_NAME = '@opengsd/gsd-pi'
export const GSD_BROWSER_PACKAGE_NAME = '@opengsd/gsd-browser'

const CACHE_FILE = join(appRoot, '.update-check')
const GSD_BROWSER_CACHE_FILE = join(appRoot, '.update-check-gsd-browser')
const NPM_PACKAGE_NAME = GSD_PI_PACKAGE_NAME
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 5000
export const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/@opengsd%2fgsd-pi/latest`
export const GSD_BROWSER_REGISTRY_URL = `https://registry.npmjs.org/@opengsd%2fgsd-browser/latest`

interface UpdateCheckCache {
  lastCheck: number
  latestVersion: string
  packageName?: string
}

/**
 * Compares two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

export function readUpdateCache(cachePath: string = CACHE_FILE, packageName: string = NPM_PACKAGE_NAME): UpdateCheckCache | null {
  try {
    if (!existsSync(cachePath)) return null
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as UpdateCheckCache
    if (cache.packageName !== packageName) return null
    return cache
  } catch {
    return null
  }
}

export function writeUpdateCache(
  cache: Omit<UpdateCheckCache, 'packageName'> & { packageName?: string },
  cachePath: string = CACHE_FILE,
  packageName: string = NPM_PACKAGE_NAME,
): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify({ ...cache, packageName }))
  } catch {
    // Non-fatal — don't block startup if cache write fails
  }
}

function normalizeLatestVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null
  const trimmed = version.trim().replace(/^v/, '')
  return trimmed.length > 0 ? trimmed : null
}

export function resolveInstalledPackageVersion(packageName: string): string | null {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`)
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }
    return normalizeLatestVersion(pkg.version)
  } catch {
    return null
  }
}

/**
 * Resolves the gsd-browser version from PATH (via `gsd-browser --version`).
 * Respects GSD_BROWSER_PATH_VERSION env override for testing.
 * Returns null if gsd-browser is not on PATH or times out.
 */
export function resolveGsdBrowserPathVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GSD_BROWSER_PATH_VERSION?.trim()
  if (explicit) return explicit.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  try {
    const out = execFileSync('gsd-browser', ['--version'], {
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return out.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  } catch {
    return null
  }
}

export function pickHigherVersion(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return compareSemver(a, b) >= 0 ? a : b
}

export async function fetchLatestVersionFromRegistry(
  registryUrl: string = DEFAULT_REGISTRY_URL,
  fetchTimeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)

  try {
    const res = await fetch(registryUrl, { signal: controller.signal })
    if (!res.ok) return null

    const data = (await res.json()) as { version?: string }
    return normalizeLatestVersion(data.version)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Detects whether the currently-running gsd binary was installed via `bun add -g`.
 *
 * Bun's global bin entries on macOS/Linux are plain symlinks that point at the
 * package's bin file. The OS honors the target file's shebang, so a bin with
 * `#!/usr/bin/env node` runs under Node and `process.versions.bun` is undefined
 * — even though the binary was installed by bun. Checking the runtime alone
 * (PR #4147) misses this path. Inspect the unresolved invocation path instead.
 */
export function isBunInstall(argv1: string | undefined = process.argv[1]): boolean {
  if ('bun' in process.versions) return true
  if (!argv1) return false

  const bunBinDirs: string[] = []
  if (process.env.BUN_INSTALL) bunBinDirs.push(join(process.env.BUN_INSTALL, 'bin'))
  bunBinDirs.push(join(homedir(), '.bun', 'bin'))

  const resolved = resolvePath(argv1)
  return bunBinDirs.some((dir) => resolved.startsWith(resolvePath(dir) + sep))
}

export function resolveInstallCommand(
  pkg: string,
  options: {
    argv1?: string
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    existsFn?: (path: string) => boolean
  } = {},
): string {
  if (isBunInstall(options.argv1)) return `bun add -g ${pkg}`
  if (isPnpmInstall(options.argv1, options.env)) return `pnpm add -g ${pkg}`
  const npmPrefix = resolveWindowsNpmGlobalPrefix(options.argv1, options.platform, options.existsFn)
  if (npmPrefix) return `npm --prefix ${quoteWindowsArg(npmPrefix)} install -g ${pkg}`
  return `npm install -g ${pkg}`
}

function resolveWindowsNpmGlobalPrefix(
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
  existsFn: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== 'win32' || !argv1) return null
  const normalized = pathWin32.normalize(argv1)
  const marker = `${pathWin32.sep}node_modules${pathWin32.sep}`
  const index = normalized.toLowerCase().lastIndexOf(marker)
  if (index <= 0) return null
  const prefix = normalized.slice(0, index)
  // Verify this is a real npm global prefix: such a directory always contains
  // npm's own bin shim (`npm.cmd`) as a sibling of `node_modules/`. Local
  // project `node_modules/`, npx caches, and other non-global layouts do not,
  // so without this check `--prefix` would target the wrong directory.
  if (!existsFn(pathWin32.join(prefix, 'npm.cmd'))) return null
  return prefix
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function printUpdateBanner(current: string, latest: string, packageName: string = GSD_PI_PACKAGE_NAME): void {
  if (packageName === GSD_BROWSER_PACKAGE_NAME) {
    process.stderr.write(
      `  ${chalk.yellow('gsd-browser update available:')} ${chalk.dim(`v${current}`)} → ${chalk.bold(`v${latest}`)}\n` +
      `  ${chalk.dim('Run')} gsd update browser ${chalk.dim('to upgrade browser automation')}\n\n`,
    )
    return
  }

  const installCmd = resolveInstallCommand(`${GSD_PI_PACKAGE_NAME}@latest`)
  process.stderr.write(
    `  ${chalk.yellow('Update available:')} ${chalk.dim(`v${current}`)} → ${chalk.bold(`v${latest}`)}\n` +
    `  ${chalk.dim('Run')} ${installCmd} ${chalk.dim('or')} /gsd upgrade ${chalk.dim('to upgrade')}\n\n`,
  )
}

export interface UpdateCheckOptions {
  packageName?: string
  currentVersion?: string
  cachePath?: string
  registryUrl?: string
  checkIntervalMs?: number
  fetchTimeoutMs?: number
  onUpdate?: (current: string, latest: string, packageName: string) => void
}

function defaultCurrentVersion(packageName: string): string | null {
  if (packageName === GSD_PI_PACKAGE_NAME) {
    return process.env.GSD_VERSION || '0.0.0'
  }
  const bundled = resolveInstalledPackageVersion(packageName)
  if (packageName === GSD_BROWSER_PACKAGE_NAME) {
    return pickHigherVersion(bundled, resolveGsdBrowserPathVersion())
  }
  return bundled
}

function defaultCachePath(packageName: string): string {
  return packageName === GSD_BROWSER_PACKAGE_NAME ? GSD_BROWSER_CACHE_FILE : CACHE_FILE
}

function defaultRegistryUrl(packageName: string): string {
  return packageName === GSD_BROWSER_PACKAGE_NAME ? GSD_BROWSER_REGISTRY_URL : DEFAULT_REGISTRY_URL
}

/**
 * Non-blocking update check. Queries npm registry at most once per 24h,
 * caches the result, and prints a banner if a newer version is available.
 */
export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<void> {
  const packageName = options.packageName || GSD_PI_PACKAGE_NAME
  const cachePath = options.cachePath || defaultCachePath(packageName)
  const registryUrl = options.registryUrl || defaultRegistryUrl(packageName)
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
  const onUpdate = options.onUpdate || printUpdateBanner

  // Check cache — skip network if checked recently
  const cache = readUpdateCache(cachePath, packageName)
  if (cache && Date.now() - cache.lastCheck < checkIntervalMs) {
    // Resolve current version via cheap means (env var / installed package.json)
    // even when the caller did not pass options.currentVersion, so that a cached
    // "update available" result still produces a banner on subsequent startups
    // within the 24h window.  For gsd-browser, skip this fallback to avoid a
    // synchronous PATH binary spawn in the fast-path; the PATH version is only
    // resolved when the cache is stale and the check runs asynchronously.
    const currentVersion =
      options.currentVersion ??
      (packageName !== GSD_BROWSER_PACKAGE_NAME ? defaultCurrentVersion(packageName) : null)
    if (currentVersion && compareSemver(cache.latestVersion, currentVersion) > 0) {
      onUpdate(currentVersion, cache.latestVersion, packageName)
    }
    return
  }

  // For gsd-browser, resolving the default version may spawn the PATH binary.
  // Yield first so startup callers that do not await this check stay non-blocking.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  const currentVersion = options.currentVersion || defaultCurrentVersion(packageName)
  if (!currentVersion) return

  try {
    const latestVersion = await fetchLatestVersionFromRegistry(registryUrl, fetchTimeoutMs)
    if (!latestVersion) return

    writeUpdateCache({ lastCheck: Date.now(), latestVersion }, cachePath, packageName)

    if (compareSemver(latestVersion, currentVersion) > 0) {
      onUpdate(currentVersion, latestVersion, packageName)
    }
  } catch {
    // Network error or timeout — silently ignore, don't block startup
  }
}

export async function checkForGsdBrowserUpdates(options: UpdateCheckOptions = {}): Promise<void> {
  await checkForUpdates({
    ...options,
    packageName: GSD_BROWSER_PACKAGE_NAME,
  })
}

const PROMPT_TIMEOUT_MS = 30_000

/**
 * Interactive update prompt shown at startup when a newer version is available.
 * Fetches the latest version (with cache), then asks the user whether to
 * update now or skip. Runs at most once per 24 hours (same cache as checkForUpdates).
 * Defaults to skip after 30 seconds of inactivity.
 *
 * Returns true if an update was performed, false otherwise.
 */
export async function checkAndPromptForUpdates(options: UpdateCheckOptions = {}): Promise<boolean> {
  const currentVersion = options.currentVersion || process.env.GSD_VERSION || '0.0.0'
  const cachePath = options.cachePath || CACHE_FILE
  const registryUrl = options.registryUrl || DEFAULT_REGISTRY_URL
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS

  // Determine latest version (from cache or network)
  let latestVersion: string | null = null

  const cache = readUpdateCache(cachePath)
  if (cache && Date.now() - cache.lastCheck < checkIntervalMs) {
    latestVersion = cache.latestVersion
  } else {
    try {
      latestVersion = await fetchLatestVersionFromRegistry(registryUrl, fetchTimeoutMs)
      if (latestVersion) {
        writeUpdateCache({ lastCheck: Date.now(), latestVersion }, cachePath)
      }
    } catch {
      // Network unavailable — silently skip
    }
  }

  if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
    return false
  }

  // Update available — show interactive prompt
  // Measure visible (ANSI-free) width to size the box, then render with chalk.
  const midContent = `  ${chalk.bold('Update available!')} ${chalk.dim(`v${currentVersion}`)} → ${chalk.bold.green(`v${latestVersion}`)}  `
  const midVisible = `  Update available! v${currentVersion} → v${latestVersion}  `
  const innerWidth = midVisible.length
  const top = '╔' + '═'.repeat(innerWidth) + '╗'
  const bot = '╚' + '═'.repeat(innerWidth) + '╝'

  process.stderr.write('\n')
  process.stderr.write(
    `  ${chalk.yellow(top)}\n` +
    `  ${chalk.yellow('║')}${midContent}${chalk.yellow('║')}\n` +
    `  ${chalk.yellow(bot)}\n\n`,
  )

  // Use readline for a simple two-option prompt that works without @clack/prompts
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  const choice = await new Promise<string>((resolve) => {
    process.stderr.write(
      `  ${chalk.bold('[1]')} Update now   ${chalk.dim(resolveInstallCommand(`${NPM_PACKAGE_NAME}@latest`))}\n` +
      `  ${chalk.bold('[2]')} Skip\n\n`,
    )

    // Default to skip if the user doesn't respond within PROMPT_TIMEOUT_MS
    const timer = setTimeout(() => {
      process.stderr.write('\n')
      rl.close()
      resolve('2')
    }, PROMPT_TIMEOUT_MS)

    rl.question(`  ${chalk.bold('Choose [1/2]:')} `, (answer) => {
      clearTimeout(timer)
      resolve(answer.trim())
    })
  })

  rl.close()

  // Clean up stdin state so the TUI can start with a clean slate
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.setRawMode) process.stdin.setRawMode(false)
  process.stdin.pause()

  if (choice === '1') {
    const installCmd = resolveInstallCommand(`${NPM_PACKAGE_NAME}@latest`)
    process.stderr.write(`\n  ${chalk.dim('Running:')} ${installCmd}\n\n`)
    try {
      execSync(installCmd, { stdio: 'inherit' })
      process.stderr.write(`\n  ${chalk.green.bold(`✓ Updated to v${latestVersion}`)}\n\n`)
      return true
    } catch {
      process.stderr.write(`\n  ${chalk.yellow(`Update failed. You can run: ${installCmd}`)}\n\n`)
    }
  } else {
    process.stderr.write(`  ${chalk.dim('Skipped. Run')} gsd upgrade ${chalk.dim('anytime to upgrade.')}\n\n`)
  }

  return false
}
