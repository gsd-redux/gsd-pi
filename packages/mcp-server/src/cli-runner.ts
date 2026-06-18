import type { Readable, Writable } from 'node:stream';

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';
import { loadStoredCredentialEnvKeys } from './tool-credentials.js';
import { warmWorkflowToolBridges } from './workflow-tools.js';
import { isMcpProbeSession } from './probe-mode.js';
import {
  registerMcpInstance,
  sweepProjectOrphanMcpServers,
  unregisterMcpInstance,
} from './pid-registry.js';
import { createActivityTrackingInput, type ActivityTrackingInput } from './stdio-watchdog.js';

const MCP_PKG = '@modelcontextprotocol/sdk';

const STDIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const STDIN_IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const CLEANUP_STEP_TIMEOUT_MS = 2 * 1000;

interface SessionManagerLike {
  cleanup(): Promise<void>;
}

interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface StdioTransportConstructor {
  new(input?: Readable, output?: Writable): unknown;
}

export interface RunMcpServerCliOptions {
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => never;
  loadStoredCredentialEnvKeys?: () => void;
  registerMcpInstance?: (projectDir: string) => boolean | void;
  sweepProjectOrphanMcpServers?: (projectDir: string) => void;
  unregisterMcpInstance?: (projectDir: string) => void;
  createSessionManager?: () => SessionManagerLike;
  createMcpServer?: (sessionManager: SessionManagerLike) => Promise<{ server: McpServerLike }>;
  importStdioServerTransport?: () => Promise<{ StdioServerTransport: StdioTransportConstructor }>;
  warmWorkflowToolBridges?: () => Promise<unknown> | unknown;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  isOrphaned?: () => boolean;
  cleanupStepTimeoutMs?: number;
}

function createDefaultIsOrphaned(initialParentPid: number): () => boolean {
  return () => {
    if (process.ppid !== initialParentPid) return true;
    try {
      process.kill(initialParentPid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
}

async function importDefaultStdioServerTransport(): Promise<{ StdioServerTransport: StdioTransportConstructor }> {
  return import(`${MCP_PKG}/server/stdio.js`) as Promise<{ StdioServerTransport: StdioTransportConstructor }>;
}

export async function runMcpServerCli(options: RunMcpServerCliOptions = {}): Promise<void> {
  const cwd = options.cwd ?? (() => process.cwd());
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const onSignal = options.onSignal ?? ((signal, listener) => process.on(signal, listener));
  const now = options.now ?? (() => Date.now());
  const startInterval = options.setInterval ?? setInterval;
  const stopInterval = options.clearInterval ?? clearInterval;
  const isOrphaned = options.isOrphaned ?? createDefaultIsOrphaned(process.ppid);
  const cleanupStepTimeoutMs = options.cleanupStepTimeoutMs ?? CLEANUP_STEP_TIMEOUT_MS;
  const loadEnv = options.loadStoredCredentialEnvKeys ?? loadStoredCredentialEnvKeys;
  const registerInstance = options.registerMcpInstance ?? registerMcpInstance;
  const sweepOrphans = options.sweepProjectOrphanMcpServers ?? sweepProjectOrphanMcpServers;
  const unregisterInstance = options.unregisterMcpInstance ?? unregisterMcpInstance;
  const createSessionManager = options.createSessionManager ?? (() => new SessionManager());
  const createServer = options.createMcpServer ?? (
    async (manager: SessionManagerLike) => createMcpServer(manager as SessionManager)
  );
  const importTransport = options.importStdioServerTransport ?? importDefaultStdioServerTransport;
  const warmBridges = options.warmWorkflowToolBridges ?? warmWorkflowToolBridges;

  loadEnv();

  const projectDir = env.GSD_WORKFLOW_PROJECT_ROOT || cwd();
  const probeSession = isMcpProbeSession(env);
  let registered = false;
  let cleaningUp = false;
  let idleWatchdog: ReturnType<typeof setInterval> | undefined;
  let trackedStdin: ActivityTrackingInput | undefined;
  let sessionManager: SessionManagerLike | undefined;
  let server: McpServerLike | undefined;

  async function runCleanupStep(label: string, step: () => Promise<void> | void): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(step),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            stderr.write(`[gsd-mcp-server] Cleanup step timed out: ${label}\n`);
            resolve();
          }, cleanupStepTimeoutMs);
          timeout.unref();
        }),
      ]);
    } catch {
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function stopRuntime(): Promise<void> {
    if (idleWatchdog) stopInterval(idleWatchdog);
    trackedStdin?.close();
    if (registered) unregisterInstance(projectDir);
    await runCleanupStep('session manager cleanup', () => sessionManager?.cleanup());
    await runCleanupStep('server close', () => server?.close());
  }

  async function cleanup(code = 0): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    stderr.write('[gsd-mcp-server] Shutting down...\n');
    await stopRuntime();
    exit(code);
  }

  onSignal('SIGTERM', () => void cleanup());
  onSignal('SIGINT', () => void cleanup());
  stdin.once('end', () => void cleanup());
  stdin.once('close', () => void cleanup());
  stdin.once('error', () => void cleanup(1));

  try {
    if (!probeSession) {
      sweepOrphans(projectDir);
      if (registerInstance(projectDir) === false) {
        throw new Error('refusing to start: existing MCP server PID could not be verified');
      }
      registered = true;
    }

    sessionManager = createSessionManager();
    ({ server } = await createServer(sessionManager));

    const { StdioServerTransport } = await importTransport();
    trackedStdin = createActivityTrackingInput(stdin, now);
    const transport = new StdioServerTransport(trackedStdin.input, stdout);

    idleWatchdog = startInterval(() => {
      if (trackedStdin && now() - trackedStdin.lastActivityAt() > STDIN_IDLE_TIMEOUT_MS && isOrphaned()) {
        stderr.write(
          `[gsd-mcp-server] Idle stdin watchdog: no activity for ${STDIN_IDLE_TIMEOUT_MS / 1000}s and parent process is gone, shutting down\n`,
        );
        void cleanup();
      }
    }, STDIN_IDLE_CHECK_INTERVAL_MS);
    idleWatchdog.unref();

    // Fail closed (ADR-036): warm the executor / write-gate bridges BEFORE
    // connecting the transport. If a bridge is broken we must not advertise the
    // workflow tool surface — a rejection here propagates to the catch below so
    // startup aborts and the client never sees tools that would error on first
    // call. A healthy warm-up pre-pays the bridge import so the first real tool
    // call stays fast.
    await warmBridges();
    stderr.write('[gsd-mcp-server] workflow bridges ready\n');

    await server.connect(transport);
    stderr.write('[gsd-mcp-server] MCP server started on stdio\n');
  } catch (err) {
    stderr.write(
      `[gsd-mcp-server] Fatal: failed to start — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await cleanup(1);
  }
}
