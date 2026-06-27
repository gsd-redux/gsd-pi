import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

import {
  compareSemver,
  readUpdateCache,
  writeUpdateCache,
  checkForGsdBrowserUpdates,
  checkForUpdates,
  fetchLatestVersionFromRegistry,
  GSD_BROWSER_PACKAGE_NAME,
} from '../update-check.js'

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

test('compareSemver returns 0 for equal versions', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('2.8.3', '2.8.3'), 0)
})

test('compareSemver returns 1 when first is greater', () => {
  assert.equal(compareSemver('2.0.0', '1.0.0'), 1)
  assert.equal(compareSemver('1.1.0', '1.0.0'), 1)
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1)
  assert.equal(compareSemver('2.8.3', '2.7.1'), 1)
})

test('compareSemver returns -1 when first is smaller', () => {
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1)
  assert.equal(compareSemver('1.0.0', '1.1.0'), -1)
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1)
  assert.equal(compareSemver('2.3.11', '2.8.3'), -1)
})

test('compareSemver handles versions with different segment counts', () => {
  assert.equal(compareSemver('1.0', '1.0.0'), 0)
  assert.equal(compareSemver('1.0.0', '1.0'), 0)
  assert.equal(compareSemver('1.0', '1.0.1'), -1)
  assert.equal(compareSemver('1.0.1', '1.0'), 1)
})

// ---------------------------------------------------------------------------
// readUpdateCache / writeUpdateCache
// ---------------------------------------------------------------------------

test('readUpdateCache returns null for nonexistent file', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-cache-'))
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const result = readUpdateCache(join(tmp, 'nonexistent'))
  assert.equal(result, null)
})

test('readUpdateCache returns null for malformed JSON', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-cache-'))
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const cachePath = join(tmp, '.update-check')
  writeFileSync(cachePath, 'not json')
  const result = readUpdateCache(cachePath)
  assert.equal(result, null)
})

test('writeUpdateCache + readUpdateCache round-trips correctly', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-cache-'))
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const cachePath = join(tmp, '.update-check')
  const cache = { lastCheck: Date.now(), latestVersion: '3.0.0' }
  writeUpdateCache(cache, cachePath)
  const result = readUpdateCache(cachePath)
  assert.deepEqual(result, { ...cache, packageName: '@opengsd/gsd-pi' })
})

test('readUpdateCache ignores legacy cache entries without package identity', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-cache-'))
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const cachePath = join(tmp, '.update-check')
  writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion: '3.0.0' }))
  const result = readUpdateCache(cachePath)
  assert.equal(result, null)
})

test('writeUpdateCache creates parent directories', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-cache-'))
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const cachePath = join(tmp, 'nested', 'dir', '.update-check')
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '1.0.0' }, cachePath)
  const raw = readFileSync(cachePath, 'utf-8')
  assert.ok(raw.includes('1.0.0'))
})

// ---------------------------------------------------------------------------
// checkForUpdates — integration tests with a local HTTP server
// ---------------------------------------------------------------------------

function startMockRegistry(responseBody: object, statusCode = 200): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseBody))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function installCountingGsdBrowserShim(t: TestContext): { cachePath: string; spawnCountPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-browser-update-'))
  const binDir = join(tmp, 'bin')
  const cachePath = join(tmp, '.update-check-gsd-browser')
  const spawnCountPath = join(tmp, 'spawn-count')
  const originalPath = process.env.PATH
  const originalPathVersion = process.env.GSD_BROWSER_PATH_VERSION
  const originalSpawnCount = process.env.GSD_BROWSER_SPAWN_COUNT

  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    if (originalPathVersion === undefined) {
      delete process.env.GSD_BROWSER_PATH_VERSION
    } else {
      process.env.GSD_BROWSER_PATH_VERSION = originalPathVersion
    }
    if (originalSpawnCount === undefined) {
      delete process.env.GSD_BROWSER_SPAWN_COUNT
    } else {
      process.env.GSD_BROWSER_SPAWN_COUNT = originalSpawnCount
    }
    rmSync(tmp, { recursive: true, force: true })
  });

  mkdirSync(binDir)
  writeFileSync(spawnCountPath, '0')
  const shim = join(binDir, 'gsd-browser')
  writeFileSync(shim, [
    '#!/usr/bin/env node',
    "const { readFileSync, writeFileSync } = require('node:fs');",
    'const countPath = process.env.GSD_BROWSER_SPAWN_COUNT;',
    "const count = Number(readFileSync(countPath, 'utf8')) || 0;",
    "writeFileSync(countPath, String(count + 1));",
    "console.log('gsd-browser 9.9.9');",
    '',
  ].join('\n'))
  chmodSync(shim, 0o755)
  writeFileSync(join(binDir, 'gsd-browser.cmd'), '@echo off\r\nnode "%~dp0gsd-browser" %*\r\n')

  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`
  process.env.GSD_BROWSER_SPAWN_COUNT = spawnCountPath
  delete process.env.GSD_BROWSER_PATH_VERSION

  return { cachePath, spawnCountPath }
}

test('checkForUpdates calls onUpdate when newer version is available', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const registry = await startMockRegistry({ version: '99.0.0' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false
  let reportedCurrent = ''
  let reportedLatest = ''

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: (current, latest) => {
      called = true
      reportedCurrent = current
      reportedLatest = latest
    },
  })

  assert.ok(called, 'onUpdate should have been called')
  assert.equal(reportedCurrent, '1.0.0')
  assert.equal(reportedLatest, '99.0.0')
})

test('checkForUpdates does not call onUpdate when already on latest', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const registry = await startMockRegistry({ version: '1.0.0' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called when versions match')
})

test('checkForUpdates does not call onUpdate when current is ahead', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const registry = await startMockRegistry({ version: '1.0.0' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '2.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called when current is ahead')
})

test('checkForUpdates writes cache after successful fetch', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const cachePath = join(tmp, '.update-check')
  const registry = await startMockRegistry({ version: '5.0.0' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => {},
  })

  const cache = readUpdateCache(cachePath)
  assert.ok(cache, 'cache should exist after fetch')
  assert.equal(cache!.latestVersion, '5.0.0')
  assert.ok(cache!.lastCheck > 0)
})

test('checkForGsdBrowserUpdates checks and caches the browser package independently', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-browser-update-'))
  const cachePath = join(tmp, '.update-check-gsd-browser')
  const registry = await startMockRegistry({ version: '0.1.99' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let reportedPackage = ''
  let reportedLatest = ''

  await checkForGsdBrowserUpdates({
    currentVersion: '0.1.27',
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: (_current, latest, packageName) => {
      reportedLatest = latest
      reportedPackage = packageName
    },
  })

  assert.equal(reportedPackage, GSD_BROWSER_PACKAGE_NAME)
  assert.equal(reportedLatest, '0.1.99')
  assert.equal(readUpdateCache(cachePath), null, 'default GSD cache reader must ignore browser cache entries')
  assert.equal(readUpdateCache(cachePath, GSD_BROWSER_PACKAGE_NAME)?.latestVersion, '0.1.99')
})

test('checkForGsdBrowserUpdates treats a newer PATH browser as the current version', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-browser-update-'))
  const cachePath = join(tmp, '.update-check-gsd-browser')
  const registry = await startMockRegistry({ version: '0.2.2' })
  const originalPathVersion = process.env.GSD_BROWSER_PATH_VERSION
  t.after(async () => {
    if (originalPathVersion === undefined) {
      delete process.env.GSD_BROWSER_PATH_VERSION
    } else {
      process.env.GSD_BROWSER_PATH_VERSION = originalPathVersion
    }
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  process.env.GSD_BROWSER_PATH_VERSION = '0.2.2'
  let called = false

  await checkForGsdBrowserUpdates({
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.equal(called, false, 'startup banner must not fire when PATH already has latest gsd-browser')
  assert.equal(readUpdateCache(cachePath, GSD_BROWSER_PACKAGE_NAME)?.latestVersion, '0.2.2')
})

test('checkForGsdBrowserUpdates does not spawn PATH browser when browser cache is fresh', async (t) => {
  const { cachePath, spawnCountPath } = installCountingGsdBrowserShim(t)
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '9.9.9' }, cachePath, GSD_BROWSER_PACKAGE_NAME)

  await checkForGsdBrowserUpdates({
    cachePath,
    checkIntervalMs: 60 * 60 * 1000,
    fetchTimeoutMs: 1,
    onUpdate: () => {
      throw new Error('fresh browser cache should short-circuit before notification')
    },
  })

  assert.equal(readFileSync(spawnCountPath, 'utf-8'), '0')
})

test('checkForGsdBrowserUpdates defers PATH browser spawn when browser cache is stale', async (t) => {
  const { cachePath, spawnCountPath } = installCountingGsdBrowserShim(t)

  const pendingCheck = checkForGsdBrowserUpdates({
    cachePath,
    registryUrl: 'http://127.0.0.1:9',
    fetchTimeoutMs: 1,
    onUpdate: () => {
      throw new Error('network failure should prevent notification')
    },
  })

  assert.equal(readFileSync(spawnCountPath, 'utf-8'), '0')
  await pendingCheck
  assert.equal(readFileSync(spawnCountPath, 'utf-8'), '1')
})

test('checkForUpdates uses cache and skips fetch when checked recently', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const cachePath = join(tmp, '.update-check')
  // Write a fresh cache entry
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '10.0.0' }, cachePath)

  // Start server that would return a different version — should NOT be reached
  const registry = await startMockRegistry({ version: '20.0.0' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let reportedLatest = ''

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 60 * 60 * 1000, // 1 hour
    fetchTimeoutMs: 5000,
    onUpdate: (_current, latest) => { reportedLatest = latest },
  })

  // Should use cached version (10.0.0), not the server's (20.0.0)
  assert.equal(reportedLatest, '10.0.0')
})

test('checkForUpdates shows cached update banner even without explicit currentVersion (gsd-pi)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const cachePath = join(tmp, '.update-check')
  const originalVersion = process.env.GSD_VERSION
  t.after(() => {
    if (originalVersion === undefined) {
      delete process.env.GSD_VERSION
    } else {
      process.env.GSD_VERSION = originalVersion
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  process.env.GSD_VERSION = '1.0.0'
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '2.0.0' }, cachePath)

  let reportedCurrent = ''
  let reportedLatest = ''

  // Intentionally omit currentVersion — simulates the cli.ts call: checkForUpdates().catch(...)
  await checkForUpdates({
    cachePath,
    checkIntervalMs: 60 * 60 * 1000,
    onUpdate: (current, latest) => {
      reportedCurrent = current
      reportedLatest = latest
    },
  })

  assert.equal(reportedCurrent, '1.0.0', 'should resolve current version from GSD_VERSION env var')
  assert.equal(reportedLatest, '2.0.0', 'should report the cached latest version')
})

test('checkForGsdBrowserUpdates does not show banner from cache when currentVersion is absent (no spawn)', async (t) => {
  const { cachePath, spawnCountPath } = installCountingGsdBrowserShim(t)
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '9.9.9' }, cachePath, GSD_BROWSER_PACKAGE_NAME)

  let bannerFired = false

  await checkForGsdBrowserUpdates({
    cachePath,
    checkIntervalMs: 60 * 60 * 1000,
    fetchTimeoutMs: 1,
    onUpdate: () => { bannerFired = true },
  })

  assert.equal(readFileSync(spawnCountPath, 'utf-8'), '0', 'PATH binary must not be spawned in the fresh-cache fast-path')
  assert.equal(bannerFired, false, 'banner must not fire when gsd-browser currentVersion is absent — PATH spawn is deferred')
})

test('checkForUpdates ignores fresh legacy gsd-pi cache and fetches scoped package version', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const cachePath = join(tmp, '.update-check')
  writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion: '3.0.0' }))

  const registry = await startMockRegistry({ version: '1.0.1' })
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.1',
    cachePath,
    registryUrl: registry.url,
    checkIntervalMs: 60 * 60 * 1000,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'legacy 3.0.0 cache must not produce an update banner for @opengsd/gsd-pi')
  assert.equal(readUpdateCache(cachePath)?.latestVersion, '1.0.1')
})

test('checkForUpdates skips notification when cache is fresh and versions match', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const cachePath = join(tmp, '.update-check')
  writeUpdateCache({ lastCheck: Date.now(), latestVersion: '1.0.0' }, cachePath)

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath,
    checkIntervalMs: 60 * 60 * 1000,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called when cached version matches current')
})

test('checkForUpdates handles server error gracefully', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const registry = await startMockRegistry({}, 500)
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called on server error')
})

test('checkForUpdates handles network timeout gracefully', async (t) => {
  // Start a server that never responds
  const server = createServer(() => { /* intentionally never respond */ })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))

  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: `http://127.0.0.1:${addr.port}`,
    checkIntervalMs: 0,
    fetchTimeoutMs: 500, // Very short timeout
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called on timeout')
})

test('checkForUpdates handles missing version field in response', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-update-'))
  const registry = await startMockRegistry({ name: 'gsd-pi' }) // no version field
  t.after(async () => {
    await registry.close()
    rmSync(tmp, { recursive: true, force: true })
  });

  let called = false

  await checkForUpdates({
    currentVersion: '1.0.0',
    cachePath: join(tmp, '.update-check'),
    registryUrl: registry.url,
    checkIntervalMs: 0,
    fetchTimeoutMs: 5000,
    onUpdate: () => { called = true },
  })

  assert.ok(!called, 'onUpdate should not be called when response has no version')
})

test('fetchLatestVersionFromRegistry returns the registry version string', async (t) => {
  const registry = await startMockRegistry({ version: '2.67.0' })
  t.after(async () => {
    await registry.close()
  })

  const latest = await fetchLatestVersionFromRegistry(registry.url, 5000)
  assert.equal(latest, '2.67.0')
})

test('fetchLatestVersionFromRegistry returns null for blank version strings', async (t) => {
  const registry = await startMockRegistry({ version: '' })
  t.after(async () => {
    await registry.close()
  })

  const latest = await fetchLatestVersionFromRegistry(registry.url, 5000)
  assert.equal(latest, null)
})
