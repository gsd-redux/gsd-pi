// GSD Studio — regression: preload build output must be CommonJS
// Electron's sandboxed preload (contextIsolation + !nodeIntegration) cannot load ESM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const studioRoot = join(__dirname, '..')
const preloadCjs = join(studioRoot, 'dist/preload/index.cjs')
const preloadMjs = join(studioRoot, 'dist/preload/index.mjs')

test('preload artifact exists as .cjs (not .mjs) after build', () => {
  if (!existsSync(preloadCjs)) {
    execFileSync('npm', ['run', 'build'], { cwd: studioRoot, stdio: 'inherit' })
  }
  assert.equal(existsSync(preloadCjs), true, 'expected dist/preload/index.cjs to exist')
  assert.equal(existsSync(preloadMjs), false, 'preload must not be emitted as ESM (.mjs)')
})

test('preload artifact uses CommonJS (require, no ESM import)', () => {
  const source = readFileSync(preloadCjs, 'utf8')
  assert.match(source, /require\(["']electron["']\)/, 'expected CJS require("electron")')
  assert.doesNotMatch(source, /^\s*import\s/m, 'preload must not contain ESM import statements')
})
