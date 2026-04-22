// GSD2 — gsd-2: provider-equality guardrail test (ADR-012)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// Transports known to be confusable with API shape. Extend this list as new
// Anthropic-/OpenAI-/Gemini-fronting transports are added to the codebase.
const KNOWN_TRANSPORTS = [
  "anthropic",
  "openai",
  "google",
  "claude-code",
  "anthropic-vertex",
  "amazon-bedrock",
  "azure",
  "copilot",
  "github-copilot",
  "openrouter",
  "groq",
  "vercel-ai-gateway",
];

// Any `.provider === "x"` or `.provider !== "x"` where x is a known transport.
const PROVIDER_EQ_RE = new RegExp(
  String.raw`\.provider\s*(?:===|!==)\s*["'](?:` +
    KNOWN_TRANSPORTS.join("|") +
    String.raw`)["']`,
);

// Legitimate transport-specific sites. Each entry is a repo-relative POSIX
// path plus a one-line justification. Update ADR-012's "When `provider`
// comparison is still correct" section when adding to this list.
const ALLOWED_FILES: Record<string, string> = {
  // Fallback source is the plain `anthropic` transport (routes to claude-code).
  "packages/pi-coding-agent/src/core/retry-handler.ts":
    "transport-specific fallback source (ADR-012)",

  // Claude-Code-specific SDK hooks (OAuth prep, streaming buffer sizing).
  "packages/pi-coding-agent/src/core/sdk.ts":
    "claude-code-specific SDK behavior",
  "packages/pi-coding-agent/src/modes/interactive/controllers/chat-controller.ts":
    "claude-code-specific streaming UI",
  "packages/pi-coding-agent/src/modes/interactive/components/assistant-message.ts":
    "claude-code-specific message rendering",

  // GitHub Copilot transport-specific request/auth transforms.
  "packages/pi-ai/src/utils/oauth/github-copilot.ts":
    "github-copilot OAuth-specific model shaping",
  "packages/pi-ai/src/providers/openai-shared.ts":
    "github-copilot-specific header injection",
  "packages/pi-ai/src/providers/anthropic.ts":
    "github-copilot-specific header injection on Anthropic transport",

  // Transport-specific model-ID quirks (OpenRouter Anthropic IDs, OpenAI
  // custom-model-ID length cap, Copilot-specific headers).
  "packages/pi-ai/src/providers/openai-completions.ts":
    "transport-specific model-ID and header handling",

  // Model-registry canonical-provider tiebreakers (prefer plain `anthropic` /
  // `claude-code` when multiple transports serve the same model).
  "src/resources/extensions/gsd/auto-model-selection.ts":
    "canonical-provider tiebreakers (ADR-012)",

};

function shouldScan(path: string): boolean {
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  const parts = path.split(sep);
  if (parts.includes("node_modules")) return false;
  if (parts.includes(".worktrees")) return false;
  if (parts.includes("dist")) return false;
  if (parts.includes("build")) return false;
  if (parts.includes("scripts")) return false;
  if (parts.includes("tests")) return false;
  if (parts.includes("__tests__")) return false;
  return true;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".worktrees" || entry === "dist" || entry === "build") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (shouldScan(full)) {
      out.push(full);
    }
  }
}

function collectHits(): string[] {
  const files: string[] = [];
  walk(join(REPO_ROOT, "src"), files);
  walk(join(REPO_ROOT, "packages"), files);

  const hits: string[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split(sep).join("/");
    const contents = readFileSync(abs, "utf8");
    if (PROVIDER_EQ_RE.test(contents)) hits.push(rel);
  }
  return hits.sort();
}

test("ADR-012: provider-equality checks are allowlisted or use isXxxApi helpers", () => {
  const hits = collectHits();
  const unauthorized = hits.filter((p) => !(p in ALLOWED_FILES));

  if (unauthorized.length > 0) {
    const lines = unauthorized.map((p) => `  - ${p}`).join("\n");
    assert.fail(
      `New \`model.provider === "<transport>"\` check(s) detected in:\n${lines}\n\n` +
        `Rule (ADR-012): gate API-shape-dependent behavior on \`model.api\` via\n` +
        `isAnthropicApi / isOpenAIApi / isGeminiApi / isBedrockApi from @gsd/pi-ai.\n\n` +
        `If the check really is transport-specific (credentials, fallback source,\n` +
        `display labels, etc.), add the file to ALLOWED_FILES in this test with a\n` +
        `one-line reason and update ADR-012's allowlist section.`,
    );
  }
});

test("ADR-012: no stale entries in ALLOWED_FILES", () => {
  const hits = new Set(collectHits());
  const stale = Object.keys(ALLOWED_FILES).filter((p) => !hits.has(p));
  assert.deepEqual(
    stale,
    [],
    `ALLOWED_FILES has entries that no longer contain provider-equality checks:\n` +
      stale.map((p) => `  - ${p}`).join("\n") +
      `\nRemove them to keep the allowlist honest.`,
  );
});
