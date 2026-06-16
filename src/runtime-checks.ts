// Runtime dependency checks — pure helpers used by loader.ts.
// Extracted so they can be unit-tested without spawning the full loader.

import { existsSync } from 'fs'
import { delimiter, join } from 'path'

/**
 * Minimum supported Node.js major version. Kept in sync with
 * `engines.node` in package.json — see test
 * `loader MIN_NODE_MAJOR matches package.json engines field`.
 */
export const MIN_NODE_MAJOR = 22

/**
 * Parse a Node version string (e.g. "22.5.1") and return whether the major
 * version meets the required minimum.
 *
 * Returns `{ ok: true }` when supported, or `{ ok: false, actualMajor }`
 * when below the minimum. Throws if the version string is malformed —
 * callers should treat that as a fatal precondition violation.
 */
export function checkNodeVersion(
  versionString: string,
  min: number = MIN_NODE_MAJOR,
): { ok: true } | { ok: false; actualMajor: number } {
  const major = parseInt(versionString.split('.')[0], 10)
  if (!Number.isFinite(major)) {
    throw new Error(`checkNodeVersion: cannot parse major from "${versionString}"`)
  }
  return major < min ? { ok: false, actualMajor: major } : { ok: true }
}

/**
 * Probe whether `git` is available by invoking the supplied exec function.
 * Returns true on success, false if the exec throws (any reason). The
 * function is injected so tests can substitute a stub without spawning a
 * real subprocess.
 */
export function requireGit(
  execFn: (cmd: string, args: ReadonlyArray<string>) => unknown,
): boolean {
  try {
    execFn('git', ['--version'])
    return true
  } catch {
    return false
  }
}

/**
 * Fast presence check for `git`: scan the directories on `$PATH` for a `git`
 * executable (plus Windows `.exe`/`.cmd` variants) instead of spawning
 * `git --version`. The subprocess form costs ~15ms on every startup and showed
 * up as ~5% of cold-start CPU; a filesystem `existsSync` scan is far cheaper and
 * answers the same gate ("is git installed"). Returns true if a candidate path
 * exists. `env`/`platform` are injectable so this can be unit-tested without a
 * real $PATH.
 */
export function gitAvailableOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  if (pathValue.length === 0) return false
  const dirs = pathValue.split(delimiter).filter((d) => d.length > 0)
  const names = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => `git${ext.toLowerCase()}`).concat('git')
    : ['git']
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return true
    }
  }
  return false
}
