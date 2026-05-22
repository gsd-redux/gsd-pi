// GSD-2 Web — Shutdown gate: defers process.exit() and drains active SSE streams
/**
 * Shutdown gate — defers process.exit() so that page refreshes (which fire
 * `pagehide` then immediately re-boot) don't kill the server.
 *
 * Flow:
 *   pagehide → POST /api/shutdown → scheduleShutdown() → timer starts
 *   refresh  → GET  /api/boot     → cancelShutdown()   → timer cleared
 *   tab close → timer fires → drains SSE streams → process.exit(0)
 *
 * When GSD_WEB_DAEMON_MODE=1, the server is running as a persistent daemon
 * (e.g. behind a reverse proxy for remote access). In this mode,
 * scheduleShutdown() is a no-op — no client tab should be able to exit the
 * server. The /api/shutdown endpoint still returns { ok: true } so the
 * client beacon doesn't produce a network error.
 *
 * State machine: idle ↔ pending
 *   idle    — no timer running
 *   pending — timer running; shutdownTimer !== null
 *
 * Stuck-shutdown watchdog note:
 *   This module uses a single-state-machine design (idle vs pending). There is
 *   intentionally no hard secondary watchdog timeout — if streams stall, the
 *   existing OS-level SIGKILL from the process manager (e.g. systemd, launchd)
 *   is the backstop. Adding a secondary timer would duplicate that mechanism
 *   and complicate the state machine for minimal gain.
 */

// ── HMR-safe singleton ─────────────────────────────────────────────────────
// Storing state on globalThis prevents Next.js HMR from orphaning timers and
// stream registrations when this module is re-evaluated during development.
declare global {
  // eslint-disable-next-line no-var
  var __gsdShutdownGate:
    | {
        shutdownTimer: ReturnType<typeof setTimeout> | null;
        activeStreams: Set<() => void>;
        lastBootAt: number;
        handlersRegistered: boolean;
      }
    | undefined;
}

if (!globalThis.__gsdShutdownGate) {
  globalThis.__gsdShutdownGate = {
    shutdownTimer: null,
    activeStreams: new Set(),
    lastBootAt: 0,
    handlersRegistered: false,
  };
}

const gate = globalThis.__gsdShutdownGate;
gate.handlersRegistered ??= false;

const SHUTDOWN_DELAY_MS = 3_000;

// ── Drain helper ───────────────────────────────────────────────────────────

export function drainStreams(): void {
  for (const unsubscribe of gate.activeStreams) {
    try {
      unsubscribe();
    } catch {
      // best-effort; never let a bad unsubscriber prevent shutdown
    }
  }
  gate.activeStreams.clear();
}

// ── SIGTERM / beforeExit drain path (idempotent) ───────────────────────────

function handleForcedExit(): void {
  drainStreams();
}

type HotDisposeApi = {
  dispose(callback: () => void): void;
};

type HotModule = {
  hot?: HotDisposeApi;
};

const hotModule =
  (import.meta as ImportMeta & { webpackHot?: HotDisposeApi }).webpackHot ??
  (typeof module === "undefined" ? undefined : (module as HotModule).hot);

if (!gate.handlersRegistered) {
  process.on("SIGTERM", handleForcedExit);
  process.on("beforeExit", handleForcedExit);
  gate.handlersRegistered = true;

  hotModule?.dispose(() => {
    process.off("SIGTERM", handleForcedExit);
    process.off("beforeExit", handleForcedExit);
    gate.handlersRegistered = false;
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true when the server is running in daemon mode.
 * In daemon mode, shutdown requests from browser tabs are ignored.
 */
export function isDaemonMode(): boolean {
  return process.env.GSD_WEB_DAEMON_MODE === "1";
}

/**
 * Register an active SSE stream so the gate can drain it before exit.
 * The supplied `unsubscribe` callback is invoked when the gate drains
 * (either on timer fire or SIGTERM). The caller should use the returned
 * deregister function to remove itself when the stream closes naturally.
 *
 * Returns a deregister function. Call it when the stream closes on its own.
 */
export function registerActiveStream(unsubscribe: () => void): () => void {
  gate.activeStreams.add(unsubscribe);
  return function deregister() {
    gate.activeStreams.delete(unsubscribe);
  };
}

/**
 * Record the current timestamp as the most recent boot. Called by the boot
 * route to prevent a timer that was armed just before a rapid boot from
 * causing a phantom shutdown.
 */
export function recordBoot(): void {
  gate.lastBootAt = Date.now();
}

/**
 * Schedule a graceful process exit after SHUTDOWN_DELAY_MS.
 * If cancelShutdown() is called before the timer fires (e.g. a page refresh
 * triggers a boot request), the exit is aborted.
 *
 * No-op when GSD_WEB_DAEMON_MODE=1 — the server should outlive any
 * individual browser session.
 */
export function scheduleShutdown(): void {
  if (isDaemonMode()) {
    return;
  }

  // Don't stack timers — reset if already scheduled
  if (gate.shutdownTimer !== null) {
    clearTimeout(gate.shutdownTimer);
  }

  gate.shutdownTimer = setTimeout(() => {
    gate.shutdownTimer = null;

    // Boot/shutdown phantom guard: bail if a boot arrived during the delay.
    if (Date.now() - gate.lastBootAt < SHUTDOWN_DELAY_MS) {
      return;
    }

    drainStreams();
    process.exit(0);
  }, SHUTDOWN_DELAY_MS);
}

/**
 * Cancel a pending shutdown. Called by any incoming API request that proves
 * the client is still alive (boot, SSE reconnect, etc.).
 */
export function cancelShutdown(): void {
  if (gate.shutdownTimer !== null) {
    clearTimeout(gate.shutdownTimer);
    gate.shutdownTimer = null;
  }
}

/**
 * Check whether a shutdown is currently pending.
 */
export function isShutdownPending(): boolean {
  return gate.shutdownTimer !== null;
}
