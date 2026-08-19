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
import {
  computeCatalogRegistrationCandidates,
  registerCopilotModelsInOverlay,
  resolveGsdModelsCatalogPath,
} from "../../copilot-overlay-writer.js";
import { lookupModelCost, resolveModelEconomics } from "../../model-cost-table.js";
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
import { getModelProfileConfidence, MODEL_CAPABILITY_TIER } from "../../model-router.js";

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

// Strict parser: only an exact "why" first token is ever recognized as the
// why route ("whywhatever", "why-gpt-5.4" fall through to the normal sync
// path unchanged — see tests for the word-boundary regression this fixes).
function normalizeCommandArgs(args: string): string {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return "sync";
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (firstToken === "why") return "why";
  return "sync";
}

function normalizeBareModelId(modelId: string): string {
  const trimmed = (modelId ?? "").trim();
  if (!trimmed) return "";
  return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
}

interface ParsedWhyArgument {
  target: string;
  valid: boolean;
  kind?: "usage" | "wrong-provider";
  error?: string;
}

function parseWhyArgument(args: string): ParsedWhyArgument {
  const trimmed = (args ?? "").trim();
  // normalizeCommandArgs already guarantees the first token here is "why".
  const rest = trimmed.slice("why".length).trim();
  if (!rest) {
    return {
      target: "",
      valid: false,
      kind: "usage",
      error: "Usage: /gsd copilot-models why <model>",
    };
  }

  // Only the first token is the model ID; anything after it is ignored
  // rather than folded into a bogus multi-word model identifier.
  const rawTarget = rest.split(/\s+/)[0] ?? "";
  const provider = rawTarget.includes("/") ? rawTarget.split("/")[0]?.toLowerCase() : "";
  if (provider && provider !== "github-copilot") {
    return {
      target: rawTarget,
      valid: false,
      kind: "wrong-provider",
      error: `GitHub Copilot only accepts GitHub Copilot model IDs for why; '${rawTarget}' is not a GitHub Copilot model.`,
    };
  }

  return { target: normalizeBareModelId(rawTarget), valid: true };
}

/** Structured, field-by-field result of the local-only `why` registry analysis. */
interface CopilotModelWhyExplanation {
  providerQualifiedId: string;
  bareModelId: string;
  effectiveLocal: boolean;
  sessionAvailable: boolean;
  liveCatalogStatus: "yes" | "no" | "unknown";
  capabilityTier: string;
  profileConfidence: ReturnType<typeof getModelProfileConfidence>;
  economicsKnown: boolean;
  economicsSummary: string;
  economicsSource: string;
  economicsFreshness: string;
  routingEligible: boolean;
  routingReason: string;
  guidance: string;
}

/**
 * Local-only registry analysis for `why <model>`. Never calls
 * ctx.modelRegistry.getApiKey() and never touches fetchImpl — only
 * ctx.modelRegistry.getAll()/getAvailable() and the in-memory
 * last-known-good snapshot are consulted.
 */
function buildModelWhyExplanation(
  bareId: string,
  ctx: ExtensionCommandContext,
  snapshot: CopilotModelSnapshot | null,
): CopilotModelWhyExplanation {
  const providerQualifiedId = `github-copilot/${bareId}`;

  // Scoped to provider === "github-copilot" so a bare ID that only exists
  // under a different provider is never treated as a match (ADR-012).
  const localCopilotModels = ctx.modelRegistry.getAll().filter((model) => model.provider === "github-copilot");
  const availableCopilotModels = ctx.modelRegistry.getAvailable().filter((model) => model.provider === "github-copilot");

  const effectiveLocal = localCopilotModels.some((model) => normalizeBareModelId(model.id) === bareId);
  const sessionAvailable = availableCopilotModels.some((model) => normalizeBareModelId(model.id) === bareId);

  const liveCatalogStatus: "yes" | "no" | "unknown" = !snapshot
    ? "unknown"
    : snapshot.models.some((model) => normalizeBareModelId(model.id) === bareId)
      ? "yes"
      : "no";

  const tier = MODEL_CAPABILITY_TIER[bareId];
  const confidence = getModelProfileConfidence(bareId);

  const bundledCost = lookupModelCost(bareId);
  const economics = resolveModelEconomics({
    provider: "github-copilot",
    modelId: bareId,
    // resolveModelEconomics only reports a non-"unknown" source when at
    // least one economics input was supplied; the why route has no
    // live/user/static economics available, so we explicitly surface the
    // bundled cost table entry (when one exists) as the fallback input.
    fallbackEconomics: bundledCost ? { modelId: bareId } : undefined,
  });
  const economicsKnown = economics.source !== "unknown" && !!economics.tokenPrices?.default;
  const economicsSummary = economicsKnown
    ? `$${Number(economics.tokenPrices!.default.inputPer1k).toFixed(4)} per 1K input / $${Number(economics.tokenPrices!.default.outputPer1k).toFixed(4)} per 1K output`
    : "unknown";
  const economicsSource = economicsKnown ? economics.source : "unknown";
  const economicsFreshness = economicsKnown ? (economics.stale ? "stale" : "fresh") : "unknown";

  let routingEligible = false;
  let routingReason: string;
  let guidance: string;

  if (!effectiveLocal) {
    if (liveCatalogStatus === "yes") {
      routingReason = "remote-only and quarantined";
      guidance = "Remote-only live catalog entry — quarantined and kept out of the effective local catalog; use --register to review, never auto-routed.";
    } else {
      routingReason = "not in effective local catalog";
      guidance = "Not present in the effective local catalog — add it to models.json for manual selection.";
    }
  } else if (!sessionAvailable) {
    routingReason = "unavailable in this session";
    guidance = "Present in the effective local catalog but not available in this session — check provider configuration/credentials.";
  } else if (!tier || confidence === "unknown") {
    routingReason = "capability profile unknown";
    guidance = "No GSD capability profile yet — manual selection only, not auto-routed.";
  } else {
    routingEligible = true;
    routingReason = "profiled and available for automatic routing";
    guidance = "Available for manual selection and eligible for automatic routing.";
  }

  return {
    providerQualifiedId,
    bareModelId: bareId,
    effectiveLocal,
    sessionAvailable,
    liveCatalogStatus,
    capabilityTier: tier ?? "unknown",
    profileConfidence: confidence,
    economicsKnown,
    economicsSummary,
    economicsSource,
    economicsFreshness,
    routingEligible,
    routingReason,
    guidance,
  };
}

function formatModelWhyExplanation(explanation: CopilotModelWhyExplanation): string {
  return [
    `GitHub Copilot: why ${explanation.providerQualifiedId}`,
    `- identity: ${explanation.providerQualifiedId}`,
    `- effective local: ${explanation.effectiveLocal ? "yes" : "no"}`,
    `- session available: ${explanation.sessionAvailable ? "yes" : "no"}`,
    `- last known live catalog: ${explanation.liveCatalogStatus}`,
    `- capability tier: ${explanation.capabilityTier}`,
    `- profile confidence: ${explanation.profileConfidence}`,
    `- economics: ${explanation.economicsSummary}`,
    `- source: ${explanation.economicsSource}`,
    `- freshness: ${explanation.economicsFreshness}`,
    `- automatic routing eligible: ${explanation.routingEligible ? "yes" : "no"}`,
    `- reason: ${explanation.routingReason}`,
    `- guidance: ${explanation.guidance}`,
  ].join("\n");
}

export async function handleCopilotModels(
  _args: string,
  ctx: ExtensionCommandContext,
  options: HandleCopilotModelsOptions = {},
): Promise<void> {
  const command = normalizeCommandArgs(_args);

  if (command === "why") {
    const parsed = parseWhyArgument(_args);
    if (!parsed.valid) {
      if (parsed.kind === "usage") {
        ctx.ui.notify(parsed.error ?? "Usage: /gsd copilot-models why <model>", "warning");
      } else {
        ctx.ui.notify(`GitHub Copilot: why request rejected — ${parsed.error ?? "unknown error"}`, "warning");
      }
      return;
    }

    // Local-only: never resolves an API key and never calls fetchImpl.
    const explanation = buildModelWhyExplanation(parsed.target, ctx, lastKnownGoodSnapshot);
    ctx.ui.notify(formatModelWhyExplanation(explanation), "info");
    return;
  }

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
    const effectiveLocalModels = ctx.modelRegistry.getAll().filter((model) => model.provider === "github-copilot");
    const candidates = computeCatalogRegistrationCandidates(diff.added, effectiveLocalModels);

    if (candidates.length === 0) {
      messages.push(
        "GitHub Copilot registration: no remote-only models were found; the effective local catalog already covers the live catalog.",
      );
    } else {
      const { quarantined } = registerCopilotModelsInOverlay(overlayPath, diff.added, effectiveLocalModels);
      for (const model of quarantined) {
        messages.push(
          `+ ${model.id} quarantined in ${overlayPath} — remote-only live catalog entry kept out of the effective local catalog because its metadata is incomplete and not persisted as concrete truth.`,
        );
      }
      messages.push(
        "Remote-only live catalog entries were kept quarantined because the effective local catalog is authoritative and unknown metadata must never be materialized as concrete truth.",
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
