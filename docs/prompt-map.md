# gsd-pi Prompt System Map

> Complete dependency graph of all prompts, how they're loaded, assembled, dispatched, and how they chain into each other.

---

## 1. Pipeline Overview

```
User / gsd auto
      │
      ▼
 auto.ts  ──── reads STATE.md ──► GSDState
      │
      ▼
 auto-dispatch.ts
   DISPATCH_RULES[]  (first match wins)
      │
      ├── resolves → unitType + promptBuilder + backgroundable flag
      │
      ▼
 auto-prompts.ts
   buildXxxPrompt()
      │
      ├── loadPrompt(name, vars)          ← prompt-loader.ts (template cache)
      ├── composeInlinedContext()         ← unit-context-composer.ts
      ├── reorderForCaching()             ← prompt-ordering.ts
      └── filterSkillsByManifest()        ← skill-manifest.ts
      │
      ▼
 Pi SDK session.run(prompt)
      │
      ▼
 LLM executes → calls gsd_* tools → writes artifacts → STATE.md updated
      │
      ▼
 Loop back to auto.ts
```

---

## 2. Prompt Loading Infrastructure

| File | Role |
|------|------|
| `prompt-loader.ts` | Reads all `prompts/*.md` at startup into `templateCache`. Substitutes `{{varName}}` placeholders. Falls back to lazy read if cache misses. Preloads `templatesDir`, `taskSummaryTemplatePath`, `skillActivation` as defaults. |
| `prompt-ordering.ts` | Splits assembled prompt into `## sections`, classifies each as `static / semi-static / dynamic`, reorders to maximize LLM cache prefix stability. |
| `prompt-validation.ts` | Validates that all `{{vars}}` declared in a template have values provided before substitution fires. |
| `prompt-cache-optimizer.ts` | Tracks cache hit/miss rates per prompt; adjusts section ordering hints over time. |

**Template resolution priority** (highest wins):
1. `~/.agents/gsd/prompts/` (user-local, written by `initResources()`)
2. Module-relative `prompts/` (npm package fallback)

---

## 3. Shared Injected Variables (every prompt gets these for free)

```
{{templatesDir}}              path to templates/ dir
{{planTemplatePath}}          templates/plan.md
{{taskPlanTemplatePath}}      templates/task-plan.md
{{taskSummaryTemplatePath}}   templates/task-summary.md
{{skillActivation}}           standard skill-loading instruction block
```

---

## 4. Context Composition Stack

Every `buildXxxPrompt()` call assembles context via these layers (in order):

```
Preamble  (system.md rules, skill activation block)
    │
Static section
    ├── PROJECT.md
    ├── REQUIREMENTS.md
    └── DECISIONS.md

Semi-static section
    ├── KNOWLEDGE.md  (manual rules only — patterns/lessons stripped; ADR-013 Stage 2c)
    ├── memories      (prompt-relevant patterns, gotchas, decisions — canonical for patterns/lessons)
    ├── PREFERENCES.md
    └── Prior slice/milestone RESEARCH.md

Dynamic section
    ├── Active NN-CONTEXT.md
    ├── Active NN-MM-PLAN.md (slice plan + embedded task planning)
    ├── Task summary from prior run (resume)
    ├── Carry-forward captures
    └── Gate list to close
```

Before this map is assembled, `buildBeforeAgentStartResult()` runs the
session-start KNOWLEDGE backfill/projection path and then calls
`loadKnowledgeBlock()`. That helper inlines only manual Rules from the project
`.gsd/KNOWLEDGE.md` file; projected patterns and lessons are supplied through
the memories layer.

Budget enforcement: `context-budget.ts` computes `preambleBudgetChars`, `summaryBudgetChars`, `verificationBudgetChars` from the model's context window. Sections are truncated at markdown section boundaries, not mid-sentence.

### 4a. Tool Policy Modes

Auto-mode unit manifests declare a runtime-enforced `tools` policy. `write-gate.ts` checks the active unit before each tool call.

| Mode | Allowed surface |
|------|-----------------|
| `all` | Read, source writes, Bash, and subagents. Used by execution units that run in milestone worktrees. |
| `read-only` | Read tools only. No shell, writes, or subagents. |
| `planning` | Read tools, `.gsd/**` writes, and safe read-only Bash. No subagents. |
| `planning-dispatch` | Same as `planning`, plus subagents explicitly listed by the manifest. |
| `docs` | Same as `planning`, plus writes to configured documentation globs. No subagents. |
| `verification` | Read tools and Bash for build/test verification commands such as `npm run build`, `npm test`, `pnpm test`, `vitest`, `jest`, and `go test`; writes remain restricted to `.gsd/**`, and subagents are blocked. |

---

## 5. The 43 Prompt Files — Full Inventory

### 5a. System & Foundation

| Prompt | Purpose | Reads | Writes |
|--------|---------|-------|--------|
| `system.md` | Hard rules, isolation model, naming conventions, skills table, execution heuristics. Bundled into every prompt as preamble. | — | — |
| `heal-skill.md` | Post-unit skill drift analysis. Never edits skill files directly. | Skill activation block | `.gsd/skill-review-queue.md` |

### 5b. Project Setup Flow (runs once, sequentially)

```
guided-workflow-preferences
         │
         ▼
guided-discuss-project
         │
         ▼
guided-discuss-requirements
         │
         ▼
research-decision  (gate: deep mode opt-in)
         │
         ▼
guided-research-project  (deep mode only — 4 parallel subagents)
```

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `guided-workflow-preferences.md` | Write `.gsd/PREFERENCES.md` with defaults; pre-seeds `research-decision.json`. No user questions. | — |
| `guided-discuss-project.md` | Interview-style project scoping. Classifies project shape (tiny/small/medium/large). | `ask_user_questions`, `gsd_summary_save(PROJECT)` |
| `guided-discuss-requirements.md` | Interview-style requirements capture. | `ask_user_questions`, `gsd_requirement_save`, `gsd_summary_save(REQUIREMENTS)` |
| `guided-research-decision.md` | Single fixed-question gate: opt into deep research or proceed lean. | `ask_user_questions` → writes `runtime/research-decision.json` |
| `guided-research-project.md` | Spawns 4 parallel scout subagents (stack, features, architecture, pitfalls). Headless. | `subagent` × 4 |

### 5c. Milestone Planning Flow

```
discuss-milestone  OR  discuss-headless  (headless = no questions)
         │
         ▼
research-milestone  (optional, based on complexity)
         │
         ▼
plan-milestone
         │
         ▼
parallel-research-slices  (all slices at once)
         │
         ▼
plan-slice  (per slice, sequential)
```

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `discuss.md` | Interactive milestone discussion. Layered Q&A: Scope → Architecture → Error States → Quality Bar. | `ask_user_questions`, `gsd_summary_save(CONTEXT)` |
| `guided-discuss-milestone.md` | Same as discuss.md but interview-driven, with draft saves. | `ask_user_questions`, `gsd_summary_save(CONTEXT)` |
| `discuss-headless.md` | Create milestone CONTEXT from spec with no user interaction. | `gsd_plan_milestone`, `gsd_decision_save` |
| `research-milestone.md` | Strategic research before planning. Narrates findings. | `gsd_summary_save(RESEARCH)` |
| `plan-milestone.md` | Decompose milestone into slices. Plans first slice inline if single-slice. | `gsd_plan_milestone`, `gsd_plan_slice`, `gsd_plan_task`, `gsd_decision_save` |
| `parallel-research-slices.md` | Spawn one scout subagent per slice simultaneously. Retries once on failure. | `subagent` × N |
| `plan-slice.md` | Decompose single slice into tasks. Progressive planning: sketches for S02+. | `memory_query`, `gsd_plan_slice`, `gsd_plan_task` |
| `refine-slice.md` | Expand sketched slice plan into full task breakdown. | `gsd_plan_slice` |
| `guided-discuss-slice.md` | Interview-driven slice scoping. | `ask_user_questions`, `gsd_summary_save(CONTEXT)` |
| `guided-research-slice.md` | Scout a slice. | `memory_query`, `gsd_summary_save(RESEARCH)` |
| `research-slice.md` | Research a slice (non-guided, auto-mode). | `memory_query`, `gsd_summary_save(RESEARCH)` |

### 5d. Execution Flow

```
reactive-execute  (≥3 ready tasks → parallel)
    OR
execute-task  (single task → sequential)
         │
         ▼
guided-resume-task  (if task was interrupted)
```

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `execute-task.md` | Execute a single task. Inlines full context stack. | `memory_query`, `gsd_task_complete` |
| `reactive-execute.md` | Dispatch all ready tasks in parallel subagents. When batch summaries remain missing after retries, writes a diagnostic slice blocker; task lifecycle still follows DB Attempt/recovery authority, not summary-file presence. | `subagent` × N |
| `guided-resume-task.md` | Resume interrupted task. Reads `{{sliceId}}-CONTINUE.md` for continuation context. | `gsd_task_complete` |
| `quick-task.md` | Lightweight task outside milestone structure. No DB tools. | writes `{{summaryPath}}` directly |

### 5e. Quality Gates

```
gate-evaluate  (parallel gate subagents)

complete-slice  (writes the slice summary and UAT spec)
         │
         ▼
run-uat  (per-slice user acceptance assessment)
         │
         ▼
validate-milestone  (3 parallel reviewers after all slices close)
```

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `gate-evaluate.md` | Spawn one subagent per quality gate in parallel. Verifies `gsd_save_gate_result` called. | `subagent` × N |
| `validate-milestone.md` | 3 parallel reviewers: (A) requirements, (B) integration, (C) acceptance. | `subagent` × 3, `gsd_validate_milestone` |
| `run-uat.md` | Execute UAT. Modes: artifact-driven, browser-executable, runtime-executable, live-runtime, mixed, human-experience. Runs under `verification` tools policy with UAT-owned execution plus safe read-only/browser inspection tools. | `gsd_uat_result_save`, read-only/browser tools |

`run-uat` completion verification requires a canonical verdict in the written `S##-ASSESSMENT.md` (for example `verdict: PASS | FAIL | PARTIAL`). A pre-existing assessment file without `verdict` does not satisfy artifact verification.
`src/resources/extensions/gsd/uat-policy.ts` is the shared policy source for UAT mode classification, browser-tool requirements, dispatch decisions, and result-save mode validation.

### 5f. Completion Flow

```
complete-slice
         │
         ▼
reassess-roadmap  (after each slice)
         │
         ▼
complete-milestone
```

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `complete-slice.md` | Close slice after tasks pass. Compress summary; may reopen/replan pending task rework before closeout. | `gsd_slice_complete`, `gsd_task_reopen`, `gsd_replan_slice`, `gsd_replan_task`, `gsd_rework_brief_save`, `gsd_requirement_update` |
| `reassess-roadmap.md` | Review roadmap post-slice. Validates success-criterion coverage. | `gsd_reassess_roadmap`, `gsd_requirement_update` |
| `complete-milestone.md` | Close milestone. Persist to DB. | `gsd_complete_milestone`, `gsd_requirement_update`, `capture_thought` |

### 5g. Maintenance & Repair

| Prompt | Purpose | Key Tools Called |
|--------|---------|-----------------|
| `replan-slice.md` | Replan after blocker discovered mid-slice. Preserves completed tasks. | `gsd_replan_slice` |
| `rethink.md` | Reorder, park, unpark, skip, or discard milestones that have no adopted canonical lifecycle history. Adopted milestones must be parked instead. | `gsd_skip_slice`, writes `QUEUE-ORDER.json` as the durable reorder contract; state derivation mirrors it into DB sequence |
| `worktree-merge.md` | Merge a worktree branch into a target branch from the main tree. | git merge (main tree CWD) |
| `reassess-roadmap.md` | *(see Completion Flow above)* | — |
| `rewrite-docs.md` | Apply OVERRIDES.md changes across all planning docs. | — |
| `review-migration.md` | Audit `.planning → .gsd` migration correctness. | `deriveState` |
| `doctor-heal.md` | Repair broken GSD artifacts (summaries, UAT, CONTEXT). | — |
| `scan.md` | Codebase scan → STACK.md, INTEGRATIONS.md, ARCHITECTURE.md. No tool calls. | writes `{{outputDir}}` |
| `forensics.md` | Debug GSD engine failures. Map failures to source files. | reads activity logs, journal, metrics |
| `debug-diagnose.md` | Root-cause analysis for reported bugs. | `capture_thought`, `memory_query` |
| `debug-session-manager.md` | Manage debug session with checkpoint protocol. Structured return headers. | — |
| `add-tests.md` | Generate tests for completed slices. | skill activation |
| `triage-captures.md` | Classify user thoughts captured with `capture_thought`. | `ask_user_questions`, updates `CAPTURES.md` |
| `queue.md` | Add future milestones to queue. | `gsd_milestone_generate_id`, `gsd_summary_save(CONTEXT)`, updates `QUEUE.md` |

### 5h. Workflow Execution (one-off workflows, not milestone-driven)

| Prompt | Purpose | Notes |
|--------|---------|-------|
| `workflow-start.md` | Execute a templated workflow (phases, complexity gates, artifact directory). | Follows phases in order, writes artifacts, atomic commits |
| `workflow-oneshot.md` | Execute a oneshot workflow (no STATE.json). | prompt-only, no scaffolding |

---

## 6. Full Dependency Graph

### 6a. Sequential Chains

```
STATE.md
  └─► auto.ts
        └─► auto-dispatch.ts (DISPATCH_RULES, first match)
              │
              ├── [setup] guided-workflow-preferences
              │              │ writes PREFERENCES.md
              │              │
              ├── [setup] guided-discuss-project
              │              │ writes PROJECT.md
              │              │
              ├── [setup] guided-discuss-requirements
              │              │ writes REQUIREMENTS.md
              │              │
              ├── [gate]  guided-research-decision
              │              │ writes research-decision.json
              │              │
              ├── [deep]  guided-research-project ──► 4× subagent
              │              │ writes RESEARCH artifacts
              │              │
              ├── [ms]    discuss / guided-discuss-milestone / discuss-headless
              │              │ writes M##-CONTEXT.md
              │              │
              ├── [ms]    research-milestone
              │              │ writes M##-RESEARCH.md
              │              │
              ├── [ms]    plan-milestone
              │              │ writes NN-ROADMAP.md + optional first NN-MM-PLAN.md
              │              │
              ├── [sl]    parallel-research-slices ──► N× subagent (research-slice)
              │              │ writes S##-RESEARCH.md
              │              │
              ├── [sl]    guided-discuss-slice
              │              │ writes S##-CONTEXT.md
              │              │
              ├── [sl]    plan-slice / refine-slice
              │              │ writes NN-MM-PLAN.md with embedded task planning
              │              │
              ├── [task]  reactive-execute ──────────► N× subagent (execute-task)
              │    OR                                     │ writes S##-T##-SUMMARY.md or S##-REACTIVE-BLOCKER.md
              ├── [task]  execute-task                    │
              │              │ reads DB task plan + NN-MM-PLAN.md excerpt
              │              │ writes S##-T##-SUMMARY.md
              │              │
              ├── [gate]  gate-evaluate ────────────► N× subagent
              │              │ writes gate results
              │              │
              ├── [sl]    complete-slice
              │              │ writes S##-SUMMARY.md and S##-UAT.md
              │              │
              ├── [sl]    run-uat
              │              │ writes S##-ASSESSMENT.md
              │              │
              ├── [ms]    reassess-roadmap
              │              │ updates M##-ROADMAP.md
              │              │
              ├── [ms]    validate-milestone ────────► 3× subagent
              │              │ writes validation verdict
              │              │
              └── [ms]    complete-milestone
                             │ writes M##-SUMMARY.md
                             └─► loop back to next milestone
```

### 6b. Parallel Dispatch Map

| Orchestrator Prompt | Subagents Spawned | How Many |
|--------------------|-------------------|---------|
| `guided-research-project.md` | stack scout, features scout, architecture scout, pitfalls scout | 4 (fixed) |
| `parallel-research-slices.md` | `research-slice` (one per slice) | N slices |
| `reactive-execute.md` | `execute-task` (one per ready task) | N ready tasks |
| `gate-evaluate.md` | one gate evaluator per gate | N gates |
| `validate-milestone.md` | reviewer-A (requirements), reviewer-B (integration), reviewer-C (acceptance) | 3 (fixed) |

### 6c. Recovery / Detour Chains

```
execute-task  ──[interrupted]──► guided-resume-task
                                    reads {{sliceId}}-CONTINUE.md

execute-task  ──[blocker]──────► replan-slice
                                    rewrites incomplete tasks only

plan-milestone ──[any]─────────► rethink
                                    reorders / parks / discards milestones

auto.ts ────────[drift]────────► heal-skill
                                    writes skill-review-queue.md

auto.ts ────────[doctor]───────► doctor-heal
                                    repairs CONTEXT, UAT, SUMMARY artifacts

any prompt ─────[failure]──────► forensics / debug-diagnose / debug-session-manager
```

---

## 7. Artifact Flow (What Each Phase Writes)

```
Phase                   Artifact Written
─────────────────────────────────────────────────────
guided-workflow-preferences  →  .gsd/PREFERENCES.md
guided-discuss-project       →  .gsd/PROJECT.md
guided-discuss-requirements  →  .gsd/REQUIREMENTS.md
guided-research-decision     →  .gsd/runtime/research-decision.json
guided-research-project      →  .gsd/phases/<NN-slug>/<NN>-RESEARCH.md (×4 aspects)

discuss / guided-discuss-milestone  →  .gsd/phases/<NN-slug>/<NN>-CONTEXT.md
research-milestone           →  .gsd/phases/<NN-slug>/<NN>-RESEARCH.md
plan-milestone               →  .gsd/phases/<NN-slug>/<NN>-ROADMAP.md
                                 .gsd/phases/<NN-slug>/<NN>-<MM>-PLAN.md (single-slice fast path)

research-slice               →  .gsd/phases/<NN-slug>/<NN>-<MM>-RESEARCH.md
guided-discuss-slice         →  .gsd/phases/<NN-slug>/<NN>-<MM>-CONTEXT.md
plan-slice / refine-slice    →  .gsd/phases/<NN-slug>/<NN>-<MM>-PLAN.md
                                 (task planning is embedded; no separate task plan file)

execute-task                 →  .gsd/phases/<NN-slug>/S##-T##-SUMMARY.md
gate-evaluate                →  gate results (DB + artifact)
run-uat                      →  .gsd/phases/<NN-slug>/<NN>-<MM>-ASSESSMENT.md
complete-slice               →  .gsd/phases/<NN-slug>/<NN>-<MM>-SUMMARY.md
reassess-roadmap             →  updates <NN>-ROADMAP.md (slice statuses)
validate-milestone           →  validation verdict (DB)
complete-milestone           →  .gsd/phases/<NN-slug>/<NN>-SUMMARY.md

triage-captures              →  .gsd/CAPTURES.md (classification metadata)
queue                        →  .gsd/QUEUE.md, updates PROJECT.md
scan                         →  {{outputDir}}/STACK.md, INTEGRATIONS.md, ARCHITECTURE.md
rewrite-docs                 →  DECISIONS.md, task plans, REQUIREMENTS.md, PROJECT.md
```

---

## 8. Skill System Dependency

```
skill-catalog.ts   (tech-stack → repo + skill names)
       │
       ▼
skill-discovery.ts (resolves installed skills for current project)
       │
       ▼
skill-manifest.ts  (allowlist per unit type)
       │             e.g. plan-milestone → [decompose-into-slices, api-design, tdd, ...]
       │             e.g. execute-task   → wildcard (all skills eligible)
       ▼
{{skillActivation}} placeholder in every prompt
       │
       ▼
LLM sees: "load these skill files and follow their rules for this unit"
```

---

## 9. Tool → DB Write Map

| Tool | Persists To |
|------|------------|
| `gsd_plan_milestone` | atomic Domain Operation receipt/event/outbox/Projection Work, milestone and slice planning rows, canonical lifecycle heads; existing slices cannot be removed here |
| `gsd_plan_slice` | atomic Domain Operation records, slice planning and lifecycle head; tasks only when a non-empty `tasks` payload performs full replacement/update, with removed pending tasks retained as `skipped` / `cancelled` |
| `gsd_plan_task` | atomic Domain Operation records, one task planning row and lifecycle head; embedded task planning in the slice plan projection |
| `gsd_task_complete` | tasks table, S##-T##-SUMMARY.md (legacy T##-SUMMARY.md readable) |
| `gsd_slice_complete` | slices table, S##-SUMMARY.md |
| `gsd_complete_milestone` | milestones table, M##-SUMMARY.md |
| `gsd_validate_milestone` | milestones table (validation verdict) |
| `gsd_reassess_roadmap` | atomic Domain Operation records, assessment and slice planning/lifecycle rows; removed pending slices are retained as `skipped` / `cancelled` |
| `gsd_replan_slice` | atomic Domain Operation records, replan history and task planning/lifecycle rows; removed pending tasks are retained as `skipped` / `cancelled` |
| `gsd_replan_task` | atomic Domain Operation records, one non-terminal task planning/lifecycle row and replan history row |
| `gsd_rework_brief_save` | rework_briefs and rework_brief_findings tables |
| `gsd_skip_slice` | slices table (status = skipped) |
| `gsd_requirement_save` | requirements table |
| `gsd_requirement_update` | requirements table |
| `gsd_summary_save` | artifact files + DB reference |
| `gsd_decision_save` | memories table (`architecture` rows) + DECISIONS.md projection |
| `capture_thought` | memories table; KNOWLEDGE.md projection for Patterns/Lessons |
| `memory_query` | READ — queries memories / memory indexes |
| `ask_user_questions` | blocks until user responds; no DB write |
| `subagent` | spins up child Pi session with given prompt |

---

## 10. Dispatch Rule Priority Order

`auto-dispatch.ts` evaluates 29 rules top-to-bottom, first match wins. Source of
truth is the `DISPATCH_RULES` array in `auto-dispatch.ts`; the canary test
`tests/dispatch-rule-coverage.test.ts` pins the count at 29.

```
Priority  Rule                                          Fires When
────────  ────────────────────────────────────────────  ─────────────────────────
 1        escalating-task → pause-for-escalation        a task escalation is awaiting user review
 2        rewrite-docs (override gate)                  OVERRIDES.md present and unprocessed
 3        execution-entry phase (no context) → discuss  re-entry into a milestone with no CONTEXT
 4        summarizing → complete-slice                  slice in 'summarizing' phase
 5        run-uat (post-completion)                     tasks done, UAT pending
 6        uat-verdict-gate (non-PASS continues)         UAT non-PASS — continue for remediation; final milestone closure still requires PASS sign-off
 7        reassess-roadmap (post-completion)            slice closed, roadmap needs update
 8        needs-discussion → discuss-milestone          milestone explicitly flagged for discussion
 9        deep: workflow-preferences                    deep mode + PREFERENCES.md missing
10        deep: discuss-project                         deep mode + PROJECT artifact missing
11        deep: discuss-requirements                    deep mode + REQUIREMENTS missing
12        deep: research-decision                       deep mode + research decision not made
13        deep: research-project                        deep mode + research approved, files missing
14        pre-planning (no context) → discuss-milestone active milestone, CONTEXT missing
15        pre-planning (no research) → research-mile…   CONTEXT done, RESEARCH missing
16        pre-planning (has research) → plan-milestone  CONTEXT + RESEARCH done, ROADMAP missing
17        planning (require_slice_discussion) → pause   slice flagged for discussion (#3454)
18        planning (multi slices need research) → par…  ROADMAP done, slice RESEARCH missing × ≥2
19        planning (no research) → research-slice       single slice needs RESEARCH
20        refining → refine-slice                       slice is sketch, needs expansion
21        planning → plan-slice                         slice CONTEXT done, PLAN missing
22        evaluating-gates → gate-evaluate              gates pending evaluation
23        replanning-slice → replan-slice               slice in 'replanning' phase
24        executing → reactive-execute (parallel)       ≥3 tasks ready (parallel mode), no reactive blocker
25        executing → execute-task (recover plan)       task plan missing — recover via plan-slice
26        executing → execute-task                      1–2 tasks ready (sequential mode)
27        validating-milestone → validate-milestone     all slices closed, not yet validated
28        completing-milestone → complete-milestone     validated, not yet completed
29        complete → stop                               nothing left to do
```

---

## 11. How to Read the Map

- **Box** = a prompt file (`prompts/X.md`)
- **Arrow →** = "produces" or "writes"
- **Dashed →** = "reads from" 
- **×N** = spawns N parallel subagents each running that prompt
- **[gate]** = requires explicit user confirmation before proceeding
- **DB** = persists to `gsd.db` via a `gsd_*` tool call
- **Headless** = no `ask_user_questions` calls; autonomous judgment
