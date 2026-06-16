// Project/App: gsd-pi
// File Purpose: Always-on ambient health signal rendered below the editor.

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { runProviderChecks, summariseProviderIssues } from "./doctor-providers.js";
import { runEnvironmentChecks, runEnvironmentChecksAsync } from "./doctor-environment.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { nativeIsRepo, nativeLastCommitEpoch, nativeGetCurrentBranch, nativeCommitSubject } from "./native-git-bridge.js";
import { loadLedgerFromDisk, getProjectTotals } from "./metrics.js";
import { describeNextUnit, estimateTimeRemaining, updateSliceProgressCache } from "./auto-dashboard.js";
import { projectRoot } from "./commands/context.js";
import { deriveState, invalidateStateCache } from "./state.js";
import {
  buildHealthLines,
  detectHealthWidgetProjectState,
  type HealthWidgetData,
} from "./health-widget-core.js";

export const HEALTH_WIDGET_ACTIVE_HINTS =
  "  /gsd auto to run  ·  /gsd status to inspect  ·  /gsd report for snapshots  ·  /gsd notifications for history  ·  /gsd help";

// ── Data loader ────────────────────────────────────────────────────────────────

// Last-commit lookup is subprocess-backed (native-git-bridge → git spawns),
// so it is treated like the other expensive checks: skipped on first paint,
// run only by the background refresh.
function loadLastCommitInfo(basePath: string): { epoch: number | null; message: string | null } {
  try {
    if (nativeIsRepo(basePath)) {
      const branch = nativeGetCurrentBranch(basePath);
      const epoch = nativeLastCommitEpoch(basePath, branch || "HEAD");
      if (epoch > 0) {
        return { epoch, message: nativeCommitSubject(basePath, branch || "HEAD") || null };
      }
    }
  } catch { /* non-fatal */ }
  return { epoch: null, message: null };
}

function loadHealthWidgetData(
  basePath: string,
  options?: { includeChecks?: boolean },
): HealthWidgetData {
  // `includeChecks` gates the expensive subprocess-backed checks (provider +
  // environment doctor: `lsof`, `docker`, `node --version`, ...). The initial
  // synchronous render passes `false` so first paint is never blocked on them;
  // the async refresh (off the first-paint path) runs the full suite.
  const includeChecks = options?.includeChecks ?? true;
  let budgetCeiling: number | undefined;
  let budgetSpent = 0;
  let providerIssue: string | null = null;
  let environmentErrorCount = 0;
  let environmentWarningCount = 0;
  let lastCommitEpoch: number | null = null;
  let lastCommitMessage: string | null = null;

  const projectState = detectHealthWidgetProjectState(basePath);

  try {
    const prefs = loadEffectiveGSDPreferences();
    budgetCeiling = prefs?.preferences?.budget_ceiling;

    const ledger = loadLedgerFromDisk(basePath);
    if (ledger) {
      const totals = getProjectTotals(ledger.units ?? []);
      budgetSpent = totals.cost;
    }
  } catch { /* non-fatal */ }

  if (includeChecks) {
    try {
      const providerResults = runProviderChecks();
      providerIssue = summariseProviderIssues(providerResults);
    } catch { /* non-fatal */ }

    try {
      const envResults = runEnvironmentChecks(basePath);
      for (const r of envResults) {
        if (r.status === "error") environmentErrorCount++;
        else if (r.status === "warning") environmentWarningCount++;
      }
    } catch { /* non-fatal */ }
  }

  // ── Last commit info ── (git spawns — gated like the other expensive checks)
  if (includeChecks) {
    const commit = loadLastCommitInfo(basePath);
    lastCommitEpoch = commit.epoch;
    lastCommitMessage = commit.message;
  }

  return {
    projectState,
    budgetCeiling,
    budgetSpent,
    providerIssue,
    environmentErrorCount,
    environmentWarningCount,
    lastCommitEpoch,
    lastCommitMessage,
    lastRefreshed: Date.now(),
  };
}

// Non-blocking variant used by the widget's background refresh: the cheap fields
// come from the synchronous snapshot, then provider + environment checks are
// layered in off the event-loop critical path (env checks run concurrently via
// runEnvironmentChecksAsync). Keeps the always-on widget from stalling the UI on
// its initial enrichment or its 60s refresh.
async function loadHealthWidgetDataAsync(basePath: string): Promise<HealthWidgetData> {
  const data = loadHealthWidgetData(basePath, { includeChecks: false });
  let providerIssue = data.providerIssue;
  let environmentErrorCount = 0;
  let environmentWarningCount = 0;

  try {
    providerIssue = summariseProviderIssues(runProviderChecks());
  } catch { /* non-fatal */ }

  try {
    const envResults = await runEnvironmentChecksAsync(basePath);
    for (const r of envResults) {
      if (r.status === "error") environmentErrorCount++;
      else if (r.status === "warning") environmentWarningCount++;
    }
  } catch { /* non-fatal */ }

  const commit = loadLastCommitInfo(basePath);

  return {
    ...data,
    providerIssue,
    environmentErrorCount,
    environmentWarningCount,
    lastCommitEpoch: commit.epoch,
    lastCommitMessage: commit.message,
    lastRefreshed: Date.now(),
  };
}

// ── Widget init ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Initialize the always-on gsd-health widget (belowEditor).
 * Call once from the extension entry point after context is available.
 */
export function initHealthWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const basePath = projectRoot();

  // String-array fallback — used in RPC mode (factory is a no-op there).
  // Skip the expensive provider/environment doctor checks here: this runs
  // synchronously on the interactive-startup path, where running them would
  // block first paint by ~0.9s (lsof/docker probes, otherwise run again
  // immediately by the factory below). The factory's async refresh fills in
  // real health once the screen is up.
  const initialData = loadHealthWidgetData(basePath, { includeChecks: false });
  ctx.ui.setWidget("gsd-health", buildHealthLines(initialData), { placement: "belowEditor" });

  // Factory-based widget for TUI mode — replaces the string-array above
  ctx.ui.setWidget("gsd-health", (_tui, _theme) => {
    let data = initialData;
    let cachedLines: string[] | undefined;
    let refreshInFlight = false;
    let isDisposed = false;

    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        data = await loadHealthWidgetDataAsync(basePath);
        cachedLines = undefined;
        if (!isDisposed) _tui.requestRender();
      } catch { /* non-fatal */ } finally {
        refreshInFlight = false;
      }
    };

    // Fire the first full enrichment off the first-paint path. setTimeout(0)
    // yields to the initial render + input loop, so the expensive doctor checks
    // (provider + environment) never delay the moment the user sees the UI.
    // requestRender() inside refresh repaints the widget once data is ready.
    setTimeout(() => { void refresh(); }, 0);

    const refreshTimer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    let cachedWidth: number | undefined;
    return {
      render(width: number): string[] {
        if (!cachedLines || cachedWidth !== width) {
          cachedLines = buildHealthLines(data, width);
          if (data.projectState === "active") {
            cachedLines = [...cachedLines, _theme.fg("dim", HEALTH_WIDGET_ACTIVE_HINTS)];
          }
          cachedWidth = width;
        }
        return cachedLines;
      },
      invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
      dispose(): void {
        isDisposed = true;
        clearInterval(refreshTimer);
      },
    };
  }, { placement: "belowEditor" });
}
