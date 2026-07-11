# RFC: Database-Authoritative Workflow Refactor

> **Status:** Proposed — implementation requires explicit maintainer approval
> **Date:** 2026-07-11
> **Scope:** GSD workflow orchestration, persistence, projection, conversation, verification, UAT, recovery, migration, and status surfaces
> **Decision map:** [Wayfinder: Database-authoritative GSD workflow refactor](https://github.com/open-gsd/gsd-pi/issues/1405)
>
> **Proposed ADR:** [ADR-046: Database-Authoritative Workflow Lifecycle](../ADR-046-database-authoritative-workflow-lifecycle.md)

## Executive recommendation

Refactor the GSD workflow incrementally around one durable model:

1. Ask the user focused, natural questions before delivery work begins.
2. Represent discovery, research, requirements, roadmap, and delivery as ordinary, resumable Milestones containing Slices and Tasks.
3. Store every authoritative fact and lifecycle transition in SQLite through atomic Domain Operations.
4. Treat Markdown and other readable files as one-way projections or exports. Legacy files may enter the database only through an explicit, previewed, fingerprinted, backed-up import.
5. Run all work through one persisted Lifecycle Kernel with bounded autonomous recovery, evidence-derived verification, automated UAT, and a shared closeout boundary.
6. Ask a human only for missing authority or access, irreversible consent, material route ambiguity, genuinely subjective acceptance, or a user-defined budget or policy limit.
7. Migrate without split authority, prove semantic parity through canaries, and delete legacy paths only after the agreed compatibility window and removal gates pass.

The work should ship as twelve long-running, dependency-ordered Milestones rather than a big-bang rewrite. Each implementation Task is one focused PR with its own tests and evidence. Schema migrations serialize; independent authority/projection, discovery/conversation, and recovery/UAT streams may run in parallel after the schema they consume exists.

This RFC contains no unresolved product decision. Its remaining gate is explicit maintainer approval of the complete direction before architectural code changes begin.

## Why this refactor is necessary

The intended GSD experience is simple: learn what the user wants, help sharpen it, turn it into an executable hierarchy, and carry that work to verified completion. The current implementation has accumulated multiple ways to decide what is true and multiple ways to advance work. That complexity is visible as drift, repeated questioning, brittle recovery, fabricated-looking completion, and human interruptions for conditions the agent can resolve itself.

The safety inventory found these recurring failure families:

- Runtime state is nominally database-authoritative, but Markdown, planning files, queue files, JSONL, compatibility markers, manifests, filesystem presence, and custom workflow files still influence decisions in some paths.
- Projection and import are entangled. A readable export can become a second write path, so stale files can overwrite newer database state.
- Auto, interactive, custom, parallel, and legacy execution paths do not share one lifecycle and closeout contract.
- Completion, failure, cancellation, skipping, waiver, and requirement satisfaction are sometimes compressed into overlapping status strings.
- Retry and recovery budgets can live in process memory, making restart reset the policy.
- Objective verification and UAT can be delegated to a human even when commands, browsers, runtime probes, or artifacts can decide them automatically.
- Discovery state can live in prompts, files, markers, or process maps rather than in a resumable project model.
- Questions can be technical, multi-part, or recommendation-free, leaving the user to supply architecture expertise instead of receiving guidance.
- Required closeout effects can happen after completion has already unlocked downstream work.
- Compatibility paths preserve old behavior without a measured removal gate, allowing the seam itself to become permanent architecture.

The characterization baseline must preserve public contracts and real safety behavior while refusing to immortalize accidental design. In particular, no golden test should require implicit Markdown authority, projection-dependent rollback, fabricated completion, a process-local discovery state, or a competing lifecycle loop.

## Product outcome

To a user, GSD should feel like one capable collaborator:

- It asks one focused question at a time.
- When there is a real choice, it recommends an option and explains why in plain language.
- The user can disagree, qualify an answer, or change direction without losing context.
- Work may continue for days or weeks. Returning users receive a concise recap of what was confirmed, what changed, what continued autonomously, and what—if anything—needs them now.
- The visible hierarchy is always Project → Milestone → Slice → Task, including the early discovery work.
- Tests and objective UAT run automatically. An ordinary failure creates remediation rather than a request for the user to debug it.
- Readable files remain useful for review and history, but lag in those files never means saved work is lost.

## Non-negotiable invariants

### Authority

- SQLite is the sole runtime authority after cutover.
- Every decision-capable runtime read comes from one revision-consistent database snapshot.
- Every authoritative mutation is an atomic Domain Operation that records the domain rows, provenance, lifecycle effects, audit event, and resulting projection work in one transaction.
- A projection failure never rolls back committed domain intent.
- Normal runtime never imports Markdown, `.planning/`, JSONL, graph files, manifests, markers, queue files, or status files into authority.
- Legacy data enters only through Import Preview followed by explicit Import Application.
- A Project Authority Epoch prevents a migrated project from silently downgrading to disk authority.

### Lifecycle

- Lifecycle Status, Attempt Result, Requirement Disposition, Waiver, and Blocker are separate concepts.
- Every execution belongs to one durable Attempt. There is at most one active Attempt for the claimed work item.
- A failed or interrupted Attempt does not complete its work item. Cancelled, skipped, blocked, or inconclusive work is not completed work.
- Dependencies unlock only when requirements are satisfied or explicitly waived by authorized policy.
- Every state transition is restart-safe, idempotent, and attributable.
- Required closeout effects and their Settlement Receipts exist before completion and dependency unlock.

### Autonomy and human blocking

- Retry, repair, replan, remediate, clarify, pause, and abort are explicit Recovery Actions; exactly one is selected for each Failure Observation.
- Recovery budgets and fingerprints persist in the database and survive restart.
- Objective verification and UAT are automated whenever executable evidence can decide them.
- Machine-fixable failure creates or reuses actionable remediation while unaffected work may continue.
- Work pauses for a human only for missing authority/access, irreversible or public-action consent, materially ambiguous product direction, genuinely subjective acceptance, or user-defined budget/policy limits.
- The executing agent cannot grant itself a required Waiver.

### Simplicity

- The Lifecycle Kernel owns sequencing, persisted stage, claims, idempotency, and typed outcomes—not provider, SQL, Git, worktree, projection, UI, or scheduling mechanics.
- The architecture remains provider-neutral and extension-first; provider-specific execution stays behind typed adapters, and capabilities outside core lifecycle authority remain extensions.
- Deterministic routing, retries, status handling, and transforms remain code, not model judgment.
- No speculative plugin system, dependency-injection container, alternate state machine, or framework swap is introduced.
- Replacement paths must be executable and tested before the old path is removed; old and new paths must not become two authorities.

## Canonical domain and lifecycle model

### Work hierarchy

- **Project:** the long-lived product effort and root authority boundary.
- **Milestone:** a durable outcome that may run for days or weeks.
- **Slice:** a dependency-aware vertical increment inside a Milestone.
- **Task:** the smallest planned, claimable, reviewable unit of work.
- **Milestone Kind:** discovery, research, requirements, roadmap, delivery, or remediation. Kind changes orchestration policy, not hierarchy semantics.
- **Planning Horizon:** an advisory expectation used for planning and recap. It never changes readiness, timeout, or completion.

### Conversation and decisions

- **Open Question:** a durable uncertainty with dependencies, status, and provenance.
- **Interaction:** one structured conversational turn of kind open, choice, clarification, recap, consent, or subjective UAT.
- **Option:** a user-visible route, including which option is recommended and why.
- **Answer:** the verbatim user response plus its normalized interpretation.
- **Decision:** the accepted interpretation and its provenance; later correction supersedes rather than erases it.
- **Work Checkpoint:** the durable resume point after an answer, research batch, pause, correction, or other meaningful boundary.

### Execution, verification, and recovery

- **Attempt:** a claimed execution of a Task or other executable unit.
- **Attempt Result:** immutable succeeded, failed, or interrupted execution evidence. Cancellation is a Lifecycle Status, not an Attempt Result.
- **Failure Observation:** immutable facts about a failed or inconclusive boundary.
- **Recovery Action:** exactly one persisted response: retry, repair, replan, remediate, clarify, pause, or abort.
- **Verification Evidence:** immutable command, browser, runtime, artifact, or inspection evidence tied to a revision and criterion.
- **Technical Verdict:** pass, fail, or inconclusive, derived from fresh objective evidence.
- **Human Acceptance:** a separate verdict for a genuinely subjective criterion.
- **Requirement Disposition:** satisfied, unsatisfied, or waived; it is not a lifecycle status alias.
- **Waiver:** an authorized, reasoned exception with scope and provenance.
- **Blocker:** a condition no autonomous action can currently resolve.

### Projection, import, and closeout

- **Projection Work:** durable, revision-aware work that renders readable state from an authoritative snapshot.
- **Import Preview:** a read-only, fingerprinted report of proposed creates, updates, deletes, preserves, ambiguities, and unparsed content.
- **Import Application:** the explicit, backed-up, one-transaction application of an unchanged preview.
- **Closeout Plan:** persisted required and noncritical effects for a boundary.
- **Settlement Receipt:** an idempotent record proving a required closeout effect happened.
- **Authority Epoch:** a monotonic per-Project marker that forbids authority downgrade after cutover.

## Long-running discovery and planning

Initial questioning is not a short preamble hidden before “real work.” It is a sequence of first-class, resumable Milestones:

1. **Product discovery** establishes users, outcomes, constraints, exclusions, and unresolved choices.
2. **Research** gathers current codebase and external evidence needed to make those choices responsibly.
3. **Requirements** turns confirmed outcomes into verifiable criteria and records uncertainty explicitly.
4. **Roadmap** decomposes accepted requirements into dependency-ordered delivery Milestones, Slices, and Tasks.

Each Milestone may span days or weeks and uses the same lifecycle, checkpoints, dependency rules, evidence, and projections as delivery. Research precedes requirements and roadmap decisions unless current verified evidence already answers the question; any shortening is recorded with its evidence and reason.

A restart derives the next interaction or work item entirely from the database. Missing or stale horizons produce a recap or recommendation, never a timeout or blocker. Corrections invalidate only dependency-reachable interpretations and plans; unrelated branches remain dispatchable.

## Conversation contract

One coordinator serves terminal, web, MCP, headless, and remote transports from the same persisted interaction model.

For each real choice, the agent presents:

- one focused question;
- two or three meaningful options when appropriate;
- a clearly identified recommendation;
- a short, plain-language reason grounded in known evidence;
- confidence and material uncertainty when relevant; and
- room for a free-form answer, objection, or alternative.

Before presentation, the coordinator uses an idempotent Domain Operation to persist the question, options, recommendation, initial dependency scope, and interaction revision atomically. After the user responds, a separate revision-checked, idempotent Domain Operation atomically persists the answer verbatim, normalized interpretation, decision or supersession, resulting affected dependency set, and Work Checkpoint. A revision conflict preserves both inputs, surfaces the conflict, and recommends a route rather than silently averaging answers.

Informational recaps never block. Choice and clarification interactions block only the dependent branch. Consent blocks the protected irreversible action. Subjective UAT blocks only when the criterion was explicitly declared human-only. A user may push back at any point; correction is a normal Domain Operation, not a destructive reset.

## Database authority and Domain Operations

The canonical database grows additively before any runtime switch. New schema families cover:

- revision, Authority Epoch, event/outbox, and provenance;
- lifecycle transitions, Attempts, Attempt Results, dispositions, Waivers, and Blockers;
- Milestone Kind, horizon, Open Question, options, answers, and Work Checkpoints;
- Failure Observations, recovery budgets, criteria, Verification Evidence, Technical Verdicts, Human Acceptance, and remediation links;
- Projection Work and import provenance;
- kernel checkpoints and stage state; and
- Closeout Plans, effect receipts, and settlements.

The Domain Operation boundary is the only normal write seam. It validates the expected revision and authority epoch, applies the mutation, records audit/provenance, advances the revision, and enqueues affected Projection Work in one SQLite transaction. Idempotency keys make retried operations safe. The Query Module exposes revision-consistent snapshots for derive, dispatch, dependencies, conversation, blockers, evidence, UAT, status, and closeout.

No filesystem observation may fill a missing authoritative row during derive or dispatch. If the database is absent and supported legacy material exists, the product offers Import Preview. It does not infer permission to import.

## Projection and explicit import

### One-way projection

Markdown, JSONL, manifests, status documents, and similar readable artifacts are generated exports. Projection Work records source revision, scope, attempts, failure, supersession, and current/stale state. A worker renders atomically, retries with bounded backoff, resumes after crashes, and skips obsolete revisions safely.

All status surfaces may state that readable status is updating while also assuring the user that saved work is safe. No completion, dispatch, rollback, or dependency decision waits for a projection to exist.

### Import Preview

Preview is read-only and fingerprints every source plus the current database revision and schema. It reports the exact proposed create/update/delete/preserve set, raw legacy values, ambiguities, and unparsed content. Preview proves byte-identical database state before and after execution.

### Backup and Import Application

Before application, GSD performs a WAL checkpoint and creates a backup recording SHA, size, schema version, authoritative revision, and source fingerprints. The backup must independently open and pass `quick_check`.

Application refuses changed inputs, active incompatible leases, or unresolved ambiguity. It applies one transaction with provenance:

- raw legacy values remain available for audit;
- legacy `skipped` becomes cancelled work, not completion;
- a Waiver is created only when source authority proves one;
- placeholder or success-looking incomplete work becomes failed/interrupted remediation;
- assessments become evidence only where reliability is demonstrable;
- JSONL is imported as history, never replayed as authority;
- custom graph definitions and runs become database records; and
- narrative content becomes database-backed content before projection.

Import Application and cutover are separate boundaries. Before the import transaction commits, transaction rollback is sufficient. After import but before cutover or any new canonical writes, a verified backup may be restored. Cutover closes that restore window and advances the Authority Epoch. After cutover or any new canonical writes, snapshot restoration is prohibited and Forward Repair is required. Down migrations and restoration of disk authority are prohibited.

## Lifecycle Kernel and ownership boundaries

The kernel is one persisted sequencer:

1. **Advance:** read one canonical snapshot, choose dependency-ready work, validate fences, and atomically claim an Attempt.
2. **Execute:** invoke the selected adapter and persist an immutable Attempt Result or Failure Observation.
3. **Verify:** gather fresh evidence and derive a Technical Verdict.
4. **Route:** select exactly one bounded Recovery Action or proceed.
5. **Closeout:** prepare a Closeout Plan, settle required idempotent effects, record receipts, and only then complete and unlock dependencies.

The kernel owns stage order, checkpoints, claims, idempotency, and typed request/outcome unions. It does not own:

- provider sessions or model policy;
- SQL implementation or schema migration mechanics;
- verification command/browser execution;
- recovery classification policy;
- Git, worktree, merge, or publication mechanics;
- projection rendering;
- terminal/web/MCP presentation; or
- parallel capacity and worker scheduling.

Auto, interactive, custom, parallel, and temporary legacy adapters translate mechanics into the same kernel requests and outcomes. The parallel coordinator owns capacity only; workers compete through database claims. Custom workflow definitions import into the database and do not retain an alternate lifecycle engine.

Closeout is deliberately two-part. `prepareCloseout` persists the intended effects while work remains active. `settleCloseout` executes or recognizes idempotent required effects and records Settlement Receipts. Required source, Git, worktree, and merge effects precede completion. Notifications and metrics may follow because they cannot change the authoritative outcome.

## Automated verification, UAT, and recovery

Technical criteria declare their evidence class. GSD automatically runs command, browser, runtime, and artifact checks and stores immutable evidence tied to the tested revision. A Technical Verdict is pass, fail, or inconclusive; stale, missing, or malformed evidence cannot pass.

Objective UAT permits at most three persisted Attempts per unchanged failure fingerprint. Ordinary failure schedules or reuses the first actionable remediation. It does not mark the parent complete and does not ask the user to debug. After remediation, the affected criterion is rerun with fresh evidence.

Recovery budgets are fixed and restart-safe:

- transient execution: initial Attempt plus two retries;
- deterministic repair: one repair per unchanged fingerprint;
- schema-corrected retry: at most two corrected attempts;
- remediation: at most two attempts for the same unchanged cause; and
- objective UAT: at most three attempts before a nonhuman route is exhausted.

Exhaustion chooses replan, clarify, pause, or abort according to the persisted facts. Clarify/pause is valid only at the approved human boundary. A failed Task remains failed or in remediation; it is never converted into completed work to let the loop continue.

## Status and resume experience

One database-derived read model feeds terminal, web, MCP, and projections. The default return experience is conversational:

- what has been confirmed;
- what changed since the last interaction;
- what the system completed or continued autonomously;
- one recommended next step; and
- at most one focused question.

A compact strip groups **Needs input**, **Continuing**, and **Updating**. Only human-only work appears under Needs input. An expandable journey view shows Milestones, Slices, Tasks, dependencies, evidence, and history. Projection revision and staleness are visible but nonblocking. Meaning does not depend on color or item order, and every transport preserves free-form pushback.

## Migration, rollout, rollback, and removal

There is no dual-write or dual-read authority period. Additive shadow data may be written in the same Domain Operation while existing runtime reads remain unchanged. Semantic Shadow Comparison compares normalized outcomes, never asks a legacy file to decide runtime state.

Release progression is evidence-gated:

1. Development corpus and repository dogfood for at least seven days.
2. Opt-in next-channel canary for at least fourteen days.
3. Latest promotion only after every safety and quantitative gate passes.
4. Legacy deletion only after two stable releases and at least 60 days from Import Preview/Application availability, whichever is longer, plus one stable removal notice.

Required promotion evidence:

- 100% pass for safety, fault injection, backup validation, restore, and restart-at-every-stage cases;
- zero disk-to-database runtime mutation, fabricated completion, semantic mismatch, fallback, or authority downgrade;
- at least 99.5% of Projection Work current within five minutes and 100% eventually rebuildable;
- at least 99% success across the unambiguous sanitized import corpus with zero silent drops;
- a successful restore drill for every supported schema family; and
- no material dispatch, database-open, kernel-tick, projection, or resume performance regression.

Telemetry is database-canonical and redacted. Local metrics demonstrate the local installation, not fleet-wide safety. Rollout tools surface semantic mismatch, fallback invocation, projection lag, import ambiguity, recovery exhaustion, and restore readiness.

Removal requires replacement behavior, focused tests, fault and restore coverage, the full compatibility window, a stable notice, and zero observed fallback. The final deletion removes reverse projection authority, JSONL replay, graph lifecycle state, filesystem readiness and UAT authority, duplicate loops, duplicate closeout/recovery, process-local budgets and markers, obsolete callback bags, and Authority Epoch bypasses. Explicit import readers may remain; runtime readers may not.

## Implementation program

The detailed task contract is recorded in [Decompose the approved contracts into implementation milestones](https://github.com/open-gsd/gsd-pi/issues/1411#issuecomment-4948101799). The execution shape is:

| Milestone | Duration | Outcome | Primary gate |
| --- | --- | --- | --- |
| 0. Architecture and deletion safety | 1–2 weeks | Approved RFC/ADR, database-seeded fixture, fault harness, workflow-authority baseline | `pnpm run verify:fast`; targeted baseline |
| 1. Additive canonical database foundation | 2–4 weeks | Authority, lifecycle, conversation, recovery, projection, import, kernel, and closeout schema plus Domain Operations | Migration, invariant, single-writer tests; typecheck |
| 2. Explicit import, backfill, and rollback | 2–3 weeks | Corpus, preview, verified backup, transactional application, Authority Epoch, rollback/Forward Repair | Import, backup, restore, fault, restart corpus |
| 3. Canonical queries and durable projection | 2–4 weeks | Canonical Query Module and durable Projection Worker exercised in shadow replacement paths without changing runtime authority | Workflow-authority baseline; projection benchmark |
| 4. Resumable discovery and natural conversation | 3–4 weeks | Multi-week discovery Milestones, revision-linked interactions, restart-identical correction/resume | Conversation and checkpoint contract tests |
| 5. Autonomous recovery, verification, and UAT | 3–4 weeks | Persisted classifier/budgets, evidence verdicts, remediation, automated UAT, narrow escalation | Fault, evidence freshness, sabotage, UAT tests |
| 6. Lifecycle Kernel vertical slice | 3–5 weeks | Persisted five-stage kernel and two-part closeout running one low-risk unit | Restart-at-stage and semantic shadow tests |
| 7. Adapter convergence and shared closeout | 4–6 weeks | Auto, interactive, custom, parallel, hooks, quick work, and remediation converged on one kernel and ready for project cutover | Normalized outcome parity; closeout fault tests |
| 8. Canonical status and resume experience | 2–3 weeks | One read model, welcome-back recap, compact strip, journey view, projection freshness | Render/browser/transport/accessibility checks |
| 9. Cutover, dogfood, canary, and promotion | 3+ weeks | Per-Project database-only cutover, telemetry, drills, development/next canaries, performance comparison, operator docs, and stable promotion | Quantitative promotion thresholds; maintainer release approval |
| 10. Compatibility retirement and deletion | 60+ day gate | Legacy authority, competing loops, duplicate closeout/recovery, local state authority removed | Structural deletion proofs; `verify:merge`; live workflow |
| 11. Completion audit and release handoff | 1+ week | Requirement matrix, negative audit, cross-platform upgrade/restore proof, final canary | Every Wayfinder clause mapped to current evidence |

### Dependency and parallel-work rules

- Milestone 0 begins first. No architecture code precedes explicit RFC approval.
- Milestone 1 schema PRs are strictly sequential.
- Milestone 2 begins when the import schema it consumes lands.
- Milestones 3, 4, and 5 may proceed in parallel in isolated worktrees after their schema prerequisites; none changes runtime authority.
- Milestone 6 begins only when authority/projection, conversation, and recovery/UAT expose executable public primitives.
- Milestone 8 may overlap late kernel and adapter work because it consumes the canonical read model.
- Milestone 7 adapter Tasks may parallelize after the first kernel vertical slice, but files that implement shared closeout serialize.
- Milestone 9 cutover begins only after adapter convergence in Milestone 7; its evidence accumulates after Import Application and Semantic Shadow Comparison ship.
- Milestone 10 is strictly last after compatibility and removal gates.
- Milestone 11 audits the requested end state; it cannot be replaced by a clean diff or a green narrow test.

### PR and verification rules

- One Task is one focused PR including useful tests, documentation, and migration notes for that concern.
- Every code change uses the repository test-writer workflow, proves the test can fail for the intended defect, and runs the simplify review after implementation.
- Run the smallest meaningful test, lint, typecheck, build, smoke, render, or fault gate while iterating.
- Every push runs `pnpm run verify:fast`. Code PRs may run `pnpm run verify:pr` while iterating, but any PR touching `src/`, `packages/`, or tests runs `pnpm run verify:merge` before review. Milestone and release boundaries also run `pnpm run verify:merge`.
- Schema migrations, Authority Epoch changes, closeout settlement changes, and removal PRs require restart and fault-injection evidence.
- Branches and worktrees isolate dependency-ready Tasks. Overlapping schema or closeout ownership is never parallelized.
- Implementation PRs link the relevant database-tracked Task and ADR; no public release action happens without maintainer approval.

## Alternatives considered

### Keep the current architecture and patch drift sites

Rejected. The same disagreement is encoded across multiple readers, writers, loops, and recovery paths. More local guards preserve split authority and make the next drift site harder to find.

### Make Markdown authoritative again

Rejected. Human-readable files are valuable review surfaces but lack transactional hierarchy updates, claims, attempts, evidence, revision fencing, and reliable crash recovery. Making both DB and Markdown authoritative recreates reconciliation as the core product.

### Dual-read or dual-write through the compatibility window

Rejected. It makes mismatch resolution a runtime decision and prevents a provable cutover. Same-transaction shadow rows and semantic comparison provide migration evidence without two authorities.

### Big-bang replacement

Rejected. The workflow is already in production and contains valuable behavior. Additive schema, vertical slices, semantic shadowing, and removal gates reduce risk while still converging on the requested end state.

### Put all mechanics inside the kernel

Rejected. A provider/SQL/Git/projection/UI-aware kernel would reproduce the current orchestration monolith under a new name. The kernel remains a small sequencer over deep modules.

### Require human approval at every Milestone or failed UAT

Rejected. It defeats long-running autonomy and asks the user to perform objective work the agent can do. Human attention is reserved for the explicit boundary in this RFC.

### Add a generic workflow framework for future flexibility

Rejected. The program implements the demonstrated GSD lifecycle and typed adapters. New abstraction is justified only by real duplication encountered during vertical convergence.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Legacy import silently changes meaning | Exact preview, raw-value provenance, ambiguity refusal, sanitized corpus, zero-silent-drop gate |
| Migration damages the canonical database | WAL checkpoint, independently verified backup, one transaction, restart/fault tests, restore drills |
| Old and new paths disagree | Same-transaction shadow data, normalized semantic comparison, no disk authority, explicit Authority Epoch |
| Kernel becomes another monolith | Enforced ownership boundary and one low-risk vertical slice before adapter migration |
| Automated recovery loops forever | Persisted fingerprinted budgets and exactly one Recovery Action per observation |
| UAT passes on stale or weak evidence | Evidence revision/freshness contract, sabotage tests, inconclusive verdict for missing/malformed evidence |
| Required effects happen after completion | Persisted Closeout Plan and Settlement Receipts before unlock |
| Projection lag alarms users or blocks work | Durable retry, explicit freshness state, nonblocking “saved work is safe” copy |
| Discovery becomes an endless interview | One focused question, recorded recommendation, advisory horizons, concrete Milestone exit criteria |
| Parallel agents conflict | Database claims, native dependencies, isolated worktrees, serialized schema/closeout ownership |
| Compatibility never ends | Fixed two-release/60-day minimum plus measurable deletion gates and removal notice |
| Local telemetry is mistaken for fleet proof | Scope every metric honestly; require repository corpus, canary, and supported-platform evidence |

## Decision provenance

This RFC consolidates, rather than reopens, the resolved Wayfinder contracts:

- [Characterize the current workflow and establish refactor safety baselines](https://github.com/open-gsd/gsd-pi/issues/1407#issuecomment-4947669763)
- [Define the canonical workflow lifecycle and outcome model](https://github.com/open-gsd/gsd-pi/issues/1415#issuecomment-4947912741)
- [Model resumable discovery milestones and planning horizons](https://github.com/open-gsd/gsd-pi/issues/1406#issuecomment-4947940953)
- [Unify conversation, recommendation, and decision persistence](https://github.com/open-gsd/gsd-pi/issues/1409#issuecomment-4947992692)
- [Specify the database authority, projection, and explicit import contract](https://github.com/open-gsd/gsd-pi/issues/1410#issuecomment-4948001204)
- [Prototype the multi-week discovery conversation and status surface](https://github.com/open-gsd/gsd-pi/issues/1413#issuecomment-4948032138)
- [Define autonomous recovery, verification, UAT, and escalation](https://github.com/open-gsd/gsd-pi/issues/1414#issuecomment-4948045386)
- [Design one lifecycle kernel and shared closeout boundary](https://github.com/open-gsd/gsd-pi/issues/1412#issuecomment-4948062340)
- [Plan legacy migration, compatibility retirement, and rollout safety](https://github.com/open-gsd/gsd-pi/issues/1408#issuecomment-4948078682)
- [Decompose the approved contracts into implementation milestones](https://github.com/open-gsd/gsd-pi/issues/1411#issuecomment-4948101799)

## Approval checklist

The RFC is ready for a maintainer decision. There are no unresolved product or architecture choices hidden behind implementation.

- [ ] Explicit maintainer approval of SQLite as the sole post-cutover runtime authority.
- [ ] Explicit maintainer approval of discovery, research, requirements, and roadmap as ordinary long-running Milestones.
- [ ] Explicit maintainer approval of the one-question conversation and recommendation contract.
- [ ] Explicit maintainer approval of the Lifecycle Kernel ownership boundary and shared two-part closeout.
- [ ] Explicit maintainer approval of automated objective UAT, persisted recovery budgets, and the narrow human-blocking boundary.
- [ ] Explicit maintainer approval of Import Preview/Application, Authority Epoch, Forward Repair, and no split-authority rollback.
- [ ] Explicit maintainer approval of the compatibility window: two stable releases and at least 60 days, whichever is longer.
- [ ] Explicit maintainer approval of the twelve-Milestone program, serialized schema work, parallel stream rules, and final contradiction audit.
- [ ] ADR-046 records the accepted decision and disposition of conflicting ADR guidance before implementation begins.

Approval authorizes the program direction, not an unreviewed bulk rewrite. Every implementation Task remains independently reviewable and must pass its named evidence gates.
