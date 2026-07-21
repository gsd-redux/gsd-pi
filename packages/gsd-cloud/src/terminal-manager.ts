// Project/App: gsd-pi
// File Purpose: PTY lifecycle manager for cloud terminal sessions (D-04-01, D-04-02, D-04-03, D-04-09, D-04-12).

import { encodeBinaryFrame } from "./binary-frame.js";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

/** 5 minutes before an unattached PTY is killed (D-04-02). */
const DISCONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum ring buffer size for replay on reconnect (256 KB per RESEARCH.md). */
const MAX_BUFFER_BYTES = 256 * 1024;

/** Grace period after PTY exits before session object is cleared (allows brief replay). */
const EXIT_CLEANUP_MS = 30_000;

/**
 * Minimal interface for the node-pty IPty object.
 * Using a structural type avoids importing node-pty at the module level
 * (it is a native addon, loaded dynamically).
 */
interface IPty {
  pid: number;
  onData: (callback: (data: string) => void) => { dispose(): void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalSession {
  pty: IPty;
  sessionId: string;
  /** Channel for binary PTY I/O: "terminal:{sessionId}". */
  channel: `terminal:${string}`;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  exitCleanupTimer: ReturnType<typeof setTimeout> | null;
  outputBuffer: Buffer[];
  bufferBytes: number;
  alive: boolean;
  /** Disposables returned by pty.onData / pty.onExit. */
  disposables: Array<{ dispose(): void }>;
}

/** Callback to send a binary WebSocket frame (PTY output). */
export type SendBinaryFn = (frame: Buffer) => void;

/** Callback to send a JSON control message. */
export type SendJsonFn = (message: object) => void;

export function ensureNodePtySpawnHelperExecutable(packageRoot?: string): void {
  if (process.platform === "win32") return;

  // Resolve node-pty lazily, after the win32 early-return, so a missing addon
  // never throws during default-argument evaluation. On Windows this function
  // no-ops without touching node-pty; elsewhere, if node-pty is not installed
  // there is no helper to repair and the dynamic import in startSession()
  // surfaces the actionable "not installed" error instead.
  let root = packageRoot;
  if (root === undefined) {
    try {
      root = dirname(nodeRequire.resolve("node-pty/package.json"));
    } catch {
      return;
    }
  }

  const helperPaths = [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ];

  for (const helperPath of helperPaths) {
    if (!existsSync(helperPath)) continue;
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) chmodSync(helperPath, mode | 0o111);
  }
}

/**
 * Manages a single PTY terminal session per device (D-04-03).
 *
 * Responsibilities:
 * - Spawn user's login shell via node-pty (D-04-01)
 * - Send PTY output as binary frames with channel header (D-04-09)
 * - Handle resize propagation (D-04-12)
 * - Persist PTY for 5 minutes on browser disconnect with ring-buffer replay (D-04-02)
 * - Enforce 1 session per device limit (D-04-03)
 */
export class TerminalManager {
  private session: TerminalSession | null = null;

  constructor(
    private readonly sendBinary: SendBinaryFn,
    private readonly sendJson: SendJsonFn,
  ) {}

  /**
   * Starts a new PTY terminal session. Rejects if an active session already exists (D-04-03).
   * Uses dynamic import for node-pty since it is a native addon.
   */
  async startSession(sessionId: string, cols: number, rows: number): Promise<void> {
    if (this.session?.alive) {
      this.sendJson({
        channel: "control",
        type: "terminal.error",
        sessionId,
        error: "A terminal session is already active on this device (limit: 1 per device)",
      });
      return;
    }

    // Clean up any leftover stopped session before starting a new one.
    if (this.session) {
      this.cleanupSession();
    }

    // Pick a platform-appropriate login shell: SHELL is unset on Windows and
    // "/bin/sh" does not exist there, so a win32 spawn would fail with ENOENT.
    const isWindows = process.platform === "win32";
    const shell = isWindows
      ? process.env.COMSPEC || "powershell.exe"
      : process.env.SHELL || "/bin/sh";
    const channel: `terminal:${string}` = `terminal:${sessionId}`;

    // sessionId is gateway-supplied and forms the binary channel name. If it
    // exceeds 255 UTF-8 bytes, encodeBinaryFrame would throw on the first PTY
    // output and crash the runtime, so reject up front before spawning.
    if (Buffer.byteLength(channel, "utf8") > 255) {
      this.sendJson({
        channel: "control",
        type: "terminal.error",
        sessionId,
        error: "Terminal session id is too long (channel name exceeds 255 bytes)",
      });
      return;
    }

    try {
      ensureNodePtySpawnHelperExecutable();
    } catch (err) {
      this.sendJson({
        channel: "control",
        type: "terminal.error",
        sessionId,
        error: `Failed to prepare node-pty: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let ptyModule: { spawn: (file: string, args: string[], options: Record<string, unknown>) => IPty };
    try {
      ptyModule = await import("node-pty") as typeof ptyModule;
    } catch (err) {
      this.sendJson({
        channel: "control",
        type: "terminal.error",
        sessionId,
        error: `Failed to load node-pty: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let pty: IPty;
    try {
      pty = ptyModule.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        // HOME is typically unset on Windows and "/" is not a valid win32 cwd,
        // so prefer USERPROFILE there and fall back to the process cwd on both
        // platforms rather than a hardcoded root that can fail PTY spawn.
        cwd: (isWindows ? process.env.USERPROFILE : process.env.HOME) || process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      this.sendJson({
        channel: "control",
        type: "terminal.error",
        sessionId,
        error: `Failed to spawn shell: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const session: TerminalSession = {
      pty,
      sessionId,
      channel,
      disconnectTimer: null,
      exitCleanupTimer: null,
      outputBuffer: [],
      bufferBytes: 0,
      alive: true,
      disposables: [],
    };
    this.session = session;

    // PTY data -> binary frame -> WebSocket + ring buffer
    const dataDisposable = pty.onData((data: string) => {
      const buf = Buffer.from(data, "utf8");
      const frame = encodeBinaryFrame(channel, buf);
      this.sendBinary(frame);

      // Append to ring buffer for reconnect replay
      session.outputBuffer.push(buf);
      session.bufferBytes += buf.length;
      while (session.bufferBytes > MAX_BUFFER_BYTES && session.outputBuffer.length > 0) {
        const evicted = session.outputBuffer.shift()!;
        session.bufferBytes -= evicted.length;
      }
    });
    session.disposables.push(dataDisposable);

    // PTY exit -> send stopped message, mark dead, schedule cleanup
    const exitDisposable = pty.onExit(({ exitCode }) => {
      session.alive = false;

      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }

      this.sendJson({
        channel: "control",
        type: "terminal.stopped",
        sessionId: session.sessionId,
        exitCode: exitCode ?? null,
      });

      // Allow a brief window for replay before clearing the session object.
      session.exitCleanupTimer = setTimeout(() => {
        if (this.session === session) {
          this.session = null;
        }
      }, EXIT_CLEANUP_MS);
    });
    session.disposables.push(exitDisposable);

    this.sendJson({
      channel: "control",
      type: "terminal.started",
      sessionId,
      pid: pty.pid,
    });
  }

  /**
   * Writes input data from the browser to the PTY stdin.
   */
  write(data: Buffer): void {
    if (this.session?.alive) {
      this.session.pty.write(data.toString("utf8"));
    }
  }

  /**
   * Resizes the PTY (D-04-12). No-op if no active session.
   */
  resize(cols: number, rows: number): void {
    if (this.session?.alive) {
      this.session.pty.resize(cols, rows);
    }
  }

  /**
   * Called when the browser disconnects. Starts the 5-minute persistence timer (D-04-02).
   */
  onBrowserDisconnect(): void {
    if (!this.session?.alive) return;
    // Clear any timer from a prior detach so duplicate/repeated terminal.detached
    // events restart the full 5-minute window instead of letting a stale earlier
    // timer destroy the PTY before the most recent detach's window elapses.
    if (this.session.disconnectTimer) {
      clearTimeout(this.session.disconnectTimer);
      this.session.disconnectTimer = null;
    }
    this.session.disconnectTimer = setTimeout(() => {
      this.destroySession();
    }, DISCONNECT_TIMEOUT_MS);
  }

  /**
   * Called when the browser reconnects within the 5-minute window.
   * Clears the disconnect timer and returns buffered output for replay.
   */
  onBrowserReconnect(): { replayData: Buffer[] } | null {
    if (!this.session) return null;

    if (this.session.disconnectTimer) {
      clearTimeout(this.session.disconnectTimer);
      this.session.disconnectTimer = null;
    }

    return { replayData: [...this.session.outputBuffer] };
  }

  /**
   * Stops (kills) the active terminal session. The onExit handler sends terminal.stopped.
   */
  stopSession(): void {
    if (!this.session) return;
    if (this.session.alive) {
      this.session.pty.kill();
    }
  }

  /**
   * Returns the active session ID, or null if no session is alive.
   */
  getActiveSessionId(): string | null {
    return this.session?.alive ? this.session.sessionId : null;
  }

  /**
   * Disposes of all resources. Called on daemon shutdown.
   */
  dispose(): void {
    this.destroySession();
  }

  /**
   * Force-kills the PTY, clears all timers, and nulls the session. Emits
   * terminal.stopped when the session was still alive, because the onExit
   * handler that normally sends it has been disposed by this point.
   */
  private destroySession(): void {
    if (!this.session) return;
    const session = this.session;
    this.session = null;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }
    if (session.exitCleanupTimer) {
      clearTimeout(session.exitCleanupTimer);
      session.exitCleanupTimer = null;
    }

    for (const d of session.disposables) {
      try { d.dispose(); } catch { /* best-effort cleanup */ }
    }

    if (session.alive) {
      try { session.pty.kill(); } catch { /* best-effort cleanup */ }
      session.alive = false;
      // The onExit handler is disposed above, so a force-destroy (e.g. the
      // 5-minute detach timer firing or daemon shutdown) would otherwise never
      // tell the gateway the session ended, leaving the relay holding the
      // device's single session slot. Notify explicitly here.
      this.sendJson({
        channel: "control",
        type: "terminal.stopped",
        sessionId: session.sessionId,
        exitCode: null,
      });
    }
  }

  /**
   * Cleans up a stopped (non-alive) session without killing the PTY.
   */
  private cleanupSession(): void {
    if (!this.session) return;
    const session = this.session;
    this.session = null;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
    }
    if (session.exitCleanupTimer) {
      clearTimeout(session.exitCleanupTimer);
    }

    for (const d of session.disposables) {
      try { d.dispose(); } catch { /* best-effort cleanup */ }
    }
  }
}
