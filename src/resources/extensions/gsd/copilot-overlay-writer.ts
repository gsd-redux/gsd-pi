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

import { isModelsCatalogOverlay, type Model, type ModelsCatalogOverlay } from "@gsd/pi-ai";

export {
  applyLastKnownGood,
  dedupeShellNotifications,
  diffCatalogSnapshots,
  fetchGitHubCopilotModels,
  sanitizeGitHubCopilotModels,
} from "./copilot-model-catalog.js";
export type { CopilotModelRecord, CopilotModelSnapshot } from "./copilot-model-catalog.js";

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

/** Placeholder defaults used only when the live Copilot API does not expose a field. Never authoritative. */
export const COPILOT_OVERLAY_PLACEHOLDER_CONTEXT_WINDOW = 128_000;
export const COPILOT_OVERLAY_PLACEHOLDER_MAX_TOKENS = 8_192;

/**
 * Map the minimal fields the live GitHub Copilot `/models` response actually
 * exposes (`id`, `name`, `tool_call`) into a schema-valid `ModelCatalogEntrySchema`
 * shape (see `packages/pi-ai/src/model-catalog.ts`). `reasoning`, `cost`,
 * `contextWindow`, and `maxTokens` are unknown from this endpoint and are set
 * to conservative placeholders pending a `packages/pi-ai` generator refresh
 * (which sources richer data from `models.dev`) — never guessed as if real.
 */
export function synthesizeCopilotOverlayEntry(record: CopilotModelRecord): Model<"openai-completions"> {
  return {
    id: record.id,
    name: record.name || record.id,
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: COPILOT_OVERLAY_BASE_URL,
    // Unknown from the live /models endpoint — placeholder, not a real claim.
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: COPILOT_OVERLAY_PLACEHOLDER_CONTEXT_WINDOW,
    maxTokens: COPILOT_OVERLAY_PLACEHOLDER_MAX_TOKENS,
    headers: { ...COPILOT_OVERLAY_HEADERS },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
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
  newModels: Model<"openai-completions">[],
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
  reason: string;
}

export interface RegisterCopilotModelsResult {
  registeredIds: string[];
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
    .map((model) => ({
      ...model,
      reason:
        "remote-only GitHub Copilot model detected; kept quarantined because the effective local catalog is authoritative and unknown metadata must not be persisted as concrete truth.",
    }));
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
  const quarantined = computeCatalogRegistrationCandidates(discovered, effectiveLocalModels);

  // The safe registration policy is intentionally no-op for remote-only entries:
  // they are kept quarantined and never persisted as concrete catalog truth
  // without known metadata from the authoritative local catalog or generator.
  return {
    registeredIds: [],
    quarantined,
    overlayPath,
  };
}
