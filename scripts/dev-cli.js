#!/usr/bin/env node
// GSD2 - Dev CLI wrapper for running the source-mode CLI.

import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDevCliChildEnv, buildDevCliSpawnArgs, buildWorkspaceBuildPreflight } from './dev-cli-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const devCliPath = fileURLToPath(import.meta.url)
const root = resolve(__dirname, '..')
const srcLoaderPath = resolve(root, 'src', 'loader.ts')
const resolveTsPath = resolve(root, 'src', 'resources', 'extensions', 'gsd', 'tests', 'resolve-ts.mjs')

function runDevCli() {
  const preflight = buildWorkspaceBuildPreflight({ root })
  const preflightResult = spawnSync(preflight.command, preflight.args, preflight.options)
  if (preflightResult.error) {
    console.warn(`[gsd] Workspace build preflight skipped: ${preflightResult.error.message}`)
  }

  const child = spawn(
    process.execPath,
    buildDevCliSpawnArgs({ resolveTsPath, srcLoaderPath, argv: process.argv.slice(2) }),
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: buildDevCliChildEnv(process.env, devCliPath),
    },
  )

  child.on('error', (error) => {
    console.error(`[gsd] Failed to launch local dev CLI: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === devCliPath) {
  runDevCli()
}
