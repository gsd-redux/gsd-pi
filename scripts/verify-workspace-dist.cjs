// gsd-pi + scripts/verify-workspace-dist.cjs
// Fails the release when any publishable workspace package lacks build output.
// npm publish --ignore-scripts skips per-package builds, so an unwired package
// otherwise publishes as bin+README only.
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const out = execFileSync('node', [join(__dirname, 'lib', 'npm-release-packages.cjs'), '--workspace-dirs'], { encoding: 'utf8' })
const failures = []
for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
  const [name, dir] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]
  const dist = join(root, dir, 'dist')
  if (!existsSync(dist) || readdirSync(dist).length === 0) {
    failures.push(`${name} (${dir}/dist missing or empty)`)
  }
}
if (failures.length > 0) {
  process.stderr.write(`ERROR: workspace package(s) not built — refusing to publish:\n${failures.map((f) => `  - ${f}`).join('\n')}\nRun the matching build:* script (see root package.json) before publishing.\n`)
  process.exit(1)
}
process.stderr.write('All publishable workspace packages have non-empty dist/.\n')
