import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { runMcpServerCli } from './cli-runner.js';

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function waitFor<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs)),
  ]);
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for child pid=${child.pid ?? 'unknown'} exit`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function spawnMcpServer(projectDir: string, gsdHome: string): ChildProcessWithoutNullStreams {
  const runnerUrl = new URL('./cli-runner.js', import.meta.url).href;
  const code = `
    import { runMcpServerCli } from ${JSON.stringify(runnerUrl)};
    await runMcpServerCli({
      sweepProjectOrphanMcpServers() {},
      createMcpServer: async () => ({ server: { connect: async () => new Promise(() => {}), close: async () => {} } }),
      importStdioServerTransport: async () => ({ StdioServerTransport: class {} }),
      warmWorkflowToolBridges() {},
    });
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: projectDir,
    env: {
      ...process.env,
      GSD_HOME: gsdHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function waitForRegistryPid(gsdHome: string, pid: number | undefined, timeoutMs = 5_000): Promise<void> {
  assert.ok(pid, 'spawned child must have a pid');
  const registryPath = join(gsdHome, 'mcp-instances.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, { pid?: number }>;
      if (Object.values(registry).some((entry) => entry.pid === pid)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for registry pid=${pid}`);
}

describe('runMcpServerCli', () => {
  test('unregisters the instance when startup fails after registration', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: {},
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers(projectDir) {
          calls.push(`sweep:${projectDir}`);
        },
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('create failed');
        },
        async importStdioServerTransport() {
          throw new Error('should not import transport');
        },
        warmWorkflowToolBridges() {
          throw new Error('should not warm bridges');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, [
      'load-env',
      'sweep:/workspace/project',
      'register:/workspace/project',
      'create-session-manager',
      'create-server',
      'unregister:/workspace/project',
      'cleanup-session-manager',
    ]);
  });

  test('skips PID registry registration for probe-mode stdio sessions', async () => {
    const calls: string[] = [];
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: { GSD_MCP_PROBE: '1' },
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers(projectDir) {
          calls.push(`sweep:${projectDir}`);
        },
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          throw new Error('create failed');
        },
        async importStdioServerTransport() {
          throw new Error('should not import transport');
        },
        warmWorkflowToolBridges() {
          throw new Error('should not warm bridges');
        },
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          throw new Error('should not start interval');
        },
        clearInterval() {},
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    assert.deepEqual(calls, [
      'load-env',
      'create-session-manager',
      'create-server',
      'cleanup-session-manager',
    ]);
  });

  test('fails closed and never connects when workflow bridge warm-up fails', async () => {
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    const stdin = new PassThrough();
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(String(chunk));
        callback();
      },
    });

    await assert.rejects(
      runMcpServerCli({
        cwd: () => '/workspace/project',
        env: {},
        exit(code) {
          throw new ExitError(code);
        },
        loadStoredCredentialEnvKeys() {
          calls.push('load-env');
        },
        registerMcpInstance(projectDir) {
          calls.push(`register:${projectDir}`);
        },
        sweepProjectOrphanMcpServers() {},
        unregisterMcpInstance(projectDir) {
          calls.push(`unregister:${projectDir}`);
        },
        createSessionManager() {
          calls.push('create-session-manager');
          return {
            async cleanup() {
              calls.push('cleanup-session-manager');
            },
          };
        },
        async createMcpServer() {
          calls.push('create-server');
          return {
            server: {
              async connect() {
                calls.push('connect');
              },
              async close() {
                calls.push('close-server');
              },
            },
          };
        },
        async importStdioServerTransport() {
          calls.push('import-transport');
          return {
            StdioServerTransport: class {
              constructor() {
                calls.push('create-transport');
              }
            },
          };
        },
        warmWorkflowToolBridges() {
          calls.push('warm-bridges');
          throw new Error('bridge unavailable');
        },
        stdin,
        stdout: new PassThrough(),
        stderr,
        onSignal() {},
        now: () => 0,
        setInterval() {
          calls.push('set-interval');
          return { unref() {} } as ReturnType<typeof setInterval>;
        },
        clearInterval() {
          calls.push('clear-interval');
        },
        isOrphaned: () => false,
      }),
      (error) => error instanceof ExitError && error.code === 1,
    );

    // Bridge warm-up is attempted, but a broken bridge must abort startup
    // before the transport connects — the client never sees the tool surface.
    assert.ok(calls.includes('warm-bridges'), 'bridge warm-up should be attempted');
    assert.ok(!calls.includes('connect'), 'server must NOT connect when bridges fail');
    // Registration is rolled back and the server is torn down on the failure path.
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('close-server'));
    assert.match(stderrChunks.join(''), /Fatal: failed to start/);
    assert.match(stderrChunks.join(''), /bridge unavailable/);
  });

  test('keeps fatal startup failures on exit code 1 when stdin closes during cleanup', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    let cleanupCount = 0;

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            cleanupCount += 1;
            calls.push(`cleanup-session-manager:${cleanupCount}`);
            stdin.emit('close');
            await new Promise((resolve) => setImmediate(resolve));
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {
        throw new Error('bridge unavailable');
      },
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => 0,
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      isOrphaned: () => false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.filter((call) => call.startsWith('exit:')), ['exit:1']);
    assert.deepEqual(calls.filter((call) => call.startsWith('cleanup-session-manager')), [
      'cleanup-session-manager:1',
    ]);
    assert.ok(!calls.includes('connect'), 'server must NOT connect when bridges fail');
  });

  test('shuts down when stdio closes without waiting for the idle watchdog', async () => {
    const calls: string[] = [];
    const stdin = new PassThrough();
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {
        calls.push('load-env');
      },
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => 0,
      setInterval() {
        calls.push('set-interval');
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => false,
    });

    stdin.emit('close');

    assert.equal(await waitFor(exitPromise), 0);
    assert.ok(calls.includes('unregister:/workspace/project'));
    assert.ok(calls.includes('cleanup-session-manager'));
    assert.ok(calls.includes('close-server'));
    assert.ok(calls.includes('exit:0'));
  });

  test('stays alive when parent is gone but stdin is still active', async () => {
    const calls: string[] = [];
    const intervals: Array<() => void> = [];
    const stdin = new PassThrough();
    let now = 0;

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      onSignal() {},
      now: () => now,
      setInterval(callback: Parameters<typeof setInterval>[0]) {
        intervals.push(callback as () => void);
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => true,
    });

    assert.equal(intervals.length, 1);
    stdin.write('{"jsonrpc":"2.0","method":"initialize"}\n');
    now = 1_000;
    intervals[0]();

    assert.ok(!calls.includes('exit:0'));
    assert.ok(!calls.includes('unregister:/workspace/project'));
  });

  test('exits shutdown when server close hangs', async () => {
    const calls: string[] = [];
    const stderrChunks: string[] = [];
    let sigtermListener!: () => void;
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    await runMcpServerCli({
      cwd: () => '/workspace/project',
      env: {},
      exit(code) {
        calls.push(`exit:${code}`);
        resolveExit(code);
        return undefined as never;
      },
      loadStoredCredentialEnvKeys() {},
      registerMcpInstance(projectDir) {
        calls.push(`register:${projectDir}`);
      },
      sweepProjectOrphanMcpServers() {},
      unregisterMcpInstance(projectDir) {
        calls.push(`unregister:${projectDir}`);
      },
      createSessionManager() {
        return {
          async cleanup() {
            calls.push('cleanup-session-manager');
          },
        };
      },
      async createMcpServer() {
        return {
          server: {
            async connect() {
              calls.push('connect');
            },
            async close() {
              calls.push('close-server');
              await new Promise(() => {});
            },
          },
        };
      },
      async importStdioServerTransport() {
        return {
          StdioServerTransport: class {},
        };
      },
      warmWorkflowToolBridges() {},
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new Writable({
        write(chunk, _encoding, callback) {
          stderrChunks.push(String(chunk));
          callback();
        },
      }),
      onSignal(signal, listener) {
        if (signal === 'SIGTERM') sigtermListener = listener;
      },
      now: () => 0,
      setInterval() {
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {
        calls.push('clear-interval');
      },
      isOrphaned: () => false,
      cleanupStepTimeoutMs: 10,
    });

    sigtermListener();

    assert.equal(await waitFor(exitPromise), 0);
    assert.ok(calls.includes('close-server'));
    assert.ok(calls.includes('exit:0'));
    assert.match(stderrChunks.join(''), /Cleanup step timed out: server close/);
  });

  // Real-subprocess integration test: spawns actual MCP servers with
  // cwd=projectDir and relies on POSIX process cwd introspection (lsof/pwdx) to
  // verify the stale same-project server before killing it. Windows has no
  // equivalent cwd lookup, and it locks a running process's working directory
  // (so the temp-dir cleanup throws EPERM). The kill/registry logic itself is
  // covered cross-platform by the injected-dependency unit tests above.
  test('second real CLI launch for same project stops the prior registered process', {
    skip: process.platform === 'win32'
      ? 'real-process cwd introspection and temp-dir cleanup are unavailable on Windows'
      : false,
  }, async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'mcp-restart-project-'));
    const gsdHome = mkdtempSync(join(tmpdir(), 'mcp-restart-home-'));
    let first: ChildProcessWithoutNullStreams | undefined;
    let second: ChildProcessWithoutNullStreams | undefined;

    try {
      first = spawnMcpServer(projectDir, gsdHome);
      await waitForRegistryPid(gsdHome, first.pid);

      const firstExit = waitForChildExit(first);
      second = spawnMcpServer(projectDir, gsdHome);
      await waitForRegistryPid(gsdHome, second.pid);

      const exited = await firstExit;
      assert.ok(
        exited.code === 0 || exited.signal === 'SIGTERM' || exited.signal === 'SIGKILL',
        `expected first process to stop after second launch, got code=${exited.code} signal=${exited.signal}`,
      );

      const secondExit = waitForChildExit(second);
      second.stdin.end();
      assert.equal((await secondExit).code, 0);
    } finally {
      for (const child of [first, second]) {
        if (child && !child.killed && child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });
});
