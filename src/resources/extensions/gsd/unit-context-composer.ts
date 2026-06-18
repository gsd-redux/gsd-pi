// gsd-pi — UnitContextComposer (#4782 phase 2).
//
// Reads a unit type's manifest and orchestrates artifact inlining through
// a caller-provided resolver. Returns a joined context block suitable for
// substitution into the unit's prompt template.
//
// Design rationale:
//   - Pure dependency on the manifest module — no circular import with
//     `auto-prompts.ts` where the per-artifact-key resolver lives.
//   - Caller-supplied resolver means the composer can be unit-tested with
//     trivial mocks; production wiring in `auto-prompts.ts` dispatches to
//     the existing `inlineFile` / `inline*FromDb` helpers.
//   - Null-returning resolvers are skipped silently: they model the
//     "artifact is optional / missing / not applicable to this milestone"
//     case. The composer never errors on a missing artifact.
//
// Scope: phase 2 pilot shipped `composeInlinedContext` for static-key
// inlining. Phase 3.5 (#4924) adds the v2 surface — `composeUnitContext`
// — which also handles excerpts, computed artifacts, and prepended blocks.
// `composeInlinedContext` stays for backward compatibility with the
// already-migrated simple builders.
//
// ─── Composer boundary invariant (#4924) ─────────────────────────────────
//
// The composer is allowed to:
//   - order named sections per the manifest's declared sequence
//   - resolve registered artifacts (static / computed / excerpt / on-demand)
//   - apply typed policies (knowledge / memory / codebase-map / preferences)
//
// The composer must NOT grow:
//   - arbitrary conditionals on unit state
//   - loops over caller-supplied data
//   - string templating beyond section composition (join + separator)
//
// Logic that needs those belongs in a typed computed-artifact builder
// owned by the unit, not in the composer. Reviews must enforce this — it
// is the difference between an orchestrator and a runaway DSL.

import {
  resolveManifest,
  type ArtifactKey,
  type BaseResolverContext,
  type ComputedArtifactId,
  type ComputedArtifactRegistry,
  type ContextModePolicy,
  type ToolsPolicy,
  type UnitContextManifest,
} from "./unit-context-manifest.js";
import { getUnitToolSurfaceContract } from "./unit-tool-contracts.js";
import type { UnitPromptContextContract } from "./tool-contract.js";

/**
 * Async function mapping an artifact key to its inlined-content string,
 * or `null` when the artifact does not apply to the current milestone
 * (missing file, empty table, etc).
 */
export type ArtifactResolver = (key: ArtifactKey) => Promise<string | null>;

/**
 * Produce the inlined-context portion of a unit's system prompt by
 * walking the manifest's `artifacts.inline` list in order and calling
 * the provided resolver for each key.
 *
 * Returns an empty string when the unit type has no manifest registered,
 * so callers can guard their wiring with a simple truthy check. Unknown
 * unit types do not error — this mirrors `resolveManifest`'s contract.
 *
 * The separator between inlined blocks matches the in-tree convention
 * (`\n\n---\n\n`) so composer output slots into existing prompt templates
 * without visible diff.
 */
export async function composeInlinedContext(
  unitType: string,
  resolveArtifact: ArtifactResolver,
): Promise<string> {
  const manifest: UnitContextManifest | null = resolveManifest(unitType);
  if (!manifest) return "";

  const blocks: string[] = [];
  for (const key of manifest.artifacts.inline) {
    const body = await resolveArtifact(key);
    if (body !== null && body.length > 0) {
      blocks.push(body);
    }
  }
  return blocks.join("\n\n---\n\n");
}

/**
 * Convenience helper returning the manifest's declared budget so callers
 * can telemetry a mismatch between actual prompt size and declared budget.
 * Returns null for unknown unit types.
 */
export function manifestBudgetChars(unitType: string): number | null {
  const manifest = resolveManifest(unitType);
  return manifest ? manifest.maxSystemPromptChars : null;
}

// ─── Context Mode lane guidance ──────────────────────────────────────────

export type ContextModeRenderMode = "standalone" | "nested";

export interface ComposeContextModeInstructionOptions {
  readonly enabled: boolean;
  readonly renderMode: ContextModeRenderMode;
}

const CONTEXT_MODE_LANE_LABELS: Record<Exclude<ContextModePolicy, "none">, string> = {
  interview: "interview",
  research: "research",
  triage: "triage",
  planning: "planning",
  execution: "execution",
  verification: "verification",
  orchestration: "orchestration",
  docs: "documentation",
};

const CONTEXT_MODE_GUIDANCE_BY_LANE: Record<Exclude<ContextModePolicy, "none">, string> = {
  interview:
    "Use `gsd_resume` to restore prior discussion, `gsd_exec` for noisy discovery, and `gsd_exec_search` before repeating scans.",
  research:
    "Use `gsd_exec` for noisy research scans, `gsd_exec_search` before reruns, and `gsd_resume` to restore prior findings.",
  triage:
    "Use `gsd_resume` to restore prior triage context, `gsd_exec_search` to reuse evidence, and `gsd_exec` for noisy validation checks.",
  planning:
    "Use `gsd_resume` for planning continuity, `gsd_exec` for noisy checks, and `gsd_exec_search` before rerunning diagnostics.",
  execution:
    "Use `gsd_exec` for builds, tests, and diagnostics, `gsd_exec_search` before reruns, and `gsd_resume` after compaction or resume.",
  verification:
    "Use `gsd_exec` for verification commands, `gsd_exec_search` to reuse prior evidence, and `gsd_resume` after compaction or resume.",
  orchestration:
    "Use `gsd_resume` before resuming orchestration, `gsd_exec_search` to reuse prior runs, and `gsd_exec` for noisy coordination checks.",
  docs:
    "Use `gsd_resume` for prior context, `gsd_exec_search` for saved evidence, and `gsd_exec` for noisy doc validation commands.",
};

// Per-unit overrides win over the lane default. run-uat's tool contract
// forbids `gsd_exec`/`gsd_exec_search` (acceptance evidence must flow through
// `gsd_uat_exec`) and Claude Code dispatch strips the tools entirely, so the
// shared verification-lane guidance would steer the agent into calling an
// unavailable tool.
const CONTEXT_MODE_GUIDANCE_BY_UNIT: Record<string, string> = {
  "run-uat":
    "Use `gsd_uat_exec` for acceptance checks so evidence is typed as UAT-owned, and `gsd_resume` after compaction or resume.",
};

/**
 * Render the Context Mode instruction lane for a unit type. Unknown unit
 * types, disabled config, and explicit `contextMode: "none"` all omit the
 * block so callers can prefix this safely without extra branching.
 */
export function composeContextModeInstructions(
  unitType: string,
  opts: ComposeContextModeInstructionOptions,
): string {
  if (!opts.enabled) return "";
  const manifest = resolveManifest(unitType);
  if (!manifest || manifest.contextMode === "none") return "";

  const lane = CONTEXT_MODE_LANE_LABELS[manifest.contextMode];
  const guidance =
    CONTEXT_MODE_GUIDANCE_BY_UNIT[unitType] ?? CONTEXT_MODE_GUIDANCE_BY_LANE[manifest.contextMode];
  if (opts.renderMode === "nested") {
    return `Context Mode (${lane} lane): ${guidance}`;
  }

  return [
    "## Context Mode",
    "",
    `Lane: **${lane} lane**.`,
    guidance,
  ].join("\n");
}

// ─── Tool surface hardening ───────────────────────────────────────────────
//
// Upfront guidance for units whose runtime tool surface is narrower than the
// default Claude/native set. Prevents wasted turns on tools that are blocked
// by the write gate or Claude Code SDK allowlists (run-uat gsd_exec/Bash).

export interface ComposeToolSurfaceInstructionOptions {
  readonly renderMode: ContextModeRenderMode;
}

const TOOL_SURFACE_GUIDANCE_BY_UNIT: Record<string, string> = {
  "run-uat":
    "Do not call `gsd_exec`, `Bash`, `Write`, or `Edit` — they are unavailable in this unit. Run every automated check through `gsd_uat_exec` with the appropriate `intent`. For browser UAT modes, use `browser_*` tools when presented; if browser automation fails, record the failure honestly and use `gsd_uat_exec` for the best objective substitute.",
  "complete-slice":
    "Run slice-level verification through `gsd_exec` (or MCP-scoped `mcp__…__gsd_exec`), not direct `bash`. Capture learnings through `gsd_capture_thought` (or MCP-scoped `mcp__…__gsd_capture_thought`), not bare `capture_thought`, when workflow MCP tools are presented. Do not call `gsd_uat_result_save` — run-uat owns persisted UAT assessment. On verification failure, do not edit user source files in this unit.",
  "gate-evaluate":
    "Dispatch only **tester** subagents via `subagent`. Persist each gate with `gsd_save_gate_result`. Do not use `ToolSearch` — it is not available.",
  "reactive-execute":
    "Dispatch only **worker** subagents via `subagent`. Do not call `gsd_task_complete` from this parent batch — each worker owns its task completion. If a failed task left no summary, call `gsd_summary_save` with `blocker_discovered: true`.",
  "execute-task":
    "Complete only this task via `gsd_task_complete`. Do not call `gsd_slice_complete`, `gsd_validate_milestone`, or `gsd_complete_milestone` — the orchestrator owns phase transitions.",
  "validate-milestone":
    "Dispatch reviewer subagents in parallel, then persist the verdict via `gsd_validate_milestone`. Do not query `.gsd/gsd.db` directly — use `gsd_milestone_status` and inlined context.",
  "complete-milestone":
    "Persist completion only through `gsd_complete_milestone` after verification passes. Do not query `.gsd/gsd.db` directly. Do not write `.gsd/PROJECT.md` or `.gsd/REQUIREMENTS.md` by hand — use `gsd_summary_save` and `gsd_requirement_update`.",
  "replan-slice":
    "Persist replans through `gsd_replan_slice` only. Do not edit `PLAN.md` or task plans directly.",
  "plan-slice":
    "Persist planning through `gsd_plan_slice` only. Dispatch subagents only to **scout** or **planner** for reconnaissance — not implementation agents. Do not edit user source files outside `.gsd/**`.",
  "refine-slice":
    "Persist refinements through `gsd_plan_slice` only. Dispatch subagents only to **scout** or **planner**. Do not edit user source files outside `.gsd/**`.",
  "plan-milestone":
    "Persist milestone planning through `gsd_plan_milestone` / `gsd_plan_slice`. Do not edit user source files outside `.gsd/**`.",
  "research-slice":
    "Dispatch subagents only to **scout** or **planner** for reconnaissance. Do not edit user source files outside `.gsd/**`.",
};

function guidanceForToolsPolicy(policy: ToolsPolicy): string | null {
  switch (policy.mode) {
    case "planning":
      return "Writes are restricted to `.gsd/**` under the working directory — do not edit user source files. `bash` is limited to read-only investigation commands. Do not dispatch subagents. For human elicitation, use workflow MCP `ask_user_questions` when available — not native `AskUserQuestion`.";
    case "planning-dispatch": {
      const agents = policy.allowedSubagents.map((agent) => `**${agent}**`).join(", ");
      return `Writes are restricted to \`.gsd/**\`. Dispatch subagents only to: ${agents}. Do not edit user source files.`;
    }
    case "docs":
      return "Writes are restricted to `.gsd/**` and project documentation paths (`docs/`, `README*`, `CHANGELOG.md`, root `*.md`). Do not edit application source.";
    case "verification": {
      const subagentLine = policy.allowedSubagents?.length
        ? ` Dispatch subagents only to: ${policy.allowedSubagents.map((agent) => `**${agent}**`).join(", ")}.`
        : " Do not dispatch subagents.";
      return `\`bash\` is limited to build/test verification commands. Writes restricted to \`.gsd/**\`.${subagentLine}`;
    }
    default:
      return null;
  }
}

function formatForbiddenWorkflowToolsLine(
  unitType: string,
  unitGuidance: string | undefined,
): string | null {
  const forbidden = getUnitToolSurfaceContract(unitType)?.forbiddenGsdTools;
  if (!forbidden) return null;
  const names = Object.keys(forbidden).filter((name) => !unitGuidance?.includes(`\`${name}\``));
  if (names.length === 0) return null;
  return `Do not call ${names.map((name) => `\`${name}\``).join(", ")} in this unit.`;
}

/**
 * Render upfront tool-surface guidance for a unit type. Unknown units and
 * unrestricted (`tools.mode: "all"`) units omit the block unless they have
 * unit-specific closeout guidance registered above.
 */
export function composeToolSurfaceInstructions(
  unitType: string,
  opts: ComposeToolSurfaceInstructionOptions,
): string {
  const manifest = resolveManifest(unitType);
  if (!manifest) return "";

  const unitGuidance = TOOL_SURFACE_GUIDANCE_BY_UNIT[unitType];
  const policyGuidance = unitGuidance ? null : guidanceForToolsPolicy(manifest.tools);
  const forbiddenLine = formatForbiddenWorkflowToolsLine(unitType, unitGuidance);
  const parts = [unitGuidance, policyGuidance, forbiddenLine].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0) return "";

  const body = parts.join(" ");
  if (opts.renderMode === "nested") {
    return `Tool surface: ${body}`;
  }

  return ["## Tool Surface", "", body].join("\n");
}

// ─── v2 surface (#4924) ───────────────────────────────────────────────────

/**
 * Resolver for excerpt-class artifacts. Returns the compact block body
 * (per-unit excerpt rendering — e.g. `buildSliceSummaryExcerpt` for the
 * complete-milestone closer) or `null` to omit. Mirrors `ArtifactResolver`
 * shape so consumers can reuse the same registry pattern.
 */
export type ExcerptResolver = (key: ArtifactKey) => Promise<string | null>;

/**
 * Inputs to the v2 composer entrypoint. The base context is required;
 * each resolver/registry is optional and absent ones are treated as
 * "manifest declares no entries of that class for this unit."
 */
export interface ComposeUnitContextOptions {
  readonly base: BaseResolverContext;
  readonly resolveArtifact?: ArtifactResolver;
  readonly resolveExcerpt?: ExcerptResolver;
  readonly computed?: ComputedArtifactRegistry;
}

/**
 * Composer output. Kept structured (rather than a single joined string)
 * because some builders need to splice the prepend block above their own
 * preamble while keeping the main context block in its existing position.
 *
 * Both fields are joined with the in-tree `\n\n---\n\n` separator. Empty
 * string means "no content for this section" — callers branch on truthy
 * to decide whether to render any wrapper headers.
 */
export interface ComposedUnitContext {
  readonly prepend: string;
  readonly inline: string;
}

export type UnitContextBlockMode = "prepend" | "inline" | "excerpt" | "computed";

export interface ComposedUnitContextBlock {
  readonly key: string;
  readonly mode: UnitContextBlockMode;
  readonly body: string;
}

export interface ComposedContractedUnitContext extends ComposedUnitContext {
  readonly blocks: readonly ComposedUnitContextBlock[];
  readonly onDemand: readonly ArtifactKey[];
}

const SECTION_SEPARATOR = "\n\n---\n\n";

interface UnitContextCompositionContract {
  readonly unitType: string;
  readonly artifacts: {
    readonly inline: readonly ArtifactKey[];
    readonly excerpt: readonly ArtifactKey[];
    readonly onDemand: readonly ArtifactKey[];
    readonly computed: readonly ComputedArtifactId[];
    readonly prepend: readonly ComputedArtifactId[];
  };
}

/**
 * Compose all manifest-declared context for a unit type using the v2
 * surface. Walks `prepend` first (computed-only), then the `inline` list
 * (static keys via `resolveArtifact`), then `excerpt` (via `resolveExcerpt`),
 * then `artifacts.computed` (via the typed registry). Order within each
 * section follows the manifest's declared sequence.
 *
 * Unknown unit types return empty strings for both sections — callers can
 * fall back to existing imperative wiring without a special case.
 *
 * Resolver / registry omissions: if the manifest declares an entry but no
 * resolver / registry entry is provided, the composer skips it silently.
 * This matches the v1 contract where a null body is a no-op, and lets
 * partial migrations land without forcing every consumer to register
 * every artifact class up-front.
 */
export async function composeUnitContext(
  unitType: string,
  opts: ComposeUnitContextOptions,
): Promise<ComposedUnitContext> {
  const manifest: UnitContextManifest | null = resolveManifest(unitType);
  if (!manifest) return { prepend: "", inline: "" };

  const composed = await composeDeclaredUnitContext({
    unitType,
    artifacts: {
      inline: manifest.artifacts.inline,
      excerpt: manifest.artifacts.excerpt,
      onDemand: manifest.artifacts.onDemand,
      computed: manifest.artifacts.computed ?? [],
      prepend: manifest.prepend ?? [],
    },
  }, opts);
  return {
    prepend: composed.prepend,
    inline: composed.inline,
  };
}

export async function composeContractedUnitContext(
  contract: UnitPromptContextContract,
  opts: ComposeUnitContextOptions,
): Promise<ComposedContractedUnitContext> {
  return composeDeclaredUnitContext(contract, opts);
}

async function composeDeclaredUnitContext(
  contract: UnitContextCompositionContract,
  opts: ComposeUnitContextOptions,
): Promise<ComposedContractedUnitContext> {
  // Single-source `unitType`: contract/manifest selection comes from the
  // function arg, but computed builders read it from `base.unitType`.
  // Normalize here so every builder sees the same Unit identity.
  const normalizedOpts: ComposeUnitContextOptions = {
    ...opts,
    base: { ...opts.base, unitType: contract.unitType },
  };

  const prependBlocks = await runComputedBlocks(
    contract.artifacts.prepend,
    normalizedOpts,
    "prepend",
  );
  const inlineBlocks: ComposedUnitContextBlock[] = [];

  for (const key of contract.artifacts.inline) {
    if (!normalizedOpts.resolveArtifact) break;
    const body = await normalizedOpts.resolveArtifact(key);
    if (body && body.length > 0) {
      inlineBlocks.push({ key, mode: "inline", body });
    }
  }
  for (const key of contract.artifacts.excerpt) {
    if (!normalizedOpts.resolveExcerpt) break;
    const body = await normalizedOpts.resolveExcerpt(key);
    if (body && body.length > 0) {
      inlineBlocks.push({ key, mode: "excerpt", body });
    }
  }
  inlineBlocks.push(...await runComputedBlocks(
    contract.artifacts.computed,
    normalizedOpts,
    "computed",
  ));

  return {
    prepend: prependBlocks.map((block) => block.body).join(SECTION_SEPARATOR),
    inline: inlineBlocks.map((block) => block.body).join(SECTION_SEPARATOR),
    blocks: [...prependBlocks, ...inlineBlocks],
    onDemand: contract.artifacts.onDemand,
  };
}

/**
 * Invoke the registered builder for each declared computed id, in order.
 * Missing registry entries (manifest declares the id but caller didn't
 * register it) are skipped silently — see composeUnitContext rationale.
 */
async function runComputedBlocks(
  ids: readonly ComputedArtifactId[],
  opts: ComposeUnitContextOptions,
  mode: Extract<UnitContextBlockMode, "prepend" | "computed">,
): Promise<ComposedUnitContextBlock[]> {
  if (ids.length === 0 || !opts.computed) return [];
  // Type safety lives at the registration boundary (caller-supplied
  // `computed` is typed against ComputedArtifactInputs[K] per id). Inside
  // the composer we only dispatch — view the registry through a widened
  // local shape so the loop compiles when the registry is empty (which
  // it is in the v2-contract foundation PR before any computed ids are
  // registered, making `keyof ComputedArtifactInputs` resolve to `never`).
  type AnyEntry = {
    build: (inputs: unknown, base: BaseResolverContext) => Promise<string | null>;
    inputs: unknown;
  };
  const registry = opts.computed as Record<string, AnyEntry | undefined>;
  const out: ComposedUnitContextBlock[] = [];
  for (const id of ids) {
    const entry = registry[id];
    if (!entry) continue;
    const body = await entry.build(entry.inputs, opts.base);
    if (body && body.length > 0) {
      out.push({ key: id, mode, body });
    }
  }
  return out;
}
