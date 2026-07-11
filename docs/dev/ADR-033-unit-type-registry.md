<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for the Unit Registry — one declarative descriptor per Unit type; existing tables become derived views. -->

# ADR-033: Unit Registry — One Declaration per Unit Type

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Retained with a scope boundary.** The Unit Registry remains the source for adapter, prompt, phase-routing, and tool metadata. It does not own lifecycle progression, dependency scheduling, claims, recovery, or completion.

**Status:** Accepted
**Date:** 2026-06-10
**Author:** GSD architecture review
**Related:** ADR-015 (Tool Contract module), ADR-026 (per-phase thinking level), CONTEXT.md "Phase (model-routing bucket)"

## Context

### Five parallel tables define "what a Unit type is"

Adding or changing one of the 23 Unit types means editing, by hand, with
nothing checking agreement:

1. `unit-context-manifest.ts:19-41` — `KNOWN_UNIT_TYPES` (the type union's
   source).
2. `unit-context-manifest.ts:38-542` — `UNIT_MANIFESTS` (skills, knowledge,
   memory, budgets per type).
3. `unit-tool-contracts.ts:49-195` — `UNIT_TOOL_CONTRACTS` (allowed /
   required / forbidden tools per type).
4. `auto-unit-tool-scope.ts:18-33` — hand-maintained membership Sets
   (`EXECUTE_TASK_UNIT_TYPES`, `SECTION_CLOSE_GATE_UNIT_TYPES`).
5. `prompts/*.md` (43 files) + `auto-prompts.ts` (4,133 lines, 63
   `buildXxxPrompt()` builders) — the prompt template and its assembly,
   associated by naming convention.

Plus the Phase routing key (Unit → model-routing bucket) consumed by
model selection and ADR-026's `(model, thinking)` resolution.

The interface to the "Unit type" concept is as wide as its implementation —
the definition of a shallow module. The triage synthesis already names the
symptom: "prompt/tool/schema drift causes repeated invalid calls."

### Relation to the Tool Contract module (ADR-015)

ADR-015 decided a Tool Contract module that *compiles* a per-Unit contract
(prompt obligations, allowed tools, schema enums, validation, closeout tools)
before dispatch. That compiler currently has to gather its inputs from the
five tables above. This ADR gives it a single input.

## Decision

### 1. One `UnitDescriptor` per Unit type, in one registry

```ts
// unit-registry.ts
interface UnitDescriptor {
  kind: "primary" | "variant";
  scopeClass: "execute-task" | "section-close" | "standard";
  phaseChain: readonly Phase[] | null;  // model-routing fallback chain (ADR-026)
  promptTemplate?: string;              // direct one-template loadPrompt id
  promptTemplates?: readonly string[];  // verified conditional/composite ids
  toolContract: UnitToolSurfaceContract | null;
}

const UNIT_REGISTRY: Record<UnitType, UnitDescriptor> = { ... };
export type UnitType = keyof typeof UNIT_REGISTRY;
```

### 2. The existing tables become derived views

The same barrel discipline as the `gsd-db.ts` split: import paths stay
stable, implementations become lookups.

- `KNOWN_UNIT_TYPES` → `Object.keys(UNIT_REGISTRY)`.
- `UNIT_TOOL_CONTRACTS` → projections of the registry. `UNIT_MANIFESTS` still
  lives in `unit-context-manifest.ts` but is type-enforced against the
  registry-owned `UnitType`.
- The membership Sets → derived from `scopeClass` (membership is declared on
  the Unit, not maintained in a distant Set).
- Unit→phase routing → `descriptor.phaseChain`, with `null` for labels that
  resolve against session defaults.
- Prompt association → `descriptor.promptTemplate` for direct one-template
  units, or `descriptor.promptTemplates` for verified conditional/composite
  template sets. Composition and the runtime condition that selects a template
  stay in `auto-prompts.ts`.

### 3. Parity becomes one table-driven test

One test iterates the registry and asserts: direct and verified conditional
prompt templates exist, tool contracts reference only registered tools,
derived scope Sets match the registry, and every Unit maps to the expected
Phase chain. The current possibility — a Unit type present in three tables and
missing from the fourth — becomes unrepresentable as each derived view
migrates to the registry.

### 4. What stays out

- Prompt *composition* (context blocks, gate inlining, skill activation)
  stays in `auto-prompts.ts` and its helpers — that is real per-Unit
  behaviour, not declaration.
- Dispatch rules, recovery policy, and the Tool Contract *compiler* are
  consumers of the registry, not residents.

## Consequences

- **Interface shrinks:** for direct one-template Units and verified conditional
  template sets, prompt association, tool surface, scope membership, and routing
  live in one registry row. Prompt composition and manifest data still require
  their existing files.
- **Locality:** a Unit's verified prompt association, tool surface, scope
  membership, and routing change in one diff, reviewable as one unit of
  meaning.
- **Leverage for ADR-015:** the Tool Contract compiler reads one source;
  prompt/policy/schema parity tests collapse into the registry parity test.
- **Migration:** mechanical — introduce the registry with entries copied from
  the five tables, flip each table to a derived view, then delete the
  hand-maintained Sets. No behaviour change at any step.

## Implementation status (updated 2026-07-02)

**Shipped** (`unit-registry.ts` + parity test
`tests/unit-registry.test.ts`):

- The registry owns `UnitType`/`KNOWN_UNIT_TYPES`, the tool contracts, the
  scope-class Sets, direct one-template prompt associations, the verified
  conditional `discuss-milestone` prompt-template set (`discuss`,
  `discuss-headless`, `guided-discuss-milestone`), and the
  unit→phase chain (`phaseChainForUnit` now reads the descriptor;
  `worktree-merge` and `subagent/*` stay as non-Unit fallbacks).
- Migration surfaced real drift the old tables had accumulated, preserved
  explicitly: `discuss-slice` and `execute-task-simple` had contracts and
  Set membership but were missing from `KNOWN_UNIT_TYPES` (now
  `kind: "variant"`); `triage-captures` and `quick-task` had manifests but
  no contract and no phase routing (now `toolContract: null`,
  `phaseChain: null`).

**Deferred:**

- `UNIT_MANIFESTS` data stays in `unit-context-manifest.ts` — it is already
  type-enforced against the registry's `UnitType` (a missing/extra manifest
  is a compile error), so consolidation is locality-only and large.
- Additional conditional/composite prompt-template associations should move only
  when each builder's template choices are verified. Runtime prompt composition
  and selection conditions stay in `auto-prompts.ts`.
