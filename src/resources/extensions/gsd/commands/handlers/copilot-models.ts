// Project/App: gsd-pi
// File Purpose: /gsd copilot-models — explicit, read-only GitHub Copilot
// model catalog drift check.
//
// This is the production wiring for the read-only fetch/sanitize/diff
// pipeline in `../../copilot-model-catalog.js`. It is intentionally NOT part
// of `/gsd doctor` (doctor-providers.ts is documented as "no HTTP calls, no
// network I/O, always sub-10ms" — see runProviderChecks()) and is NOT part of
// the health-widget's periodic background refresh, which must stay fast and
// network-free. This command is a separate, explicitly user-invoked action so
// the only network call it ever makes is one the user asked for, at the
// moment they asked for it.
//
// Invariants (see .plans/github-copilot-model-catalog-sync-execution.md):
//   - Zero network traffic and zero notifications for sessions without a
//     configured GitHub Copilot credential — the check below reuses
//     ctx.modelRegistry.getAvailable(), which already filters providers by
//     isProviderRequestReady(), so no new auth-detection logic is introduced.
//   - Read-only: never writes to models.json, the model registry, or any
//     provider catalog. Only ever produces a notification.
//   - Never overwrites a known-good in-memory snapshot with an empty or
//     partial response (transient API/auth hiccups keep the last good state).
//   - The in-memory "last known good" snapshot and notified-message set are
//     session-scoped only (module-level state) — nothing is persisted to
//     disk, and neither ever stores the access token, account identity, or
//     request headers.
//
// ADR-012 note: the `.provider === "github-copilot"` check below is a
// legitimate transport-identity check (we need to know specifically whether
// Copilot is configured, not which API shape is in play), and this file is
// listed in the `ALLOWED_FILES` allowlist in
// src/tests/provider-equality-allowlist.test.ts accordingly.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { getGitHubCopilotBaseUrl } from "@gsd/pi-ai/oauth";

import {
  applyLastKnownGood,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  type CopilotModelSnapshot,
} from "../../copilot-model-catalog.js";
// Read-only cross-reference against the existing static capability-tier
// table. This never assigns/mutates a tier — a newly discovered model with
// no entry here is reported as "no GSD capability profile yet" rather than
// defaulting to any assumed tier, so it stays manually selectable without
// becoming eligible for automatic routing (see PLAN Phase D/J boundary).
import { MODEL_CAPABILITY_TIER } from "../../model-router.js";

// Session-scoped only — reset on process restart, never written to disk.
let lastKnownGoodSnapshot: CopilotModelSnapshot | null = null;
let notifiedMessages = new Set<string>();

/** Test-only hook to reset module-level session state between test cases. */
export function _resetCopilotModelsSessionStateForTests(): void {
  lastKnownGoodSnapshot = null;
  notifiedMessages = new Set<string>();
}

/**
 * Read-only annotation for a newly discovered model's known GSD capability
 * tier, if any. Never guesses a tier for an unprofiled model — an absent
 * entry is reported explicitly so the model stays visible for manual
 * selection without implying automatic-routing eligibility.
 */
function describeCapabilityTier(bareModelId: string): string {
  const tier = MODEL_CAPABILITY_TIER[bareModelId];
  return tier
    ? ` (known capability tier: ${tier})`
    : " (no GSD capability profile yet — manual selection only, not auto-routed)";
}

export interface HandleCopilotModelsOptions {
  fetchImpl?: typeof fetch;
}

export async function handleCopilotModels(
  _args: string,
  ctx: ExtensionCommandContext,
  options: HandleCopilotModelsOptions = {},
): Promise<void> {
  const available = ctx.modelRegistry.getAvailable();
  const copilotModel = available.find((model) => model.provider === "github-copilot");

  if (!copilotModel) {
    ctx.ui.notify(
      "GitHub Copilot is not configured for this session — run /login to sign in. No network request was made.",
      "info",
    );
    return;
  }

  const token = await ctx.modelRegistry.getApiKey(copilotModel);
  if (!token) {
    ctx.ui.notify(
      "GitHub Copilot is configured but no access token could be resolved — try /login again.",
      "warning",
    );
    return;
  }

  const baseUrl = getGitHubCopilotBaseUrl(token);

  let fetchOutcome: { ok: boolean; error?: string; snapshot: CopilotModelSnapshot | null };
  try {
    const result = await fetchGitHubCopilotModels({
      provider: "github-copilot",
      authToken: token,
      baseUrl,
      fetchImpl: options.fetchImpl,
    });
    const ok = !result.skipped && result.models.length > 0 && !!result.snapshot;
    fetchOutcome = { ok, snapshot: ok ? result.snapshot! : null };
  } catch (err) {
    fetchOutcome = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      snapshot: null,
    };
  }

  if (!lastKnownGoodSnapshot && !fetchOutcome.ok) {
    ctx.ui.notify(
      `GitHub Copilot model catalog unavailable (${fetchOutcome.error ?? "empty response"}) — no cached catalog yet, nothing was changed.`,
      "warning",
    );
    return;
  }

  if (!fetchOutcome.ok) {
    ctx.ui.notify(
      `GitHub Copilot model catalog refresh failed (${fetchOutcome.error ?? "empty response"}) — showing the last known catalog, nothing was changed.`,
      "warning",
    );
    return;
  }

  const previousSnapshot = lastKnownGoodSnapshot;
  const nextSnapshot = previousSnapshot
    ? applyLastKnownGood(previousSnapshot, fetchOutcome)
    : fetchOutcome.snapshot!;
  lastKnownGoodSnapshot = nextSnapshot;

  if (!previousSnapshot) {
    ctx.ui.notify(
      `GitHub Copilot model catalog: ${nextSnapshot.models.length} model(s) available.`,
      "info",
    );
    return;
  }

  const diff = diffCatalogSnapshots(previousSnapshot, nextSnapshot);
  const messages: string[] = [
    ...diff.added.map((model) => `+ ${model.id} added to the GitHub Copilot catalog${describeCapabilityTier(model.id)}`),
    ...diff.removed.map((model) => `- ${model.id} removed from the GitHub Copilot catalog`),
    ...diff.changed.map((model) => `~ ${model.id} changed in the GitHub Copilot catalog`),
  ];

  const deduped = dedupeShellNotifications(messages);
  const unseen = deduped.filter((message) => !notifiedMessages.has(message));
  for (const message of deduped) notifiedMessages.add(message);

  if (unseen.length === 0) {
    ctx.ui.notify("GitHub Copilot model catalog: no new changes since the last check.", "info");
    return;
  }

  ctx.ui.notify(["GitHub Copilot model catalog changes:", ...unseen].join("\n"), "info");
}
