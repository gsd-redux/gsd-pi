/**
 * GitHub Copilot model catalog — read-only fetch/sanitize/diff pipeline.
 *
 * Pure functions only. No auth, no ctx, no network defaults beyond a
 * documented fallback base URL — callers own token resolution (via
 * `ctx.modelRegistry.getApiKey()`) and the real per-account/enterprise base
 * URL (via `getGitHubCopilotBaseUrl()` from `@gsd/pi-ai/oauth`). See
 * `commands/handlers/copilot-models.ts` for the wired production entry point.
 *
 * Never mutates the model registry, `models.json`, or any provider catalog —
 * this module only ever produces a read-only report.
 */
export type GitHubCopilotProvider = "github-copilot" | "openai" | "anthropic" | "google" | "unknown";

export interface CopilotModelRecord {
  id: string;
  name: string;
  tool_call?: boolean;
  /**
   * Provider-qualified registry ID (`<provider>/<id>`), matching the
   * `provider/modelId` identity convention used by the GSD model router
   * (see `model-router.ts`) — computed from bare `id`, never fetched.
   */
  registryId?: string;
}

export interface CopilotModelSnapshot {
  generatedAt: string;
  models: CopilotModelRecord[];
}

export interface FetchCopilotModelsOptions {
  provider: GitHubCopilotProvider;
  authToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FetchCopilotModelsResult {
  skipped?: boolean;
  reason?: string;
  models: CopilotModelRecord[];
  snapshot?: CopilotModelSnapshot;
}

export function sanitizeGitHubCopilotModels(payload: { data?: unknown[] | null } | null | undefined): CopilotModelRecord[] {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set<string>();
  const sanitized: CopilotModelRecord[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const record = row as Record<string, unknown>;
    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    const toolCall = record.tool_call === true;

    if (!rawId || seen.has(rawId) || !toolCall) continue;

    seen.add(rawId);
    sanitized.push({
      id: rawId,
      name: rawName || rawId,
      tool_call: true,
    });
  }

  return sanitized;
}

export async function fetchGitHubCopilotModels(options: FetchCopilotModelsOptions): Promise<FetchCopilotModelsResult> {
  if (options.provider !== "github-copilot") {
    return { skipped: true, reason: "provider-not-copilot", models: [] };
  }

  const endpoint = options.baseUrl ?? "https://api.githubcopilot.com";
  const authToken = options.authToken ?? "";
  const fetcher = options.fetchImpl ?? fetch;

  const response = await fetcher(`${endpoint}/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Copilot models fetch failed: ${response.status}`);
  }

  const payload = await response.json();
  const models = sanitizeGitHubCopilotModels(payload).map((model) => ({
    ...model,
    registryId: `${options.provider}/${model.id}`,
  }));
  const snapshot: CopilotModelSnapshot = {
    generatedAt: new Date().toISOString(),
    models,
  };

  return { models, snapshot };
}

export function applyLastKnownGood<T>(previous: T, next: { ok: boolean; error?: string; snapshot: T | null }): T {
  if (next.ok && next.snapshot) return next.snapshot;
  return previous;
}

export function diffCatalogSnapshots(previous: CopilotModelSnapshot, next: CopilotModelSnapshot) {
  const previousMap = new Map(previous.models.map((model) => [model.id, model]));
  const nextMap = new Map(next.models.map((model) => [model.id, model]));

  const added = [...nextMap.entries()].filter(([id]) => !previousMap.has(id)).map(([, model]) => model);
  const removed = [...previousMap.entries()].filter(([id]) => !nextMap.has(id)).map(([, model]) => model);
  const changed = [...nextMap.entries()].filter(([id, model]) => {
    const previousModel = previousMap.get(id);
    return previousModel && (previousModel.name !== model.name || previousModel.tool_call !== model.tool_call);
  }).map(([, model]) => model);

  return { added, removed, changed };
}

export function dedupeShellNotifications(messages: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const message of messages) {
    if (seen.has(message)) continue;
    seen.add(message);
    result.push(message);
  }

  return result;
}
