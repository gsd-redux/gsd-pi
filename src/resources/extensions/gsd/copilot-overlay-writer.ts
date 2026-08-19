/**
 * GitHub Copilot model-catalog overlay writer — Phase H, first vertical slice.
 *
 * Closes the loop that Phase C's read-only drift-check (`copilot-model-catalog.ts`)
 * only detects: when a live GitHub Copilot model is discovered that is absent
 * from the bundled/overlay catalog, this module synthesizes a schema-valid
 * `Model` entry for it and merges it into the *same* `models-catalog.json`
 * overlay that `gsd update --models` (`src/update-cmd.ts`) already writes and
 * that `ModelRegistry` already merges at runtime (bundled catalog < overlay <
 * `models.json`). No `packages/pi-ai` generator changes, no separate Pi repo,
 * no registry mutation code — this only ever produces/merges/writes the
 * existing overlay file format.
 *
 * Every synthesized field the live Copilot `/models` response does not itself
 * expose (reasoning, context window, max tokens, cost) is a documented,
 * clearly-labeled placeholder — never presented as authoritative pricing or
 * capability data. Existing overlay entries (in particular anything already
 * sourced from the `packages/pi-ai` generator via `models.dev`) are never
 * downgraded or overwritten by this module.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isModelsCatalogOverlay, type Api, type Model, type ModelsCatalogOverlay } from "@gsd/pi-ai";

export {
  applyLastKnownGood,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  findStaticCopilotModel,
  isSuspiciousCatalogShrink,
  sanitizeGitHubCopilotModels,
} from "./copilot-model-catalog.js";
export type { CopilotModelRecord, CopilotModelSnapshot } from "./copilot-model-catalog.js";

import { findStaticCopilotModel } from "./copilot-model-catalog.js";
import type { CopilotModelRecord } from "./copilot-model-catalog.js";

// Inline agentDir computation (mirrors `src/app-paths.ts`'s `agentDir`) —
// importing from `src/` pulls files outside `src/resources` and breaks the
// extensions build (see `onboarding-state.ts` for the same convention). This
// must resolve to the *exact* same directory `resolveModelsCatalogPath()`
// (src/models-resolver.ts) does, since `models-catalog.json` is only ever
// read by `ModelRegistry` from that one location.
function defaultModelsCatalogPath(): string {
  const appRoot = process.env.GSD_HOME || join(homedir(), ".gsd");
  return join(appRoot, "agent", "models-catalog.json");
}

/** Resolve the on-disk path to the models-catalog.json overlay. Accepts an override for tests. */
export function resolveGsdModelsCatalogPath(agentDirOverride?: string): string {
  return agentDirOverride ? join(agentDirOverride, "models-catalog.json") : defaultModelsCatalogPath();
}

/** Static request headers GitHub Copilot's API expects — mirrors `COPILOT_STATIC_HEADERS` in `packages/pi-ai/scripts/generate-models.ts`. */
export const COPILOT_OVERLAY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
});

const COPILOT_OVERLAY_BASE_URL = "https://api.individual.githubcopilot.com";

function toPerMillion(valuePer1k: number): number {
  return valuePer1k * 1000;
}

function apiSpecificCompat(record: CopilotModelRecord): Model<Api>["compat"] | undefined {
  const staticModel = findStaticCopilotModel(record.id);
  if (staticModel?.compat) return staticModel.compat;

  switch (record.execution.api) {
    case "openai-completions":
      return {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      };
    case "anthropic-messages":
    case "openai-responses":
    default:
      return undefined;
  }
}

function isRegistrationPreviewDisabled(record: CopilotModelRecord): boolean {
  return record.availability?.preview === true && record.availability?.pickerEnabled === false;
}

function registrationBlockers(record: CopilotModelRecord): string[] {
  const blockers: string[] = [];

  if ((record.conflicts?.length ?? 0) > 0) {
    blockers.push(...record.conflicts);
  }
  if (record.availability?.enabled === false) {
    blockers.push("provider reports the model as disabled");
  }
  if (record.availability?.policyState === "disabled") {
    blockers.push("provider policy disables the model");
  }
  if (record.availability?.policyState === "restricted") {
    blockers.push("provider policy restricts the model");
  }
  if (isRegistrationPreviewDisabled(record)) {
    blockers.push("preview model is not enabled in the model picker");
  }
  if (!record.execution?.api) {
    blockers.push("missing authoritative runtime API/endpoint mapping");
  }
  if (record.execution?.toolCalls !== true) {
    blockers.push("tool calling is unavailable");
  }
  if (!record.execution?.contextWindow) {
    blockers.push("missing authoritative context window");
  }
  if (!record.execution?.maxTokens) {
    blockers.push("missing authoritative max output tokens");
  }
  if (record.execution?.reasoning === undefined) {
    blockers.push("missing authoritative reasoning support flag");
  }
  if (record.billing?.inputPer1k === undefined) {
    blockers.push("missing authoritative input token price");
  }
  if (record.billing?.outputPer1k === undefined) {
    blockers.push("missing authoritative output token price");
  }
  if (record.billing?.cacheReadPer1k === undefined) {
    blockers.push("missing authoritative cache-read token price");
  }
  if (record.billing?.cacheWritePer1k === undefined) {
    blockers.push("missing authoritative cache-write token price");
  }

  return blockers;
}

/**
 * Build a schema-valid overlay entry from a COMPLETE normalized Copilot record.
 * Callers must only use this after `registrationBlockers()` returned no blockers.
 */
export function synthesizeCopilotOverlayEntry(record: CopilotModelRecord): Model<Api> {
  if (!record.execution.api) {
    throw new Error(`Cannot synthesize overlay entry for ${record.registryId} without a resolved API.`);
  }

  return {
    id: record.id,
    name: record.name || record.id,
    api: record.execution.api,
    provider: "github-copilot",
    baseUrl: COPILOT_OVERLAY_BASE_URL,
    reasoning: record.execution.reasoning ?? false,
    ...(record.execution.reasoningLevels.length > 0
      ? {
          thinkingLevelMap: Object.fromEntries(
            record.execution.reasoningLevels.map((level) => [level, level]),
          ),
        }
      : {}),
    input: record.execution.vision ? ["text", "image"] : ["text"],
    cost: {
      input: toPerMillion(record.billing.inputPer1k ?? 0),
      output: toPerMillion(record.billing.outputPer1k ?? 0),
      cacheRead: toPerMillion(record.billing.cacheReadPer1k ?? 0),
      cacheWrite: toPerMillion(record.billing.cacheWritePer1k ?? 0),
      ...(record.billing.longContextTiers?.length
        ? {
            tiers: record.billing.longContextTiers.map((tier) => ({
              inputTokensAbove: tier.inputTokensAbove,
              ...(tier.inputPer1k !== undefined ? { input: toPerMillion(tier.inputPer1k) } : {}),
              ...(tier.outputPer1k !== undefined ? { output: toPerMillion(tier.outputPer1k) } : {}),
              ...(tier.cacheReadPer1k !== undefined ? { cacheRead: toPerMillion(tier.cacheReadPer1k) } : {}),
              ...(tier.cacheWritePer1k !== undefined ? { cacheWrite: toPerMillion(tier.cacheWritePer1k) } : {}),
            })),
          }
        : {}),
    },
    contextWindow: record.execution.contextWindow ?? 1,
    maxTokens: record.execution.maxTokens ?? 1,
    headers: { ...COPILOT_OVERLAY_HEADERS },
    ...(apiSpecificCompat(record) ? { compat: apiSpecificCompat(record) } : {}),
  };
}

/**
 * Merge newly-synthesized `github-copilot` models into an existing (or
 * absent) overlay. Never touches any other provider's entries. Never
 * overwrites an existing `github-copilot` entry for the same model id —
 * an entry already present (e.g. sourced from the `packages/pi-ai` generator
 * via `gsd update --models`) is strictly more authoritative than a synthesized
 * placeholder and must win.
 */
export function mergeIntoModelsCatalogOverlay(
  existing: ModelsCatalogOverlay | null,
  newModels: Model<Api>[],
): ModelsCatalogOverlay {
  const baseModels = existing?.models ?? {};
  const existingCopilotModels = baseModels["github-copilot"] ?? {};

  const mergedCopilotModels = { ...existingCopilotModels };
  for (const model of newModels) {
    if (mergedCopilotModels[model.id]) continue; // never downgrade an existing entry
    mergedCopilotModels[model.id] = model;
  }

  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    source: existing?.source ?? "gsd:copilot-models --register",
    models: {
      ...baseModels,
      "github-copilot": mergedCopilotModels,
    },
  };
}

/** Best-effort read of an existing overlay. Returns null for missing/malformed/invalid files — never throws. */
export function readModelsCatalogOverlay(path: string): ModelsCatalogOverlay | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isModelsCatalogOverlay(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomic write: temp file in the same directory, then rename — mirrors the
 * exact pattern already used by `gsd update --models` (`src/update-cmd.ts`'s
 * `runModelsUpdate()`), so a crash mid-write never corrupts the overlay.
 */
export function writeModelsCatalogOverlay(path: string, overlay: ModelsCatalogOverlay): void {
  const tmpPath = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(overlay, null, 2) + "\n");
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export interface CatalogRegistrationCandidate extends CopilotModelRecord {
  complete: boolean;
  blockers: string[];
  reason: string;
}

export interface RegisterCopilotModelsResult {
  registeredIds: string[];
  candidates: CatalogRegistrationCandidate[];
  quarantined: CatalogRegistrationCandidate[];
  overlayPath: string;
}

/**
 * Compute remote-only Copilot candidates as the set difference:
 * live remote catalog - effective local catalog.
 *
 * The effective local catalog is the authoritative runtime truth. Remote-only
 * entries are never materialized into the overlay as fabricated metadata; they
 * stay quarantined until a real generator or user-authored custom model entry
 * exists for them.
 */
export function computeCatalogRegistrationCandidates(
  remoteModels: CopilotModelRecord[],
  localModels: Array<{ id: string; provider?: string }>,
): CatalogRegistrationCandidate[] {
  const localIds = new Set(
    localModels
      .filter((model) => !model.provider || model.provider === "github-copilot")
      .map((model) => model.id),
  );

  return remoteModels
    .filter((model) => !localIds.has(model.id))
    .map((model) => {
      const blockers = registrationBlockers(model);
      const complete = blockers.length === 0;
      return {
        ...model,
        complete,
        blockers,
        reason: complete
          ? "remote-only GitHub Copilot model has complete authoritative metadata and can be registered safely"
          : `remote-only GitHub Copilot model kept quarantined: ${blockers.join("; ")}`,
      };
    });
}

/**
 * Safe registration path: keep remote-only models quarantined instead of writing
 * placeholder metadata into `models-catalog.json`.
 */
export function registerCopilotModelsInOverlay(
  overlayPath: string,
  discovered: CopilotModelRecord[],
  localModels: Array<{ id: string; provider?: string }> = [],
): RegisterCopilotModelsResult {
  const existingOverlay = readModelsCatalogOverlay(overlayPath);
  const overlayLocalModels = existingOverlay
    ? Object.entries(existingOverlay.models).flatMap(([provider, entries]) =>
        provider === "github-copilot"
          ? Object.keys(entries).map((id) => ({ id, provider: "github-copilot" }))
          : [],
      )
    : [];

  const effectiveLocalModels = [...localModels, ...overlayLocalModels];
  const candidates = computeCatalogRegistrationCandidates(discovered, effectiveLocalModels);
  const quarantined = candidates.filter((candidate) => !candidate.complete);
  const complete = candidates.filter((candidate) => candidate.complete);

  if (complete.length > 0) {
    const entries = complete.map((candidate) => synthesizeCopilotOverlayEntry(candidate));
    const merged = mergeIntoModelsCatalogOverlay(existingOverlay, entries);
    writeModelsCatalogOverlay(overlayPath, merged);
  }

  return {
    registeredIds: complete.map((candidate) => candidate.id),
    candidates,
    quarantined,
    overlayPath,
  };
}
