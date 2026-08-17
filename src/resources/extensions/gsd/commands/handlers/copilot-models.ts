// Project/App: gsd-pi
// File Purpose: /gsd copilot-models — explicit GitHub Copilot model catalog
// drift check, with an opt-in `--register` registration path (Phase H).
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
// Invariants:
//   - Zero network traffic and zero notifications for sessions without a
//     configured GitHub Copilot credential — the check below reuses
//     ctx.modelRegistry.getAvailable(), which already filters providers by
//     isProviderRequestReady(), so no new auth-detection logic is introduced.
//   - Read-only by default: without `--register`, never writes to
//     models.json, models-catalog.json, the model registry, or any provider
//     catalog — only ever produces a notification. With the explicit,
//     opt-in `--register` flag, newly-discovered (`diff.added`) models are
//     additionally merged into the local `models-catalog.json` overlay via
//     `registerCopilotModelsInOverlay()` (`../../copilot-overlay-writer.js`)
//     — the same overlay format/location `gsd update --models` writes.
//     This never mutates `models.json` itself, never touches unrelated
//     providers, and never downgrades an existing overlay entry.
//   - Never overwrites a known-good in-memory snapshot with an empty or
//     partial response (transient API/auth hiccups keep the last good state).
//   - The in-memory "last known good" snapshot and notified-message set are
//     session-scoped only (module-level state) — nothing is persisted to
//     disk (aside from the explicit `--register` overlay write), and neither
//     ever stores the access token, account identity, or request headers.
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
import { registerCopilotModelsInOverlay, resolveGsdModelsCatalogPath } from "../../copilot-overlay-writer.js";
// Read-only cross-reference against the existing static capability-tier
// table (MODEL_CAPABILITY_TIER, defined in model-router.ts and consumed by
// the dynamic-routing decisions in that same file). This never assigns or
// mutates a tier here — a newly discovered model with no entry in that table
// is reported as "no GSD capability profile yet" rather than defaulting to
// any assumed tier. Such a model is not eligible for automatic capability
// routing, but it remains genuinely selectable the same way any other model
// is: a user can add it to their own models.json (ModelRegistry's documented
// custom-model merge behavior). See
// tests/copilot-catalog-manual-selection.test.ts for a behavioral proof of
// that path, independent of this file's own (mocked) handler tests.
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
 * selection (via models.json, see tests/copilot-catalog-manual-selection.test.ts)
 * without implying automatic-routing eligibility.
 */
function describeCapabilityTier(bareModelId: string): string {
  const tier = MODEL_CAPABILITY_TIER[bareModelId];
  return tier
    ? ` (known capability tier: ${tier})`
    : " (no GSD capability profile yet — manual selection only, not auto-routed)";
}

export interface HandleCopilotModelsOptions {
  fetchImpl?: typeof fetch;
  /** Test-only override for the models-catalog.json overlay path used by `--register`. */
  overlayPath?: string;
}

/**
 * `--register` is an explicit, opt-in flag (never automatic on every check).
 * When present, newly-discovered models (`diff.added`) are additionally
 * written into the local `models-catalog.json` overlay via
 * `registerCopilotModelsInOverlay()` (Phase H's first vertical slice) — see
 * `../../copilot-overlay-writer.js`. Without the flag, behavior is unchanged:
 * informational notification only, never a write.
 */
function hasRegisterFlag(args: string): boolean {
  return args.split(/\s+/).includes("--register");
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

  if (hasRegisterFlag(_args) && diff.added.length > 0) {
    const overlayPath = options.overlayPath ?? resolveGsdModelsCatalogPath();
    const { registeredIds } = registerCopilotModelsInOverlay(overlayPath, diff.added);
    for (const id of registeredIds) {
      messages.push(
        `+ ${id} registered into ${overlayPath} — selectable now, capability/pricing fields are placeholders pending a packages/pi-ai generator refresh`,
      );
    }
  }

  const deduped = dedupeShellNotifications(messages);
  const unseen = deduped.filter((message) => !notifiedMessages.has(message));
  for (const message of deduped) notifiedMessages.add(message);

  if (unseen.length === 0) {
    ctx.ui.notify("GitHub Copilot model catalog: no new changes since the last check.", "info");
    return;
  }

  ctx.ui.notify(["GitHub Copilot model catalog changes:", ...unseen].join("\n"), "info");
}
