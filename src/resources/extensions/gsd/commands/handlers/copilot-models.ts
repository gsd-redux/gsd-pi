// Project/App: gsd-pi
// File Purpose: /gsd copilot-models — explicit GitHub Copilot model catalog
// sync, diff, diagnostics, pricing, promotions, and local-only why analysis.

import { createHash } from "node:crypto";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { getGitHubCopilotBaseUrl } from "@gsd/pi-ai/oauth";

import {
  CopilotCatalogFetchError,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  findStaticCopilotModel,
  isSuspiciousCatalogShrink,
  type CopilotModelRecord,
  type CopilotModelSnapshot,
} from "../../copilot-model-catalog.js";
import {
  computeCatalogRegistrationCandidates,
  registerCopilotModelsInOverlay,
  resolveGsdModelsCatalogPath,
  type CatalogRegistrationCandidate,
} from "../../copilot-overlay-writer.js";
import { resolveModelEconomics, type RuntimeModelEconomics } from "../../model-cost-table.js";
import { getModelProfileConfidence, MODEL_CAPABILITY_TIER } from "../../model-router.js";

interface CopilotCatalogDiffState {
  firstAccepted: boolean;
  generatedAt: string;
  added: CopilotModelRecord[];
  removed: CopilotModelRecord[];
  changed: CopilotModelRecord[];
  candidates: CatalogRegistrationCandidate[];
  registeredIds: string[];
}

interface CopilotRefreshState {
  attemptedAt: string;
  status: "success" | "failed" | "suspicious";
  failureKind?: string;
  failureMessage?: string;
}

interface CopilotSessionState {
  lastKnownGoodSnapshot: CopilotModelSnapshot | null;
  lastAcceptedDiff: CopilotCatalogDiffState | null;
  lastRefresh: CopilotRefreshState | null;
}

export interface HandleCopilotModelsOptions {
  fetchImpl?: typeof fetch;
  /** Test-only override for the models-catalog.json overlay path used by `--register`. */
  overlayPath?: string;
}

let sessionStates = new Map<string, CopilotSessionState>();
let notifiedMessagesByAccount = new Map<string, Set<string>>();
let lastActiveAccountKey: string | null = null;

/** Test-only hook to reset module-level session state between test cases. */
export function _resetCopilotModelsSessionStateForTests(): void {
  sessionStates = new Map();
  notifiedMessagesByAccount = new Map();
  lastActiveAccountKey = null;
}

function normalizeBareModelId(modelId: string): string {
  const trimmed = (modelId ?? "").trim();
  if (!trimmed) return "";
  return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
}

function hasRegisterFlag(args: string): boolean {
  return (args ?? "").split(/\s+/).includes("--register");
}

type CopilotModelsCommand = "sync" | "changes" | "pricing" | "promos" | "doctor" | "why";

function parseCommand(args: string): CopilotModelsCommand {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return "sync";
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (firstToken === "sync") return "sync";
  if (firstToken === "changes") return "changes";
  if (firstToken === "pricing") return "pricing";
  if (firstToken === "promos") return "promos";
  if (firstToken === "doctor") return "doctor";
  if (firstToken === "why") return "why";
  return "sync";
}

interface ParsedModelArgument {
  target?: string;
  valid: boolean;
  error?: string;
}

function parseProviderModelArgument(prefix: string, args: string, required: boolean): ParsedModelArgument {
  const trimmed = (args ?? "").trim();
  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) {
    return required
      ? { valid: false, error: `Usage: /gsd copilot-models ${prefix} <model>` }
      : { valid: true };
  }
  const rawTarget = rest.split(/\s+/)[0] ?? "";
  const provider = rawTarget.includes("/") ? rawTarget.split("/")[0]?.toLowerCase() : "";
  if (provider && provider !== "github-copilot") {
    return {
      valid: false,
      error: `GitHub Copilot only accepts GitHub Copilot model IDs for ${prefix}; '${rawTarget}' is not a GitHub Copilot model.`,
    };
  }
  return { valid: true, target: normalizeBareModelId(rawTarget) };
}

function hashAccountKey(baseUrl: string, token: string): string {
  return createHash("sha256").update(`${baseUrl}\n${token}`).digest("hex");
}

/**
 * Derive a per-account key from the STABLE part of the stored credential (the
 * OAuth refresh token, or a plain API key) instead of the short-lived Copilot
 * access token. GitHub Copilot OAuth refresh replaces `access` on every
 * renewal, so hashing it would silently drop this account's cached
 * snapshot/diff/notification state each time the token rotates.
 * Synchronous and network-free — safe to call from local-only commands.
 * Always returns a key: auth configured via an environment variable or a
 * models.json provider key has no entry in authStorage at all, but those
 * modes represent a single stable configuration with no account-switching
 * concept, so they get a fixed key rather than forcing every local-only
 * command to miss the state runSync just recorded.
 */
function resolveCopilotAccountKey(ctx: ExtensionCommandContext, provider: string): string {
  const cred = ctx.modelRegistry.authStorage.get(provider) as
    | { type: "oauth"; refresh: string; enterpriseUrl?: string }
    | { type: "api_key"; key: string }
    | undefined;
  if (cred?.type === "oauth") {
    return hashAccountKey(cred.enterpriseUrl ?? "github.com", cred.refresh);
  }
  if (cred?.type === "api_key") {
    return hashAccountKey("github.com", cred.key);
  }
  return hashAccountKey("github.com", `unstored-credential:${provider}`);
}

function redactSensitive(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/gh[opusr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/[A-Za-z0-9+/=_-]{30,}/g, "[redacted]");
}

function getSessionState(accountKey: string): CopilotSessionState {
  const current = sessionStates.get(accountKey);
  if (current) return current;
  const created: CopilotSessionState = {
    lastKnownGoodSnapshot: null,
    lastAcceptedDiff: null,
    lastRefresh: null,
  };
  sessionStates.set(accountKey, created);
  return created;
}

function getNotificationState(accountKey: string): Set<string> {
  const current = notifiedMessagesByAccount.get(accountKey);
  if (current) return current;
  const created = new Set<string>();
  notifiedMessagesByAccount.set(accountKey, created);
  return created;
}

function activeSnapshot(): CopilotModelSnapshot | null {
  if (!lastActiveAccountKey) return null;
  return sessionStates.get(lastActiveAccountKey)?.lastKnownGoodSnapshot ?? null;
}

function activeDiff(): CopilotCatalogDiffState | null {
  if (!lastActiveAccountKey) return null;
  return sessionStates.get(lastActiveAccountKey)?.lastAcceptedDiff ?? null;
}

function activeRefresh(): CopilotRefreshState | null {
  if (!lastActiveAccountKey) return null;
  return sessionStates.get(lastActiveAccountKey)?.lastRefresh ?? null;
}

/**
 * Resolve the CURRENT account's cached session state without resolving or
 * refreshing the bearer token — `changes`, `pricing`, `promos`, `doctor`, and
 * `why` are documented as local-only/no-network, but the OAuth token resolver
 * this used to call through can itself issue a network refresh request when
 * the access token is expired. `hasConfiguredAuth`/`resolveCopilotAccountKey`
 * read stored credential state directly instead.
 */
async function resolveCurrentAccountView(ctx: ExtensionCommandContext): Promise<{
  auth: { configured: boolean; tokenAvailable: boolean };
  accountKey: string | null;
  state: CopilotSessionState | null;
}> {
  const available = ctx.modelRegistry.getAvailable();
  const copilotModel = available.find((model) => model.provider === "github-copilot");
  if (!copilotModel) {
    return { auth: { configured: false, tokenAvailable: false }, accountKey: null, state: null };
  }

  const accountKey = resolveCopilotAccountKey(ctx, copilotModel.provider);
  return {
    auth: { configured: true, tokenAvailable: ctx.modelRegistry.hasConfiguredAuth(copilotModel) },
    accountKey,
    state: sessionStates.get(accountKey) ?? null,
  };
}

function localCopilotModels(ctx: ExtensionCommandContext): any[] {
  const getAll = (ctx.modelRegistry as { getAll?: () => any[] }).getAll;
  const all = typeof getAll === "function" ? getAll() : ctx.modelRegistry.getAvailable();
  return all.filter((model) => model.provider === "github-copilot");
}

async function resolveCopilotAuth(ctx: ExtensionCommandContext): Promise<{
  configured: boolean;
  tokenAvailable: boolean;
  copilotModel?: any;
  token?: string;
  baseUrl?: string;
  accountKey?: string;
  error?: string;
}> {
  const available = ctx.modelRegistry.getAvailable();
  const copilotModel = available.find((model) => model.provider === "github-copilot");
  if (!copilotModel) {
    return { configured: false, tokenAvailable: false };
  }

  const stableAccountKey = resolveCopilotAccountKey(ctx, copilotModel.provider);

  try {
    const token = await ctx.modelRegistry.getApiKey(copilotModel);
    if (!token) {
      return {
        configured: true,
        tokenAvailable: false,
        copilotModel,
        accountKey: stableAccountKey,
      };
    }

    const baseUrl = getGitHubCopilotBaseUrl(token);
    return {
      configured: true,
      tokenAvailable: true,
      copilotModel,
      token,
      baseUrl,
      accountKey: stableAccountKey,
    };
  } catch (error) {
    return {
      configured: true,
      tokenAvailable: false,
      copilotModel,
      accountKey: stableAccountKey,
      error: redactSensitive(error instanceof Error ? error.message : String(error)),
    };
  }
}

function describeCapabilityTier(bareModelId: string): string {
  const tier = MODEL_CAPABILITY_TIER[bareModelId];
  return tier
    ? `known capability tier: ${tier}`
    : "no GSD capability profile yet — manual selection only, not auto-routed";
}

function buildLiveEconomics(record: CopilotModelRecord): Partial<RuntimeModelEconomics> | undefined {
  const longContextTiers = record.billing.longContextTiers
    ?.filter(
      (tier): tier is typeof tier & { inputPer1k: number; outputPer1k: number } =>
        typeof tier.inputPer1k === "number" && typeof tier.outputPer1k === "number",
    )
    .map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      inputPer1k: tier.inputPer1k,
      outputPer1k: tier.outputPer1k,
      ...(tier.cacheReadPer1k !== undefined ? { cachedInputPer1k: tier.cacheReadPer1k } : {}),
      ...(tier.cacheWritePer1k !== undefined ? { cachedOutputPer1k: tier.cacheWritePer1k } : {}),
    }));

  if (
    record.billing.inputPer1k === undefined
    && record.billing.outputPer1k === undefined
    && record.billing.cacheReadPer1k === undefined
    && record.billing.cacheWritePer1k === undefined
    && record.billing.requestMultiplier === undefined
    && !record.billing.promotion
  ) {
    return undefined;
  }

  return {
    billingUnit: record.billing.billingUnit,
    stale: false,
    tokenPrices: record.billing.inputPer1k !== undefined && record.billing.outputPer1k !== undefined
      ? {
          default: {
            inputPer1k: record.billing.inputPer1k,
            outputPer1k: record.billing.outputPer1k,
            ...(record.billing.cacheReadPer1k !== undefined ? { cachedInputPer1k: record.billing.cacheReadPer1k } : {}),
            ...(record.billing.cacheWritePer1k !== undefined ? { cachedOutputPer1k: record.billing.cacheWritePer1k } : {}),
          },
          ...(longContextTiers?.length ? { longContextTiers } : {}),
        }
      : undefined,
    ...(record.billing.requestMultiplier !== undefined ? { requestMultiplier: record.billing.requestMultiplier } : {}),
    ...(record.billing.promotion ? { promotion: record.billing.promotion } : {}),
  };
}

function hasMeaningfulCost(cost: any): boolean {
  return !!cost && (
    cost.input > 0
    || cost.output > 0
    || cost.cacheRead > 0
    || cost.cacheWrite > 0
    || (cost.tiers?.length ?? 0) > 0
  );
}

function tokenPricesFromCost(cost: any): RuntimeModelEconomics["tokenPrices"] {
  return {
    default: {
      inputPer1k: cost.input / 1000,
      outputPer1k: cost.output / 1000,
      cachedInputPer1k: cost.cacheRead / 1000,
      cachedOutputPer1k: cost.cacheWrite / 1000,
    },
    ...(cost.tiers?.length
      ? {
          longContextTiers: cost.tiers.map((tier: any) => ({
            inputTokensAbove: tier.inputTokensAbove,
            ...(typeof tier.input === "number" ? { inputPer1k: tier.input / 1000 } : {}),
            ...(typeof tier.output === "number" ? { outputPer1k: tier.output / 1000 } : {}),
            ...(typeof tier.cacheRead === "number" ? { cachedInputPer1k: tier.cacheRead / 1000 } : {}),
            ...(typeof tier.cacheWrite === "number" ? { cachedOutputPer1k: tier.cacheWrite / 1000 } : {}),
          })),
        }
      : {}),
  };
}

/**
 * The effective local model can come from bundled data, the models-catalog.json
 * overlay, or a genuine models.json cost override — ModelRegistry itself already
 * applies bundled < overlay < models.json precedence when building it, so its
 * cost is at least as authoritative as this module's own separate hardcoded
 * static reference list. It is NOT necessarily user-authored, though, so it
 * stays in the same (stale, provider-static) precedence tier as staticModel —
 * just preferred over it when present, rather than always losing to it.
 */
function buildStaticEconomics(modelId: string, localModel?: any): Partial<RuntimeModelEconomics> | undefined {
  const staticModel = findStaticCopilotModel(modelId);
  const cost = hasMeaningfulCost(localModel?.cost) ? localModel.cost : staticModel?.cost;
  if (!cost) return undefined;
  return {
    billingUnit: "tokens",
    stale: true,
    tokenPrices: tokenPricesFromCost(cost),
  };
}

function resolveEconomicsForModel(
  bareId: string,
  liveRecord: CopilotModelRecord | undefined,
  localModel: any | undefined,
): RuntimeModelEconomics {
  return resolveModelEconomics({
    provider: "github-copilot",
    modelId: bareId,
    liveEconomics: liveRecord ? buildLiveEconomics(liveRecord) : undefined,
    staticEconomics: buildStaticEconomics(bareId, localModel),
    // BUNDLED_COST_TABLE's bare-ID lookup isn't provider-qualified; without this,
    // an unmatched github-copilot model can silently report another provider's
    // price for the same bare ID instead of unknown pricing.
    disableImplicitFallback: true,
  });
}

function economicsSummary(economics: RuntimeModelEconomics): string {
  const prices = economics.tokenPrices?.default;
  if (!prices) return "unknown";
  return `$${Number(prices.inputPer1k).toFixed(4)} per 1K input / $${Number(prices.outputPer1k).toFixed(4)} per 1K output`;
}

function economicsSourceSummary(economics: RuntimeModelEconomics): string {
  return `${economics.provenance.defaultTokenPrices?.source ?? economics.source}`;
}

function economicsFreshnessSummary(economics: RuntimeModelEconomics): string {
  return economics.provenance.defaultTokenPrices?.freshness ?? "unknown";
}

function formatPromotion(
  promotion?: {
    discountPercent?: number;
    startsAt?: string;
    endsAt?: string;
    message?: string;
    status?: "active" | "future" | "expired" | "unknown";
  },
): string {
  if (!promotion) return "none";
  const details: string[] = [promotion.status ?? "unknown"];
  if (promotion.discountPercent !== undefined) details.push(`${promotion.discountPercent}%`);
  if (promotion.endsAt) details.push(`ends ${promotion.endsAt}`);
  if (promotion.startsAt) details.push(`starts ${promotion.startsAt}`);
  if (promotion.message) details.push(promotion.message);
  return details.join(" — ");
}

function formatCacheAge(generatedAt?: string): string {
  if (!generatedAt) return "never";
  const ageMs = Date.now() - Date.parse(generatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return generatedAt;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function buildDiffState(
  previousSnapshot: CopilotModelSnapshot | null,
  nextSnapshot: CopilotModelSnapshot,
  candidates: CatalogRegistrationCandidate[],
  registeredIds: string[],
): CopilotCatalogDiffState {
  if (!previousSnapshot) {
    return {
      firstAccepted: true,
      generatedAt: nextSnapshot.generatedAt,
      added: nextSnapshot.models,
      removed: [],
      changed: [],
      candidates,
      registeredIds,
    };
  }

  const diff = diffCatalogSnapshots(previousSnapshot, nextSnapshot);
  return {
    firstAccepted: false,
    generatedAt: nextSnapshot.generatedAt,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    candidates,
    registeredIds,
  };
}

function formatChanges(diff: CopilotCatalogDiffState | null): string {
  if (!diff) {
    return "GitHub Copilot model catalog changes: no accepted sync has been recorded yet.";
  }

  const lines = [
    "GitHub Copilot model catalog changes:",
    `- snapshot accepted at: ${diff.generatedAt}`,
    `- mode: ${diff.firstAccepted ? "first accepted snapshot" : "delta since last accepted snapshot"}`,
  ];

  for (const model of diff.added) {
    lines.push(`+ ${model.registryId} added (${describeCapabilityTier(model.id)})`);
  }
  for (const model of diff.removed) {
    lines.push(`- ${model.registryId} removed`);
  }
  for (const model of diff.changed) {
    lines.push(`~ ${model.registryId} changed`);
  }
  for (const model of diff.candidates.filter((candidate) => !candidate.complete)) {
    lines.push(`! ${model.registryId} quarantined — ${model.blockers.join("; ")}`);
  }
  for (const modelId of diff.registeredIds) {
    lines.push(`= github-copilot/${modelId} registered into the effective local catalog overlay`);
  }

  if (lines.length === 3) {
    lines.push("- no additions, removals, changes, quarantines, or registrations recorded");
  }

  return lines.join("\n");
}

function findLiveRecord(snapshot: CopilotModelSnapshot | null, bareId: string): CopilotModelRecord | undefined {
  return snapshot?.models.find((model) => normalizeBareModelId(model.id) === bareId);
}

function findLocalModel(ctx: ExtensionCommandContext, bareId: string): any | undefined {
  return localCopilotModels(ctx).find((model) => normalizeBareModelId(model.id) === bareId);
}

function buildWhyExplanation(
  bareId: string,
  ctx: ExtensionCommandContext,
  snapshot: CopilotModelSnapshot | null,
): string {
  const localModel = findLocalModel(ctx, bareId);
  const liveRecord = findLiveRecord(snapshot, bareId);
  const effectiveLocal = !!localModel;
  const sessionAvailable = ctx.modelRegistry.getAvailable().some(
    (model) => model.provider === "github-copilot" && normalizeBareModelId(model.id) === bareId,
  );
  const candidate = liveRecord
    ? computeCatalogRegistrationCandidates([liveRecord], localCopilotModels(ctx))[0]
    : undefined;
  const tier = MODEL_CAPABILITY_TIER[bareId] ?? "unknown";
  const confidence = getModelProfileConfidence(bareId);
  const economics = resolveEconomicsForModel(bareId, liveRecord, localModel);

  let routingEligible = false;
  let routingReason = "no live/task routing context available";
  let guidance = "No active task classification context is available here — this is a local model-state explanation only.";

  if (!effectiveLocal) {
    if (candidate?.complete) {
      routingReason = "remote-only complete candidate";
      guidance = "Live catalog metadata is complete enough to register safely — run /gsd copilot-models sync --register to make it selectable locally.";
    } else if (candidate) {
      routingReason = "remote-only and quarantined";
      guidance = `Live catalog metadata is incomplete for safe registration: ${candidate.blockers.join("; ")}`;
    } else {
      routingReason = "not in effective local catalog";
      guidance = "Not present in the effective local catalog — add it explicitly or register it from a live sync when authoritative metadata is available.";
    }
  } else if (!sessionAvailable) {
    routingReason = "unavailable in this session";
    guidance = "The model exists in the effective local catalog but is not available from the configured Copilot session/provider right now.";
  } else if (liveRecord?.availability.policyState === "disabled" || liveRecord?.availability.policyState === "restricted") {
    routingReason = `provider policy is ${liveRecord.availability.policyState}`;
    guidance = "Provider policy currently restricts this model. Automatic routing does not enforce this signal directly today — it only gates on capability-profile confidence — so treat this as a policy warning, not a routing guarantee.";
  } else if (liveRecord?.availability.preview === true) {
    routingReason = "preview models are intended to stay manual-only";
    guidance = "Preview models are intended to remain manually selectable only, but automatic routing does not enforce this directly today — it only gates on capability-profile confidence.";
  } else if (confidence === "unknown") {
    routingReason = "capability profile unknown";
    guidance = "Manual selection is allowed, but automatic routing stays fail-closed until a curated, inherited, or complete provisional capability profile exists.";
  } else {
    routingEligible = true;
    routingReason = "policy, capabilities, registration, and profile checks passed";
    guidance = "This explanation has no active task-routing context; if selected for a task, normal routing still evaluates tier/capability/cost at dispatch time.";
  }

  return [
    `GitHub Copilot: why github-copilot/${bareId}`,
    `- identity: github-copilot/${bareId}`,
    `- effective local: ${effectiveLocal ? "yes" : "no"}`,
    `- session available: ${sessionAvailable ? "yes" : "no"}`,
    `- last known live catalog: ${liveRecord ? "yes" : snapshot ? "no" : "unknown"}`,
    `- registration state: ${candidate ? (candidate.complete ? "complete remote-only candidate" : "quarantined remote-only candidate") : effectiveLocal ? "effective local catalog" : "unknown"}`,
    `- capability tier: ${tier}`,
    `- profile confidence: ${confidence}`,
    `- policy state: ${liveRecord?.availability.policyState ?? "unknown"}`,
    `- preview: ${liveRecord?.availability.preview === true ? "yes" : liveRecord?.availability.preview === false ? "no" : "unknown"}`,
    `- runtime API: ${liveRecord?.execution.api ?? localModel?.api ?? "unknown"}`,
    `- supported endpoints: ${(liveRecord?.execution.supportedEndpoints ?? []).join(", ") || "unknown"}`,
    `- tool calls: ${(liveRecord?.execution.toolCalls ?? localModel?.toolCalls ?? true) ? "yes" : "no"}`,
    `- context/output: ${liveRecord?.execution.contextWindow ?? localModel?.contextWindow ?? "unknown"} / ${liveRecord?.execution.maxTokens ?? localModel?.maxTokens ?? "unknown"}`,
    `- economics: ${economicsSummary(economics)}`,
    `- source: ${economicsSourceSummary(economics)}`,
    `- freshness: ${economicsFreshnessSummary(economics)}`,
    `- request billing: ${economics.requestMultiplier !== undefined ? `${economics.requestMultiplier}x (${economics.provenance.requestMultiplier?.source ?? economics.source}/${economics.provenance.requestMultiplier?.freshness ?? "unknown"})` : "unknown"}`,
    `- promotion: ${formatPromotion(liveRecord?.billing.promotion ?? economics.promotion)}`,
    `- automatic routing eligible: ${routingEligible ? "yes" : "no"}`,
    `- reason: ${routingReason}`,
    `- task routing context: unavailable (no active classification context)` ,
    `- guidance: ${guidance}`,
  ].join("\n");
}

function formatPricingRecord(record: CopilotModelRecord | undefined, localModel: any | undefined, bareId: string): string[] {
  const economics = resolveEconomicsForModel(bareId, record, localModel);
  const lines = [
    `GitHub Copilot pricing: github-copilot/${bareId}`,
    `- economics: ${economicsSummary(economics)}`,
    `- source: ${economicsSourceSummary(economics)}`,
    `- freshness: ${economicsFreshnessSummary(economics)}`,
  ];

  if (economics.tokenPrices?.default) {
    lines.push(
      `- cache: read ${economics.tokenPrices.default.cachedInputPer1k !== undefined ? `$${economics.tokenPrices.default.cachedInputPer1k.toFixed(4)}` : "unknown"} / write ${economics.tokenPrices.default.cachedOutputPer1k !== undefined ? `$${economics.tokenPrices.default.cachedOutputPer1k.toFixed(4)}` : "unknown"} per 1K`,
    );
  }
  if (economics.tokenPrices?.longContextTiers?.length) {
    lines.push(`- long-context tiers: ${economics.tokenPrices.longContextTiers.map((tier) => `>${tier.inputTokensAbove}: $${tier.inputPer1k?.toFixed(4) ?? "unknown"}/$${tier.outputPer1k?.toFixed(4) ?? "unknown"}`).join(", ")}`);
  }
  if (economics.requestMultiplier !== undefined) {
    lines.push(
      `- request multiplier: ${economics.requestMultiplier}x (${economics.provenance.requestMultiplier?.source ?? economics.source}/${economics.provenance.requestMultiplier?.freshness ?? "unknown"})`,
    );
  }
  if (economics.promotion) {
    lines.push(
      `- promotion: ${formatPromotion(economics.promotion)} (${economics.provenance.promotion?.source ?? economics.source}/${economics.provenance.promotion?.freshness ?? "unknown"})`,
    );
  }
  return lines;
}

function formatPromotions(snapshot: CopilotModelSnapshot | null): string {
  const records = snapshot?.models.filter((model) => model.billing.promotion) ?? [];
  const active = records.filter((model) => model.billing.promotion?.status === "active");
  const future = records.filter((model) => model.billing.promotion?.status === "future");
  const expired = records.filter((model) => model.billing.promotion?.status === "expired");

  const lines = ["GitHub Copilot promos:"];
  const sections: Array<[string, CopilotModelRecord[]]> = [
    ["active", active],
    ["future", future],
    ["expired", expired],
  ];

  for (const [label, models] of sections) {
    lines.push(`- ${label}: ${models.length}`);
    for (const model of models) {
      lines.push(`  - ${model.registryId}: ${formatPromotion(model.billing.promotion)}`);
    }
  }

  if (records.length === 0) {
    lines.push("- no live promotions are tracked in the accepted Copilot snapshot");
  }

  return lines.join("\n");
}

async function runSync(
  args: string,
  ctx: ExtensionCommandContext,
  options: HandleCopilotModelsOptions,
): Promise<void> {
  const auth = await resolveCopilotAuth(ctx);
  if (!auth.configured || !auth.copilotModel) {
    ctx.ui.notify(
      "GitHub Copilot is not configured for this session — run /login to sign in. No network request was made.",
      "info",
    );
    return;
  }
  if (!auth.tokenAvailable || !auth.token || !auth.baseUrl || !auth.accountKey) {
    ctx.ui.notify(
      `GitHub Copilot is configured but no access token could be resolved${auth.error ? ` (${auth.error})` : ""} — try /login again.`,
      "warning",
    );
    return;
  }

  const state = getSessionState(auth.accountKey);
  const attemptedAt = new Date().toISOString();

  try {
    const result = await fetchGitHubCopilotModels({
      provider: "github-copilot",
      authToken: auth.token,
      baseUrl: auth.baseUrl,
      fetchImpl: options.fetchImpl,
    });
    if (result.skipped || !result.snapshot) {
      throw new CopilotCatalogFetchError("network", result.reason ?? "Copilot model fetch was skipped unexpectedly.");
    }

    if (isSuspiciousCatalogShrink(state.lastKnownGoodSnapshot, result.snapshot)) {
      state.lastRefresh = {
        attemptedAt,
        status: "suspicious",
        failureKind: "suspicious-shrink",
        failureMessage: `suspicious shrink rejected (${state.lastKnownGoodSnapshot?.modelCount ?? 0} → ${result.snapshot.modelCount})`,
      };
      ctx.ui.notify(
        `GitHub Copilot model catalog refresh rejected as suspicious (${state.lastKnownGoodSnapshot?.modelCount ?? 0} → ${result.snapshot.modelCount}) — keeping the last known good snapshot.`,
        "warning",
      );
      return;
    }

    const previousSnapshot = state.lastKnownGoodSnapshot;
    state.lastKnownGoodSnapshot = previousSnapshot
      ? previousSnapshot && result.snapshot ? result.snapshot : previousSnapshot
      : result.snapshot;
    lastActiveAccountKey = auth.accountKey;

    const effectiveLocalModels = localCopilotModels(ctx);
    const overlayPath = options.overlayPath ?? resolveGsdModelsCatalogPath();
    const registerResult = hasRegisterFlag(args)
      ? registerCopilotModelsInOverlay(overlayPath, result.snapshot.models, effectiveLocalModels)
      : (() => {
          const candidates = computeCatalogRegistrationCandidates(result.snapshot.models, effectiveLocalModels);
          return {
            registeredIds: [] as string[],
            candidates,
            quarantined: candidates.filter((candidate) => !candidate.complete),
            overlayPath,
            overlayError: undefined as string | undefined,
          };
        })();

    // Registering into the overlay only writes models-catalog.json; ModelRegistry
    // only re-reads that file on refresh(), so without this the newly-registered
    // model stays unavailable to selection/`why` for the rest of this session.
    if (registerResult.registeredIds.length > 0) {
      ctx.modelRegistry.refresh();
    }

    state.lastAcceptedDiff = buildDiffState(
      previousSnapshot,
      result.snapshot,
      registerResult.candidates,
      registerResult.registeredIds,
    );
    state.lastRefresh = { attemptedAt, status: "success" };

    const messages: string[] = [];
    if (!previousSnapshot) {
      messages.push(`GitHub Copilot model catalog: ${result.snapshot.modelCount} model(s) available.`);
    } else {
      for (const model of state.lastAcceptedDiff.added) {
        messages.push(`+ ${model.registryId} added (${describeCapabilityTier(model.id)})`);
      }
      for (const model of state.lastAcceptedDiff.removed) {
        messages.push(`- ${model.registryId} removed`);
      }
      for (const model of state.lastAcceptedDiff.changed) {
        messages.push(`~ ${model.registryId} changed`);
      }
    }

    if (hasRegisterFlag(args)) {
      if (registerResult.overlayError) {
        messages.push(`! registration skipped: ${registerResult.overlayError}`);
      } else if (registerResult.registeredIds.length > 0) {
        for (const modelId of registerResult.registeredIds) {
          messages.push(`= github-copilot/${modelId} registered into ${registerResult.overlayPath}`);
        }
      }
      for (const candidate of registerResult.quarantined) {
        messages.push(`! ${candidate.registryId} quarantined — ${candidate.blockers.join("; ")}`);
      }
      if (!registerResult.overlayError && registerResult.registeredIds.length === 0 && registerResult.quarantined.length === 0) {
        messages.push("GitHub Copilot registration: no remote-only models were found; the effective local catalog already covers the accepted live snapshot.");
      }
    }

    const deduped = dedupeShellNotifications(messages);
    const notifications = getNotificationState(auth.accountKey);
    const unseen = deduped.filter((message) => !notifications.has(message));
    for (const message of deduped) notifications.add(message);

    if (previousSnapshot && unseen.length === 0) {
      ctx.ui.notify("GitHub Copilot model catalog: no new changes since the last accepted check.", "info");
      return;
    }

    ctx.ui.notify(unseen.join("\n"), "info");
  } catch (error) {
    const fetchError = error instanceof CopilotCatalogFetchError
      ? error
      : new CopilotCatalogFetchError("network", redactSensitive(error instanceof Error ? error.message : String(error)));
    state.lastRefresh = {
      attemptedAt,
      status: "failed",
      failureKind: fetchError.kind,
      failureMessage: redactSensitive(fetchError.message),
    };

    if (!state.lastKnownGoodSnapshot) {
      ctx.ui.notify(
        `GitHub Copilot model catalog unavailable (${fetchError.kind}: ${redactSensitive(fetchError.message)}) — no cached catalog yet, nothing was changed.`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      `GitHub Copilot model catalog refresh failed (${fetchError.kind}: ${redactSensitive(fetchError.message)}) — keeping the last known good snapshot.`,
      "warning",
    );
  }
}

export async function handleCopilotModels(
  args: string,
  ctx: ExtensionCommandContext,
  options: HandleCopilotModelsOptions = {},
): Promise<void> {
  const command = parseCommand(args);

  if (command === "why") {
    const parsed = parseProviderModelArgument("why", args, true);
    if (!parsed.valid) {
      ctx.ui.notify(parsed.error ?? "Usage: /gsd copilot-models why <model>", "warning");
      return;
    }
    // Resolve the CURRENT account's snapshot, not whichever account last
    // completed a sync — otherwise `why` can report a different account's
    // availability/pricing/policy after switching accounts without re-syncing.
    const current = await resolveCurrentAccountView(ctx);
    ctx.ui.notify(buildWhyExplanation(parsed.target!, ctx, current.state?.lastKnownGoodSnapshot ?? null), "info");
    return;
  }

  if (command === "changes") {
    const current = await resolveCurrentAccountView(ctx);
    if (!current.auth.configured) {
      ctx.ui.notify(
        "GitHub Copilot is not configured for this session — no account-scoped catalog diff is available.",
        "info",
      );
      return;
    }
    ctx.ui.notify(formatChanges(current.state?.lastAcceptedDiff ?? null), "info");
    return;
  }

  if (command === "pricing") {
    const parsed = parseProviderModelArgument("pricing", args, false);
    if (!parsed.valid) {
      ctx.ui.notify(parsed.error ?? "Usage: /gsd copilot-models pricing <model>", "warning");
      return;
    }

    const current = await resolveCurrentAccountView(ctx);
    const currentSnapshot = current.state?.lastKnownGoodSnapshot ?? null;

    if (parsed.target) {
      const bareId = parsed.target;
      ctx.ui.notify(
        formatPricingRecord(findLiveRecord(currentSnapshot, bareId), findLocalModel(ctx, bareId), bareId).join("\n"),
        "info",
      );
      return;
    }

    const snapshot = currentSnapshot;
    const records = snapshot?.models ?? localCopilotModels(ctx).map((model) => ({ id: model.id, registryId: `github-copilot/${model.id}` } as CopilotModelRecord));
    if (records.length === 0) {
      ctx.ui.notify("GitHub Copilot pricing unavailable — no accepted live snapshot or effective local Copilot models are present.", "warning");
      return;
    }
    const blocks = records.map((record) => {
      const bareId = normalizeBareModelId(record.id);
      return formatPricingRecord(findLiveRecord(snapshot, bareId), findLocalModel(ctx, bareId), bareId).join("\n");
    });
    ctx.ui.notify(blocks.join("\n\n"), "info");
    return;
  }

  if (command === "promos") {
    const current = await resolveCurrentAccountView(ctx);
    ctx.ui.notify(formatPromotions(current.state?.lastKnownGoodSnapshot ?? null), "info");
    return;
  }

  if (command === "doctor") {
    const current = await resolveCurrentAccountView(ctx);
    const auth = current.auth;
    const snapshot = current.state?.lastKnownGoodSnapshot ?? null;
    const refresh = current.state?.lastRefresh ?? null;
    const blockedByPolicy = snapshot?.models.filter((model) => model.availability.policyState === "disabled" || model.availability.policyState === "restricted") ?? [];
    const previewDisabled = snapshot?.models.filter((model) => model.availability.preview === true && model.availability.pickerEnabled === false) ?? [];
    const quarantined = current.state?.lastAcceptedDiff?.candidates.filter((candidate) => !candidate.complete) ?? [];
    const activeAccountKey = current.accountKey;
    const lines = [
      "GitHub Copilot doctor:",
      `- configured: ${auth.configured ? "yes" : "no"}`,
      `- token available: ${auth.tokenAvailable ? "yes" : "no"}`,
      `- account isolation: ${activeAccountKey ? `active fingerprint ${activeAccountKey.slice(0, 12)}…, ${sessionStates.size} cached account state(s)` : "no active account state cached yet"}`,
      `- last known good snapshot: ${snapshot ? `cached (${snapshot.modelCount} models)` : "none"}`,
      `- cache age: ${formatCacheAge(snapshot?.generatedAt)}`,
      `- last refresh: ${refresh ? refresh.status : "never"}`,
      `- network state: ${refresh?.status === "failed" ? `${refresh.failureKind ?? "error"} — ${refresh.failureMessage ?? "unknown failure"}` : refresh?.status === "suspicious" ? refresh.failureMessage ?? "suspicious shrink rejected" : "idle (doctor is local-only)"}`,
      `- policy-blocked models: ${blockedByPolicy.length}`,
      `- preview-disabled models: ${previewDisabled.length}`,
      `- quarantined registration candidates: ${quarantined.length}`,
      `- registration blockers: ${quarantined.slice(0, 3).map((candidate) => `${candidate.id}: ${candidate.blockers.join("; ")}`).join(" | ") || "none recorded"}`,
    ];
    ctx.ui.notify(lines.join("\n"), auth.tokenAvailable ? "info" : "warning");
    return;
  }

  await runSync(args, ctx, options);
}
