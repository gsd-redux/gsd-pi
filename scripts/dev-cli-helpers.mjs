// GSD2 - Dev CLI child-process spawn helpers.

import { join } from 'node:path'

export function buildWorkspaceBuildPreflight({ root }) {
  return {
    command: process.execPath,
    args: [join(root, 'scripts', 'ensure-workspace-builds.cjs')],
    options: {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000,
    },
  }
}

export function buildDevCliSpawnArgs({
  resolveTsPath,
  srcLoaderPath,
  argv,
}) {
  return ['--import', resolveTsPath, '--experimental-strip-types', srcLoaderPath, ...argv]
}

export function buildDevCliChildEnv(baseEnv, devCliPath) {
  return {
    ...baseEnv,
    // Child GSD processes (subagents, parallel workers, workflow MCP)
    // must re-enter through this wrapper so source-mode TS imports keep
    // using resolve-ts. Pointing them at src/loader.ts directly makes Node
    // resolve .js specifiers without the TS resolver.
    GSD_DEV_CLI_PATH: devCliPath,
    GSD_CLI_PATH: devCliPath,
    GSD_BIN_PATH: devCliPath,
  }
}
