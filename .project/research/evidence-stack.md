# Evidence — stack

<!-- Written by one researcher role. Consumed by the synthesizer. -->

Dimension: stack
Questions assigned: none (grounded instead in INTENT.md risks: hidden readers, thin telemetry, live-data migration, downgrade story, concurrent writers)

## Finding: The DB technology is already settled — node:sqlite only, so "stack" is purely the cutover execution strategy

- **Claim**: The GSD state DB runs on Node's built-in `node:sqlite` (`DatabaseSync`) with exactly one provider (`DbProviderName = "node:sqlite"`), a hard minimum of Node 22.18.0 (`MIN_SQLITE_NODE_VERSION`), and `SCHEMA_VERSION = 45`; there is no sql.js or better-sqlite3 fallback in the provider loader, and WAL/DELETE journal modes are managed explicitly in the engine.
- **Source**: `src/resources/extensions/gsd/db-provider.ts:5-6` (`export type DbProviderName = "node:sqlite"`, `MIN_SQLITE_NODE_VERSION = "22.18.0"`); `src/resources/extensions/gsd/db/engine.ts:153` (`req("node:sqlite")`), `:159` (`SCHEMA_VERSION = 45`), `:236-313` (journal-mode management); Node.js sqlite docs (https://nodejs.org/api/sqlite.html) confirming `DatabaseSync` availability since v22.5.0.
- **Confidence**: high
- **Why it matters here**: INTENT vetoes framework swaps; with the database layer fixed, the only open stack decision is the *shape* of the cutover flip (big-bang vs. shadow-then-flip vs. per-surface), and no research budget should go to DB technology selection.

## Finding: Writes are already DB-authoritative and structurally enforced; the unfinished half is read/routing precedence

- **Claim**: All write SQL against `.gsd/gsd.db` already lives behind a typed writer allowlist (`db/engine.ts`, `db/domain-operation.ts`, `db/writers/**`, `gsd-db.ts` as compatibility barrel) enforced by a structural test that fails on any new raw write site; the legacy path that remains is read-side: `state.ts` filesystem fallback in `_deriveStateImpl` and "legacy status wins publicly when canonical lifecycle disagrees" behavior witnessed by the no-cutover tests.
- **Source**: `src/resources/extensions/gsd/tests/single-writer-invariant.test.ts:1-45` (allowlist + enforcement policy); `src/resources/extensions/gsd/gsd-db.ts:1-16` (barrel header); `src/resources/extensions/gsd/state.ts:4` ("legacy filesystem fallback in _deriveStateImpl only"), `:331` (filesystem fallback); `src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts:2` ("proof that semantic shadow state has not become read or routing authority").
- **Confidence**: high
- **Why it matters here**: Migration cost is concentrated in read-path inversion, not write-path dual-maintenance — a big-bang flip is cheaper here than in a typical dual-write system, because the single-writer invariant (INTENT "must not break") already constrains the write side.

## Finding: A read-through shadow with comparison already exists — the repo is mid-way through "shadow then flip", not at the starting line

- **Claim**: Milestone-status reads already compute canonical DB state, compare it against legacy state via `LifecycleShadowComparison` kinds (`match`, `semantic_match_exact_delta`, `missing_shadow`, `extra_shadow`, `status_mismatch`), and attach the shadow snapshot to tool responses (`shadowSnapshot` at workflow-tool-executors.ts:2172,2200) while legacy remains the public authority; a capstone harness persists shadow evidence into a fixture DB via domain operations.
- **Source**: `src/resources/extensions/gsd/db/lifecycle-shadow-comparison.ts:1-30`; `src/resources/extensions/gsd/lifecycle-shadow-observation.ts:29-71` (typed observation payload with loss accounting); `src/resources/extensions/gsd/tools/workflow-tool-executors.ts:2133-2212`; `src/resources/extensions/gsd/tests/semantic-shadow-capstone-harness.ts:1-40`.
- **Confidence**: high
- **Why it matters here**: INTENT's "thin telemetry" risk is partially mitigated for *status disagreement* (shadow observations exist) but the coexistence cost is already paid — continuing the shadow-to-flip strategy adds far less than starting one, which directly lowers the migration-cost advantage of a per-surface strangler.

## Finding: Legacy-usage telemetry is per-process, env-file-gated, and does not instrument the legacy state-read fallback at all

- **Claim**: `legacy-telemetry.ts` defines exactly five counters (`legacy.workflowEngineUsed`, `legacy.uokFallbackUsed`, `legacy.mcpAliasUsed`, `legacy.componentFormatUsed`, `legacy.providerDefaultUsed`), incremented at only five production call sites (commands-workflow-templates, model-router, bootstrap/db-tools, uok/kernel, component-loader); no counter fires on the `_deriveStateImpl` filesystem fallback or any `parsers-legacy.ts` read, and persistence requires `GSD_LEGACY_TELEMETRY_FILE` to be set (per-process JSON snapshot, swallowed on write error).
- **Source**: `src/resources/extensions/gsd/legacy-telemetry.ts:8-26,87-95`; grep for `incrementLegacyTelemetry` across non-test `*.ts` → 5 call sites, none in `state.ts`/`parsers-legacy.ts`; `scripts/legacy-cleanup-gate.mjs:6-12` (same five counters are what `legacy:cleanup:gate` evaluates).
- **Confidence**: high
- **Why it matters here**: Directly substantiates INTENT's "thin telemetry" risk for this milestone — `legacy:cleanup:evidence`/`gate` green would prove nothing about the filesystem-state read path being unused, so evidence collection must be extended (or the gate re-scoped) before deletion, regardless of flip strategy chosen.

## Finding: Live-data migration machinery already exists and is large — the cutover should ride it, not build a new path

- **Claim**: The repo already ships 38 `legacy-import-*.ts` modules including verified backups (`legacy-import-backup.ts`, 3266 lines), a 1024-line import application with idempotency/replay-conflict errors, restore-window assessment, and `project-authority-cutover-domain-operation.ts` — an explicit "irreversible project authority cutover" domain op with consent tokens, authority-epoch staleness checks, `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION` and `COORDINATION_ACTIVE` errors, and persisted cutover receipts (`insertAuthorityCutoverReceipt`).
- **Source**: `ls src/resources/extensions/gsd/legacy-import-*.ts | wc -l` → 38; `src/resources/extensions/gsd/legacy-import-backup.ts:1-8`; `src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts:1-50` (error codes and contract versions); `docs/dev/ADR-017-state-reconciliation-drift-driven.md:12-18` (ADR-046 disposition: "Disk may enter authority only through explicit Import Preview and Application").
- **Confidence**: high
- **Why it matters here**: INTENT's live-data migration risk (idempotent, backed up, rollback-safe `~/.gsd` migration) is largely an integration problem against an existing seam; any strategy that routes migration outside the Import Preview/Application + authority-cutover operation duplicates a battle-tested idempotency and receipt model.

## Finding: The no-cutover gate is a ready-made decomposition map — 8 source files and 16 behavioral witnesses define the flip surface

- **Claim**: `semantic-shadow-no-cutover-gate.mjs` (857 lines) pins exactly eight production files (`workflow-tool-executors.ts`, `parallel-eligibility.ts`, `dispatch-guard.ts`, `auto-dispatch.ts`, `auto/detect-stuck.ts`, `state/derive/from-db.ts`, `milestone-validation-verdict.ts`, plus itself) with required/approved import policies, and sixteen named behavioral witnesses (`runtime-disagreement`, `frozen-public-response`, `resolve-dispatch-authority`, `state-derivation-authority`, `db-unavailable-*` fail-closed cases, etc.) whose current assertions encode legacy-wins behavior.
- **Source**: `scripts/semantic-shadow-no-cutover-gate.mjs:13-24` (NO_CUTOVER_SOURCE_FILES), `:102-133` (NO_CUTOVER_BEHAVIORAL_WITNESSES).
- **Confidence**: high
- **Why it matters here**: INTENT requires gate retirement without dropping invariants; the gate's own structure shows a per-surface flip is decomposable along these 8 files, and each witness is a test that must be *inverted or re-homed* (per AGENTS.md "remove or update tests that asserted removed behavior") — this bounds the test burden of each strategy option concretely.

## Finding: Concurrent-writer safety rests on three existing mechanisms — the downgrade window is the real exposure, not intra-version races

- **Claim**: Cross-worktree concurrency is handled by a separate `.gsd/unit-claims.db` (unit-ownership.ts, 218 lines, deliberately outside the single-writer invariant), revision-checked domain operations (`GSD_REVISION_CONFLICT`), and WAL-mode checkpoint/flush helpers (including a "flush WAL so `git add .gsd/gsd.db` stages current state" path); multi-worktree races within one binary version are already engineered for, but a mixed-version fleet (pre-cutover binary treats files as authority, post-cutover binary treats them as projections) has no compatibility shim once the legacy read path is deleted.
- **Source**: `src/resources/extensions/gsd/tests/single-writer-invariant.test.ts:17-18` (unit-claims.db exclusion); `src/resources/extensions/gsd/unit-ownership.ts:6,90`; `src/resources/extensions/gsd/db/engine.ts:2489` (WAL flush for git staging); INTENT.md NEEDS-USER question on downgrade tolerance.
- **Confidence**: high (mechanisms exist); medium (mixed-version exposure — inferred from read-precedence behavior, not from an explicit mixed-version test)
- **Why it matters here**: INTENT's downgrade-story risk maps directly onto strategy choice: big-bang flip + legacy deletion makes every older released binary immediately dangerous to migrated projects; a shadow-then-flip strategy preserves old-binary safety until the deletion commit, which is why the NEEDS-USER downgrade-window answer gates the deletion step.

## Finding: External pattern evidence favors evidence-gated deletion over permanent coexistence — matching the intent's sequencing

- **Claim**: Azure's Strangler Fig guidance prescribes per-domain extraction with ETL + validation, keeping rollback possible "until the legacy database is fully decommissioned" and treating legacy-object removal as "a deliberate final step … only after the new system is validated"; Fowler-lineage Branch-by-Abstraction guidance warns that temporary dual-write/shadow synchronization becoming permanent is a named failure mode ("you haven't completed a strangler migration — you've built a permanent diplomatic border").
- **Source**: https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig (Azure Architecture Center); https://stevekinney.com/courses/enterprise-ui/strangler-fig-introduction (transform/coexist/eliminate loop; permanent-dual-write failure mode).
- **Confidence**: high (S-authority primary source for Azure; secondary but consistent for the failure-mode catalog)
- **Why it matters here**: Validates INTENT's `legacy:cleanup:evidence → gate → delete` ordering and the "files as pure projections" end state; also flags that the repo's long-running semantic shadow (per plan-of-plans, in flight since 2026-05) is itself drifting toward the permanent-coexistence failure mode the intent exists to close.

## Strategy comparison (synthesis of findings above)

Three viable execution strategies, weighed migration-cost-first:

1. **Big-bang flag flip** — one commit inverting read/routing precedence across the 8 gate-pinned files, migrating user state via the existing authority-cutover domain op, deleting the legacy read path. Migration cost: lowest ongoing maintenance, smallest diff surface. Test burden: all 16 witnesses invert at once; highest single-commit review risk. Rollback: code revert works, but user data already migrated and old binaries become unsafe the moment legacy readers are deleted — conflicts with the unanswered NEEDS-USER downgrade window.
2. **Read-through shadow with telemetry, then flip, then delete (continue current course)** — extend telemetry to cover the state-read fallback (Finding 4 gap), drive shadow disagreement to zero, flip precedence, retire the gate, delete after evidence. Migration cost: lowest *remaining* cost because the shadow/comparison/capstone machinery is already built (Finding 3). Test burden: incremental witness inversion; `legacy:cleanup:evidence` becomes meaningful. Rollback: safest until the deletion commit; deletion remains the deliberate final step per Azure guidance.
3. **Per-surface strangler (status → dispatch → derive → validation)** — flip one gate-pinned file at a time behind its existing import-policy seam. Migration cost: highest total — each surface carries its own witness inversion, its own evidence cycle, and a longer dual-authority window that prolongs hidden-reader exposure (INTENT risk) and drags toward the permanent-coexistence failure mode (Finding 8). Rollback: finest granularity, but granularity the repo's existing shadow already provides more cheaply.

## Assigned questions — answers

- none assigned → n/a (findings grounded in INTENT.md risks instead: hidden readers → Findings 2/6; thin telemetry → Findings 3/4; live-data migration → Finding 5; downgrade story → Finding 7; concurrent writers → Finding 7)

## Dead ends

- **sql.js / better-sqlite3 as alternative providers** — `db-provider.ts` has exactly one provider name (`"node:sqlite"`); the codebase evidence's "SQLite (sql.js)" description is stale; no provider choice exists to weigh.
- **Drizzle + neon (`packages/db`)** — consumerless stub for a future cloud state mirror (no `package.json`, no importers); out of scope for this cutover and ruled out by the intent's scaffolding vetoes.
- **Percentage-rollout feature-flag infrastructure** (from strangler-fig articles, e.g. oneuptime's Redis-backed rollout flags) — targets server traffic shaping; this is a per-project local CLI with no fleet control plane, so percentage rollout does not map; only env-var/local flags are applicable.
- **`docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md` phase status** — confirms telemetry-gated legacy removal as program policy ("Retire legacy paths only after telemetry and tests prove they are safe to remove") but its phase numbering (Phase 5 DB split etc.) predates the current milestone shape; useful context, not a reliable source of what is already done.
