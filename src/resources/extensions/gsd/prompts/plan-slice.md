You are executing GSD auto-mode.

## UNIT: Plan Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

If any inlined plan, summary, verification command, or prior artifact names an absolute path outside `{{workingDirectory}}`, treat that path as stale context. Convert it to the equivalent relative path under `{{workingDirectory}}` before reading, writing, or executing. If no equivalent path exists under `{{workingDirectory}}`, do not edit or run commands in another checkout; this stale-path safety rule overrides normal planning. Stop without calling `gsd_plan_slice`, and report the stale path as the verification failure.

Relevant context is preloaded; start without re-reading it.

{{inlinedContext}}

### Dependency Slice Summaries

Use Forward Intelligence from dependencies when present.

{{dependencySummaries}}

## Mission

Plan this slice against real code and persist it through the DB-backed tool.

Use `subagent` only under `planning-dispatch` for isolated planning reconnaissance: broad subsystem scouting, unclear decomposition, or current external facts. For external research, dispatch the **scout** agent. Do not dispatch implementation agents.

Before planning, validate roadmap assumptions against code and dependency summaries. If concrete evidence shows downstream slices are wrong, call `gsd_reassess_roadmap` with `sliceChanges.modified`, `sliceChanges.added`, or `sliceChanges.removed`; otherwise keep the roadmap unchanged. Bias toward "roadmap is fine." Completed slices are immutable.

### Source Files

{{sourceFilePaths}}

If slice research is inlined, trust its architectural findings, but verify every concrete file path you place in task `inputs` or `expectedOutput` against the current tree or prior/same-task outputs. Explore enough code to confirm paths, boundaries, and verification. Executors later get only task plans, slice excerpt, and prior summaries, so put required paths, steps, inputs, and outputs in task plans.

{{repoRegistry}}

{{executorContextConstraints}}

## Planning Rules

**Task tool contract:** Every persisted task must also declare `requiredWorkflowTools`; use `[]` for ordinary implementation tasks. Never assign lifecycle mutations such as `gsd_requirement_update` to an execution task. Requirement terminalization belongs to `complete-slice` or `complete-milestone`, and incompatible declarations are rejected before persistence.

1. If requirements are preloaded, identify owned and supporting Active requirements.
2. Call `memory_query` with keywords from the slice title and source files.
3. Use the inlined Output Template sections already present in this prompt. Do not read template files from disk.
4. {{skillActivation}} Record expected executor skills in each task plan's `skills_used` frontmatter.
5. Define slice verification before tasks. Non-trivial slices need real tests or executable assertions; boundary contracts need contract-exercising checks. Tests must not read .gitignore/gitignored paths such as `.gsd/`, `.planning/`, or `.audits/`.
   **Web apps:** when inlined Web App UAT guidance is present, follow it — add Playwright smoke scaffolding on the first UI slice if missing, name localhost preconditions, and plan verification commands that match browser-capable UAT modes at slice closeout.
6. Include Threat Surface (Q3), Requirement Impact (Q4), proof level, observability, integration closure, Failure Modes (Q5), Load Profile (Q6), and Negative Tests (Q7) only where applicable.
7. Right-size tasks. Simple slices can be one task; split only when context, ownership, or verification boundaries justify it.
8. Task `verify` commands must be safe, simple commands. Do not use shell pipes, redirects, semicolons, backticks, command substitution, output trimming, or grep regex alternation with `|`. If multiple checks are needed, create a small test file and run it with `node --test` or a package test script, or use separate simple commands joined only with `&&`. For absence checks, verify a pattern does not exist with `! grep -q 'pattern' file` or `! rg -q 'pattern' file`; do not use `grep -c` or `rg -c` to assert zero matches because count commands exit 1 when they find zero matches, and the verification gate treats that as failure. On Python projects with a `.venv`, `venv`, or active `$VIRTUAL_ENV`, write Verify commands for that interpreter (bare `pytest` / `python` are rewritten to it at plan time). Do not assume system `python3` has project dependencies.
9. Each task persisted with `gsd_plan_task` needs the exact shape: `milestoneId`, `sliceId`, `taskId`, `title`, `description`, `estimate`, `files`, `verify`, `inputs`, `expectedOutput`, and optional `observabilityImpact`. In a parent workspace (when a Declared Repositories block is present above), also set `targetRepositories` to the repository id(s) the task touches. `description` should contain the Why / Do / Done-when narrative. Any npm package name in a task description's install/add instructions (`npm install`, `yarn add`, `pnpm add`) or in `require('...')` or `import ... from '...'` code examples is subject to pre-execution registry validation; reference only packages that exist on the public npm registry, and remove or correct any package name that is not real. `files`, `inputs`, and `expectedOutput` must be JSON arrays of strings, even when there is only one path (for example, `"inputs": ["src/index.ts"]`, never `"inputs": "src/index.ts"`). Use paths relative to `{{workingDirectory}}`; do not put absolute paths to the original checkout or any directory outside `{{workingDirectory}}` in `files`, `inputs`, `expectedOutput`, or verification commands. **`expectedOutput` must only list files the task actually creates or overwrites on disk.** Do NOT include files the task merely reads, verifies, tests, or describes — those belong in `inputs`, `verify`, `description`, or slice success criteria. If a task is a pure verification or test task that produces no new files, `expectedOutput` must be `[]`; if it writes a test-result log or assertion output file, list only that concrete file path. A file that does not yet exist on disk and is needed as an `input` must be produced by an earlier task's `expectedOutput` — if no prior task creates it, add a task before this one that does. Never list GSD planning artifacts — anything under `.gsd/`, `.planning/`, or `.audits/`, or artifact names like `M001-CONTEXT.md` / `S01-PLAN.md` — in `inputs`, `files`, or `expectedOutput`: their content is preloaded as context, and they are written by workflow tools, not by tasks.
10. Persist incrementally through DB-backed tools. First call `gsd_plan_slice` with `milestoneId`, `sliceId`, `goal`, and optional `successCriteria`/`proofLevel`/`integrationClosure`/`observabilityImpact` (and `targetRepositories` in a parent workspace, to set the slice-wide default); omit `tasks` for this metadata call. Then call `gsd_plan_task` once per task, using the task shape above. Each successful tool call saves progress and re-renders `{{outputPath}}` from DB. The DB-backed tools are the canonical write path. Do **not** rely on direct `PLAN.md` writes as the source of truth.
11. Self-audit before finishing: goal/demo closure, requirement coverage, deliverable coverage audit (cross-check every file listed in CONTEXT.md `## Scope` / `### In Scope` against task `files` or `expectedOutput`), locked decisions, concrete paths, dependency order, wiring, scope size, proof truthfulness, feature completeness, and quality gates. Quality gates: non-trivial slices/tasks include specific Q3-Q7 coverage where applicable.
12. If planning creates structural decisions, call `gsd_decision_save` for each; the tool persists the decision and regenerates `.gsd/DECISIONS.md`. Capture other durable planning insights with the host tool `capture_thought`. Use a prefixed capture tool only when that exact MCP-scoped name is presented.
13. {{commitInstruction}}

The slice directory already exists. Do not mkdir.

**Autonomous execution:** no human is available. Do not call `ask_user_questions` or `secure_env_collect`; make reasonable assumptions and document them.

**You MUST call `gsd_plan_slice` and then `gsd_plan_task` once for each planned task before finishing, unless the stale-path safety rule above stops the unit before safe planning can occur.**

When done, say: "Slice {{sliceId}} planned." Say this exactly once — if you already said it in a prior message, do not repeat it.
