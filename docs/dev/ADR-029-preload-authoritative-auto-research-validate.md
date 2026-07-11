# Preload-Authoritative Auto-Mode Research & Validation

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Amended and retained.** Forwarded evidence, bounded research context, and avoiding redundant surveys remain valid. Workflow context and resume state must derive from a canonical database snapshot; readable artifacts may be evidence references or projections, never lifecycle authority.

The auto-orchestration loop does far too much per unit on small projects. A run trace for a 3-file vanilla-JS app (`index.html`, `script.js`, `styles.css`) showed three pathologies:

- **research-milestone** burned ~115 tool calls across a retry pair (14–19 `gsd_exec` each), re-extracting the same three files at many granularities (~80–100% redundant), and one unit hit a hard timeout whose retry run repeated **100%** of the first run's commands.
- **validate-milestone** roughly doubled every other unit. The orchestrator's own activity log is efficient and artifact-based (no test re-runs); the extra volume came from its **3 parallel `subagent` reviewers**, each independently re-reading `REQUIREMENTS.md`, the roadmap, and per-slice `SUMMARY`/`ASSESSMENT` files that the orchestrator had already preloaded and excerpted.
- A timed-out research unit **re-ran from scratch** instead of resuming.

This is the auto-mode counterpart to the guided-discuss "too much upfront survey" problem fixed in `ADR-028-preload-authoritative-discuss.md`. All three pathologies share one shape: *context is available cheaply, but the agent re-derives it anyway.*

## Root causes

1. **research-milestone has no codebase preload, but its prompt licenses an open-ended survey.** `buildResearchMilestonePrompt` inlined only the milestone `CONTEXT.md`, the Research template, and scoped KNOWLEDGE — zero code reality — under a "preloaded — do not re-read" banner, while step 3 of `research-milestone.md` told the agent to "Explore relevant code… use `rg`, `find`… `scout`." The exact ADR-028 contradiction. The manifest's `codebaseMap: true` flag for the unit was declared but never consumed (a dead flag), and research received none of the **Project Classification** size signal that `plan-milestone` gets.
2. **validate reviewers re-survey.** The orchestrator preloads the roadmap, slice `SUMMARY`/`ASSESSMENT` excerpts, verification classes, and requirements, but the three literal reviewer task strings each instruct the reviewer to `Read` those same files. The preload was never forwarded into the reviewer tasks.
3. **Research is not durable, so restart = redo.** Research persists nothing until the terminal `gsd_summary_save`. Hard-timeout recovery sends one steering message, and a re-dispatch builds a fresh prompt with no memory of partial work; the only durability check is an all-or-nothing `existsSync(RESEARCH)`.

## Decision

The preloaded context is authoritative for current code reality, project size, and prior evidence. Auto-mode research and validation ground in it rather than re-deriving it.

- **Grounded Research (no upfront survey).** `buildResearchMilestonePrompt` now inlines a bounded **Codebase Snapshot** (reusing the in-process, ~millisecond `analyzeCodebase` / `formatCodebaseBrief` machinery that powers the discuss Preparation Snapshot) and the **Project Classification** size signal (`formatProjectClassificationForPlanning(classifyProject(base))`, the same block `plan-milestone` uses). The snapshot injection is gated on the manifest's previously-dead `codebaseMap` flag — giving it meaning — and honors the `discuss_preparation === false` opt-out. `research-milestone.md` step 3 is reframed from an open-ended survey to grounded research: treat the snapshot and classification as authoritative, do not re-survey the tree, read a specific file only when a research question hinges on it, and match depth to the classified project size. `resolve_library`/docs lookups remain permitted and bounded.
- **Forwarded Validation Evidence.** `validate-milestone.md` instructs the orchestrator to embed its already-preloaded excerpts (roadmap, slice summaries/assessments, requirements) into each reviewer's `subagent` task, and each of Reviewer A/B/C is told to use that evidence and read a full file only when its excerpt is missing, truncated, or internally inconsistent — the same on-demand escape hatch as ADR-028. The three-reviewer parallel architecture, verdict synthesis, and verification-class contract are unchanged.
- **Research Resume (lightweight).** When a prior attempt left durable output — a partial RESEARCH artifact and/or the research phase anchor — `buildResearchMilestonePrompt` inlines it under a "continue, do not redo" banner, and the prompt instructs research to save to RESEARCH incrementally so an interruption leaves a resumable draft. No new mid-flight checkpoint state machine: the partial artifact and the existing phase anchor are the durable signals.

These are captured in `CONTEXT.md` as the **Grounded Research (no upfront survey)**, **Forwarded Validation Evidence**, and **Research Resume (lightweight)** invariants, alongside the ADR-028 terms they extend.

## Consequences

- Research on a small project grounds on a cheap bounded snapshot plus a size signal instead of an unbounded `rg`/`find`/`scout` survey, removing the dominant source of redundant `gsd_exec` calls. The Codebase Snapshot is bounded (`formatCodebaseBrief` caps its length) and runs in-process in milliseconds — it is not a slow path.
- Validate's three reviewers consume the orchestrator's preloaded excerpts rather than re-reading the same artifacts up to three times, cutting validation's call volume while preserving independent review and the verdict contract.
- A re-dispatched research unit extends prior partial work rather than repeating every command; incremental saves make the timeout-recovery "write whatever you have" steer actually useful on the next attempt.
- On-demand reads remain available everywhere, so a question or verdict that genuinely hinges on a file is never blocked — the agent reads that file rather than surveying or re-surveying.
- The `discuss_preparation: false` preference disables the research Codebase Snapshot too, for users who want a pure-preload research unit.
- Prompt-contract and builder-level tests assert the grounded-research wording (and the absence of the survey license), the forwarded-evidence reviewer wording, classification/snapshot presence, the snapshot opt-out, and the resume block's presence/absence.

## Alternatives Considered

- **Collapse validate-milestone to a single reviewer.** Rejected: it yields the biggest raw call reduction but discards the independent-review architecture and breaks the "parallel reviewers" contract. Forwarding the preload achieves the redundancy win while preserving three independent perspectives.
- **Full checkpoint/resume for research** (durable mid-flight checkpoint written at each substantive finding, with explicit resume-from-checkpoint logic in dispatch and timeout-recovery, plus a partial-vs-complete artifact distinction so a partial RESEARCH no longer short-circuits dispatch). Rejected for now as disproportionate to the problem — more code, more state, larger surface. The lightweight resume (inline prior partial + anchor, save incrementally) captures most of the benefit with no new state machine. The dispatch short-circuit on any present RESEARCH is the known limitation: lightweight resume helps most when research is re-dispatched with a partial draft present (e.g. after a milestone reopen or manual re-run).
- **Gate research grounding on an empty preload / drop the snapshot.** Rejected for the same reasons as ADR-028: the uniform invariant (snapshot + classification is always enough to ground research, never survey) is simpler than a conditional slow path, and the on-demand read handles the thin-snapshot case. The snapshot is cheap and bounded; the slowness is the open-ended survey, not the snapshot.
