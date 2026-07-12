# Per-Phase Thinking Level

Model choice and reasoning effort are separate controls. GSD already routes the *model* per phase (`research`, `planning`, `discuss`, `execution`, `execution_simple`, `completion`, `validation`, `subagent`, `uat`) but the *thinking level* is effectively session-wide across a long `/gsd auto` run. This ADR adds per-phase thinking level configuration alongside the existing per-phase model selection, extending ADR-004's capability-aware routing into the reasoning dimension.

## Decision

Thinking travels with the model it is configured against. The `(model, thinking)` pair is resolved together at every layer — config, resolution, sibling fallback, and dispatch — so a phase never runs one phase's model at another phase's reasoning effort.

**Scope:** the eight main-loop buckets only — `research`, `planning`, `discuss`, `execution`, `execution_simple`, `completion`, `validation`, `uat`. The `subagent` bucket is deliberately excluded (see below).

**Config (hybrid).** Thinking is expressible two ways: inline as `models.<phase>.thinking` (an optional field on `GSDPhaseModelConfig`) and as a separate per-phase `thinking:` map. The legacy bare-string model form cannot carry thinking; a phase that wants it uses the object form — the same rule that already governs `fallbacks`. No scalar global default; "everything high except execution" is expressed by listing phases.

**Resolution ladder, per phase, resolved independently (project files override global files; within a file, inline overrides block):**

1. project `models.<phase>.thinking`
2. project `thinking.<phase>`
3. global `models.<phase>.thinking`
4. global `thinking.<phase>`
5. *(phase unset)* sibling bucket via the existing model-fallback chain (`discuss→planning`, `execution_simple→execution`, `validation→planning`), taking the sibling's thinking as part of the `(model, thinking)` pair
6. session level (`/model`)
7. `DEFAULT_THINKING_LEVEL` (`medium`)

The result is then floored up, then capability-clamped down, then applied: **resolve → floor → clamp → apply.**

**Floor punch-through.** The measured `execute-task` thinking floor (raises to `medium`, because low/minimal reasoning made the model stop planning edits and thrash — re-reading one file ~49× per task) applies *only* when the level came from rungs 6–7 (session/default). An explicitly configured `execution`/`execution_simple` thinking level (rungs 1–5) bypasses the floor, is honored verbatim, and logs a one-time advisory naming the measured pathology. The floor remains unchanged on the default path, so existing behavior is preserved.

**Capability handling, two checks at two times.** Static, at preference load: the value must be one of `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` and the phase key must be known, else warn (alongside existing bad-model-ID validation). Dynamic, at dispatch: the *resolved* model is not known until after fallbacks and dynamic routing pick one, so the level is run through `clampThinkingLevel` against the chosen model and logged once if it clamped. An unsupported level is never passed to the provider; a config/model mismatch never crashes a unit mid-run.

**Lifecycle and mode.** The level is applied per-dispatch (`applyThinkingLevelForModel`, which both clamps to the resolved model and sets the level) and the captured auto-start baseline is restored after each unit; a phase override never permanently mutates the session level. Explicit phase thinking applies in both interactive `/gsd next` and auto mode — the same gate the explicit per-phase *model* already uses (#3962); it is never part of synthesized dynamic routing. The applied level is surfaced in the routing metadata `selectAndApplyModel` returns.

## Subagent (separate mechanism)

The `subagent` bucket is not applied by the framework like the eight main-loop buckets. Subagents are not dispatched as units; the resolved subagent model is injected into the coordinator prompt as instruction text and forwarded to a pi subprocess via the `subagent` tool's `--model` flag. Honoring `subagent` *thinking* therefore rides a different mechanism — prompt injection + the subagent tool schema + a subprocess flag — rather than the `setThinkingLevel`-at-dispatch path. This was originally split into a follow-up (open-gsd/gsd-pi#508).

**Resolution (#508, implemented).** The pi subprocess CLI already accepts a validated `--thinking <level>` flag, so the follow-up was implemented in the same effort: the `subagent` tool schema gains an optional `thinking` param (top-level, per-task, and per-step), `AgentConfig` frontmatter gains a `thinking` field, `buildSubagentProcessArgs` forwards `--thinking` (override ?? agent default), and `resolveThinkingLevelForUnit("subagent")` is injected into the coordinator prompt alongside the subagent model via a shared `with model: "…" and thinking: "…"` suffix. Capability clamping for subagents happens inside the child process's own dispatch.

## Alternatives considered

- **Thinking inside `models` only (issue Option A)** or **a separate `thinking` block only (Option B).** Hybrid was chosen so thinking can be pinned with or without a model, accepting a defined precedence ladder as the cost.
- **Floor always wins.** Rejected: silently raising an explicitly requested `execution: low` to `medium` makes the feature refuse its headline use case with no feedback. Punch-through-with-advisory honors deliberate intent while keeping the floor on the default path.
- **Pass unsupported levels to the provider (status quo).** Rejected: a mistyped phase/model combo would hard-fail a unit in a long auto run. Clamp-and-log degrades gracefully instead.
- **Independent thinking fallback (no sibling inheritance).** Rejected: it lets `discuss` run `planning`'s model at the session's thinking level — more surprising, not less.
