import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const cliWeb = await import('../../cli-web-branch.ts')
const webMode = await import('../../web-mode.ts')

// ─── CLI flag parsing ────────────────────────────────────────────────

test('parseCliArgs captures --host flag', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--host', '0.0.0.0'])
  assert.equal(flags.web, true)
  assert.equal(flags.webHost, '0.0.0.0')
})

test('parseCliArgs captures --port flag', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--port', '8080'])
  assert.equal(flags.web, true)
  assert.equal(flags.webPort, 8080)
})

test('parseCliArgs ignores invalid port values', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--port', 'abc'])
  assert.equal(flags.webPort, undefined)
})

test('parseCliArgs ignores out-of-range port', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--port', '99999'])
  assert.equal(flags.webPort, undefined)
})

test('parseCliArgs captures --allowed-origins flag', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web', '--allowed-origins', 'http://192.168.1.10:3000'])
  assert.deepEqual(flags.webAllowedOrigins, ['http://192.168.1.10:3000'])
})

test('parseCliArgs splits comma-separated allowed origins', () => {
  const flags = cliWeb.parseCliArgs([
    'node', 'dist/loader.js', '--web',
    '--allowed-origins', 'http://192.168.1.10:3000,http://tailscale-host:3000',
  ])
  assert.deepEqual(flags.webAllowedOrigins, ['http://192.168.1.10:3000', 'http://tailscale-host:3000'])
})

test('parseCliArgs captures all web network flags together', () => {
  const flags = cliWeb.parseCliArgs([
    'node', 'dist/loader.js', '--web',
    '--host', '0.0.0.0',
    '--port', '4000',
    '--allowed-origins', 'http://my-tailscale:4000',
  ])
  assert.equal(flags.webHost, '0.0.0.0')
  assert.equal(flags.webPort, 4000)
  assert.deepEqual(flags.webAllowedOrigins, ['http://my-tailscale:4000'])
})

test('parseCliArgs does not set network flags when not provided', () => {
  const flags = cliWeb.parseCliArgs(['node', 'dist/loader.js', '--web'])
  assert.equal(flags.webHost, undefined)
  assert.equal(flags.webPort, undefined)
  assert.equal(flags.webAllowedOrigins, undefined)
})

// ─── launchWebMode env forwarding ────────────────────────────────────

test('launchWebMode forwards custom host, port, and allowed origins to subprocess env', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-net-'))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  const serverPath = join(standaloneRoot, 'server.js')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(serverPath, 'console.log("stub")\n')

  let spawnEnv: Record<string, string> | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '0.0.0.0',
      port: 8080,
      allowedOrigins: ['http://192.168.1.10:8080', 'http://tailscale-host:8080'],
    },
    {
      initResources: () => {},
      spawn: (_command, _args, options) => {
        spawnEnv = (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  assert.equal(status.ok, true)
  if (!status.ok) throw new Error('expected success')
  assert.equal(status.host, '0.0.0.0')
  assert.equal(status.port, 8080)
  assert.equal(status.url, 'http://0.0.0.0:8080')

  assert.ok(spawnEnv)
  assert.equal(spawnEnv!.HOSTNAME, '0.0.0.0')
  assert.equal(spawnEnv!.PORT, '8080')
  assert.equal(spawnEnv!.GSD_WEB_HOST, '0.0.0.0')
  assert.equal(spawnEnv!.GSD_WEB_PORT, '8080')
  assert.equal(spawnEnv!.GSD_WEB_ALLOWED_ORIGINS, 'http://192.168.1.10:8080,http://tailscale-host:8080')
})

test('launchWebMode omits GSD_WEB_ALLOWED_ORIGINS when none provided', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-no-origins-'))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  const serverPath = join(standaloneRoot, 'server.js')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(serverPath, 'console.log("stub")\n')

  let spawnEnv: Record<string, string> | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: { CLEAN_ENV: '1' },
      spawn: (_command, _args, options) => {
        spawnEnv = (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  assert.ok(spawnEnv)
  assert.equal(spawnEnv!.GSD_WEB_ALLOWED_ORIGINS, undefined)
})

// ─── no-auth loopback interlock ──────────────────────────────────────

function standaloneStub(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const standaloneRoot = join(tmp, 'dist', 'web', 'standalone')
  mkdirSync(standaloneRoot, { recursive: true })
  writeFileSync(join(standaloneRoot, 'server.js'), 'console.log("stub")\n')
  return tmp
}

test('launchWebMode refuses --no-auth on non-loopback host without override', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '0.0.0.0',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: {},
      spawn: () => { throw new Error('spawn should not be reached') },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  assert.equal(status.ok, false)
  if (status.ok) throw new Error('expected failure')
  assert.match(status.failureReason, /refusing to disable auth/)
  assert.match(status.failureReason, /GSD_WEB_ALLOW_UNAUTHENTICATED_LAN/)
  assert.match(status.failureReason, /\$env:GSD_WEB_ALLOW_UNAUTHENTICATED_LAN/)
  assert.match(status.failureReason, /docs\/user-docs\/web-interface\.md/)
})

test('launchWebMode allows --no-auth on non-loopback host with explicit override', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-override-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '0.0.0.0',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: { GSD_WEB_ALLOW_UNAUTHENTICATED_LAN: '1' },
      spawn: (_command, _args, options) => {
        void (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  // May succeed; if it fails for sandbox reasons, it must NOT be the interlock.
  if (!status.ok) assert.doesNotMatch(status.failureReason, /refusing to disable auth/)
})

test('launchWebMode allows --no-auth on loopback host (warning path preserved)', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-loopback-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '127.0.0.1',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: {},
      spawn: (_command, _args, options) => {
        void (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  if (!status.ok) assert.doesNotMatch(status.failureReason, /refusing to disable auth/)
})

test('launchWebMode does not fire interlock for IPv6 loopback ::1', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-ipv6-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '::1',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: {},
      spawn: (_command, _args, options) => {
        void (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  if (!status.ok) assert.doesNotMatch(status.failureReason, /refusing to disable auth/)
})

test('launchWebMode fires interlock for a 127.-prefixed hostname that is not an IPv4 address', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-127host-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  // A hostname like 127.example.com starts with "127." but is not a
  // 127.0.0.0/8 address; it can resolve to a public IP, so it must NOT be
  // treated as loopback and the no-auth interlock must fire.
  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '127.example.com',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => { throw new Error('resolvePort should not be reached') },
      env: {},
      spawn: () => { throw new Error('spawn should not be reached') },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  assert.equal(status.ok, false)
  if (status.ok) throw new Error('expected failure')
  assert.match(status.failureReason, /refusing to disable auth/)
})

test('launchWebMode does not fire interlock for a 127.0.0.0/8 IPv4 address', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-127net-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  // A genuine 127.0.0.0/8 address (other than 127.0.0.1) is still loopback and
  // keeps the warn-only no-auth behavior.
  const status = await webMode.launchWebMode(
    {
      cwd: '/tmp/project',
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '127.0.0.2',
      noAuth: true,
    },
    {
      initResources: () => {},
      resolvePort: async () => 45000,
      env: {},
      spawn: (_command, _args, options) => {
        void (options as { env: Record<string, string> }).env
        return { pid: 99999, once: () => undefined, unref: () => {} } as any
      },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  if (!status.ok) assert.doesNotMatch(status.failureReason, /refusing to disable auth/)
})

test('launchWebMode refusal does not clean up an existing instance (no side effects)', async (t) => {
  const tmp = standaloneStub('gsd-web-interlock-noside-')
  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const registryPath = join(tmp, 'web-instances.json')
  const cwd = join(tmp, 'project')
  // Seed a registered instance for this cwd. A non-existent PID keeps the test
  // safe: if the interlock regressed and cleanup ran, killPid would only see
  // ESRCH (it can never signal a real process) but would still unregister it.
  webMode.registerInstance(cwd, { pid: 2147483646, port: 45000, url: 'http://127.0.0.1:45000' }, registryPath)

  const status = await webMode.launchWebMode(
    {
      cwd,
      projectSessionsDir: '/tmp/.gsd/sessions',
      agentDir: '/tmp/.gsd/agent',
      packageRoot: tmp,
      host: '0.0.0.0',
      noAuth: true,
    },
    {
      initResources: () => {},
      registryPath,
      resolvePort: async () => { throw new Error('resolvePort should not be reached') },
      env: {},
      spawn: () => { throw new Error('spawn should not be reached') },
      waitForBootReady: async () => undefined,
      openBrowser: () => {},
      stderr: { write: () => true },
    },
  )

  assert.equal(status.ok, false)
  if (status.ok) throw new Error('expected failure')
  assert.match(status.failureReason, /refusing to disable auth/)

  // The pre-existing web server must still be registered: a refused launch must
  // not tear down a healthy instance via cleanupStaleInstance.
  const registry = webMode.readInstanceRegistry(registryPath)
  const entry = registry[resolve(cwd)]
  assert.ok(entry, 'existing instance entry should be preserved after a refused launch')
  assert.equal(entry.pid, 2147483646)
})

// ─── runWebCliBranch end-to-end forwarding ───────────────────────────

test('runWebCliBranch forwards --host, --port, --allowed-origins to launchWebMode', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-web-branch-flags-'))
  const projectDir = join(tmp, 'project')
  mkdirSync(projectDir, { recursive: true })

  let receivedOptions: Record<string, unknown> | undefined

  t.after(() => { rmSync(tmp, { recursive: true, force: true }) });

  const flags = cliWeb.parseCliArgs([
    'node', 'dist/loader.js', '--web', projectDir,
    '--host', '0.0.0.0',
    '--port', '9000',
    '--allowed-origins', 'http://my-host:9000',
  ])

  const result = await cliWeb.runWebCliBranch(flags, {
    runWebMode: async (options) => {
      receivedOptions = options as unknown as Record<string, unknown>
      return {
        mode: 'web' as const,
        ok: true as const,
        cwd: options.cwd,
        projectSessionsDir: options.projectSessionsDir,
        host: '0.0.0.0',
        port: 9000,
        url: 'http://0.0.0.0:9000',
        hostKind: 'source-dev' as const,
        hostPath: '/tmp/fake-web/package.json',
        hostRoot: '/tmp/fake-web',
      }
    },
    stderr: { write: () => true },
  })

  assert.equal(result.handled, true)
  if (!result.handled) throw new Error('expected handled')
  assert.equal(result.exitCode, 0)
  assert.ok(receivedOptions)
  assert.equal(receivedOptions!.host, '0.0.0.0')
  assert.equal(receivedOptions!.port, 9000)
  assert.deepEqual(receivedOptions!.allowedOrigins, ['http://my-host:9000'])
})
