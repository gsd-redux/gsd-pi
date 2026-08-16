# Evidence — pitfalls

<!-- Written by one researcher role. Consumed by the synthesizer. -->

Dimension: pitfalls
Questions assigned: RESEARCH Q2 — "What telemetry exists today to prove legacy filesystem-state path usage is zero, and is it sufficient — or must evidence collection be added before deletion can be scheduled?" (plus the six pitfall coverage areas: silent reader breakage, telemetry-can't-prove-zero, corrupt/partial ~/.gsd migration, downgrade stranding, concurrent writers across worktrees, invariant loss at gate retirement)

## Finding: The counter the cutover milestone actually needs — `legacy.markdownFallbackUsed` — was never wired in code

- **Claim**: `LEGACY_COUNTERS` in the cleanup gate and the runtime telemetry layer contain exactly five counters (`legacy.workflowEngineUsed`, `legacy.uokFallbackUsed`, `legacy.mcpAliasUsed`, `legacy.componentFormatUsed`, `legacy.providerDefaultUsed`) — none of them measures legacy filesystem-state/markdown-fallback usage. The refactor plan-of-plans claims `legacy.markdownFallbackUsed` was "wired to explicit markdown state derivation fallback", but that string appears nowhere in `src/` or `scripts/` — only in the plan doc. No `incrementLegacyTelemetry` call exists in `state.ts` or `state/derive/*`.
- **Source**: `scripts/legacy-cleanup-gate.mjs:6-12`; `src/resources/extensions/gsd/legacy-telemetry.ts:9-29`; `docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md:639,653,677` (claim) vs. repo-wide grep for `markdownFallbackUsed` (doc-only hits); grep for `incrementLegacyTelemetry` (only commands-workflow-templates.ts, model-router.ts, bootstrap/db-tools.ts, component-loader.ts, uok/kernel.ts).
- **Confidence**: high
- **Why it matters here**: Success criterion 3 requires telemetry/tests to demonstrate the legacy filesystem-state path is unused before removal; the telemetry subsystem measures five other legacy categories and literally cannot observe the path this milestone deletes — evidence collection must be added before deletion can be scheduled.

## Finding: The evidence pipeline can report "zero usage" without any usage ever being measured

- **Claim**: If the telemetry file does not exist, `ensureTelemetryReport` fabricates an all-zero report and the gate passes; persistence only happens when the opt-in `GSD_LEGACY_TELEMETRY_FILE` env var is set; and the counters live in process memory with whole-file `writeFileSync` overwrite on every increment, so concurrent processes clobber each other (last writer wins) with no merge.
- **Source**: `scripts/legacy-cleanup-evidence.mjs:73-87` (`ensureTelemetryReport` creates a zeroed report on ENOENT); `src/resources/extensions/gsd/legacy-telemetry.ts:86-95` (early return when env var unset; full-file overwrite); `scripts/legacy-cleanup-gate.mjs:59-82` (pass = all counters zero).
- **Confidence**: high
- **Why it matters here**: `legacy:cleanup:evidence` green is satisfiable by construction (run once on a clean checkout with no GSD activity), so it cannot serve as the deletion gate for live `~/.gsd` user data without a redesign of what "evidence" means.

## Finding: There is no field telemetry for the installed base — "zero usage" is unobservable for end users

- **Claim**: Legacy telemetry is strictly local: in-process counters plus an opt-in local JSON snapshot. No code path in `src/` uploads, posts, or transmits usage counters; the shipped npm CLI (`@opengsd/gsd-pi` v1.11.0) emits no usage data, and end users never set `GSD_LEGACY_TELEMETRY_FILE`. "Representative runs" therefore means "whoever manually runs the evidence command on a dev machine".
- **Source**: `src/resources/extensions/gsd/legacy-telemetry.ts:45-96` (beforeExit persist to local file only); repo grep for telemetry endpoint/upload/analytics in `src/` → no runtime matches (only unrelated skill docs about web analytics); `.project/research/evidence-codebase.md` (npm-shipped CLI).
- **Confidence**: high (absence verified by grep + full read of the telemetry module)
- **Why it matters here**: INTENT.md flags "thin telemetry" as a top risk and success criterion 3 demands proof of non-use; for anything outside the repo (user scripts, other tools reading projected files), that proof is unattainable with current infrastructure — deletion must be gated on something else (e.g., fail-loud shims, versioned deprecation windows) or accept unmeasurable residual risk.

## Finding: Hidden readers are already in the repo — `parsers-legacy.ts` has 15+ production importers, including a second extension

- **Claim**: The legacy markdown parsers are imported by at least 15 non-test modules, not just the `_deriveStateImpl` fallback: `github-sync/sync.ts` (a separate bundled extension), `reactive-graph.ts`, `artifact-verification.ts`, `doctor.ts`, `doctor-state-checks.ts`, `doctor-engine-checks.ts`, `markdown-renderer.ts`, `auto-prompts.ts`, `workspace-index.ts`, `visualizer-data.ts`, `state-reconciliation/drift/roadmap.ts` + `drift/sketch-flag.ts`, `commands-maintenance.ts`, `migration-auto-check.ts`, and `md-importer.ts`. `parsers-legacy.ts` itself notes new importers must be registered in `tests/parsers-legacy-importers.test.ts`.
- **Source**: repo grep for `parsers-legacy` (non-test importer list); `src/resources/extensions/github-sync/sync.ts:14`; `src/resources/extensions/gsd/parsers-legacy.ts:18`.
- **Confidence**: high
- **Why it matters here**: INTENT.md's top risk is silent reader breakage at cutover; "delete the legacy filesystem-state read path" cannot be scoped to the derive fallback — these readers parse projected markdown as a data source, so any projection format/location change (or deletion) silently breaks doctor, github-sync, reactive-graph, and rendering paths unless each is migrated or re-pointed first.

## Finding: The live derive path already refuses the markdown fallback — the legacy path is nearly test-only at the state seam

- **Claim**: `deriveState` routes to `deriveStateFromDb` whenever `isDbAvailable()`; when the DB is unavailable it logs "DB unavailable — refusing implicit markdown state derivation" and returns `buildDbUnavailableState()` instead of parsing files. `_deriveStateImpl` (the actual filesystem derivation) has no production callers — every importer is a test file. `state.ts:15-19` documents that the legacy parsers "must never be consulted when DB data is present".
- **Source**: `src/resources/extensions/gsd/state/derive/index.ts:85-97`; repo grep for `_deriveStateImpl` (only `state.ts` export + test files, incl. `derive-state-db.test.ts`, `integration-proof.test.ts`, `auto-loop-symlink-worktree.test.ts`); `src/resources/extensions/gsd/state.ts:15-19,295-298`.
- **Confidence**: high (code); medium (implication for deletion scheduling)
- **Why it matters here**: Cuts both ways for the milestone: the cutover at the state seam is closer to done than the "semantic shadow" framing suggests, but it also means telemetry was never needed at that seam — the correct evidence is a static/no-caller proof plus the remaining markdown readers (previous finding), not a runtime counter.

## Finding: A failed `~/.gsd` external-state migration leaves partial output that permanently blocks retry

- **Claim**: `migrateToExternalState` copies `.gsd` contents into `~/.gsd/projects/<hash>/` entry by entry; on copy failure it restores the local `.gsd` directory but does NOT remove the partially copied external directory. Every subsequent run hits the `externalStateAlreadyExistsForProject` guard and refuses to migrate ("leaving local .gsd directory untouched to avoid overwriting authoritative state"), stranding the project unmigrated until a human deletes the partial external dir.
- **Source**: `src/resources/extensions/gsd/migrate-external.ts:88-96` (pre-existing-external guard), `:130-152` (copy-failure path restores local, leaves external), `:101-127` (rename/copy staging with `.gsd.migrating` rollback).
- **Confidence**: high
- **Why it matters here**: INTENT.md requires live-data migration of `~/.gsd` to be idempotent and rollback-safe; the existing migration is rollback-safe for the *source* but not self-healing for the *destination* — the same pattern in the DB cutover migration would turn a transient copy error into a permanent migration wedge on real user machines.

## Finding: Downgrade after cutover fails loudly at DB open — and that is the entire downgrade story

- **Claim**: `migrateSchema` throws `gsd.db schema is vN, newer than the vM this gsd-pi supports. Update gsd-pi...` when an older binary opens a newer DB; pre-migration backups are kept as `gsd.db.backup-v<N>` but same-version backups are overwritten each migration and there is no automated restore path. SQLite itself only guarantees older libraries can read newer files when no newer file features (e.g., WAL) are used.
- **Source**: `src/resources/extensions/gsd/db/engine.ts:454-460`; `src/resources/extensions/gsd/db-migration-backup.ts:26-51`; [SQLite — File Format Changes](https://www.sqlite.org/formatchng.html) ("older versions ... can read and write database files created by newer versions of SQLite as long as the database does not make use of newer features", e.g. WAL).
- **Confidence**: high
- **Why it matters here**: INTENT.md's downgrade risk ("old binary must not strand DB-authored state unreadable") is only half-addressed in code: the failure is loud (good — no silent corruption), but a rolled-back user is fully blocked until they manually restore a backup or re-upgrade; the open NEEDS-USER question (how many released versions a downgrade must stay readable for) directly determines whether a backup-restore command must ship in this milestone.

## Finding: Concurrent-writer protection is WAL + lease tables on local disk only; mixed-version worktrees during cutover are uncoordinated

- **Claim**: Cross-worktree concurrency is handled by sharing the project-root `.gsd/gsd.db` in WAL mode with `busy_timeout = 5000` and v24 coordination tables (`workers`, `milestone_leases` with fencing tokens, `unit_dispatches`); the schema header states the single-host invariant explicitly — "NFS / network filesystems break the coordination semantics — multi-host execution needs a real coordinator ... out of scope". Nothing coordinates *schema-version skew*: two linked worktrees running different gsd-pi versions (one pre-cutover dual-path, one post-cutover) write through different authority models to the same DB and projection files.
- **Source**: `src/resources/extensions/gsd/db-coordination-schema.ts:13-16`; `src/resources/extensions/gsd/db-workspace.ts:131-139` (worktrees resolve to project-root DB, "shared WAL — R012"); `src/resources/extensions/gsd/unit-ownership.ts:129-130`; `src/resources/extensions/gsd/auto/loop.ts:204` ("SQLite WAL only — multi-host would need a real coordinator").
- **Confidence**: high (mechanism); medium (skew scenario likelihood)
- **Why it matters here**: INTENT.md makes multi-worktree development with dozens of linked worktrees a binding constraint and protects the single-writer invariant; the cutover window is exactly when version skew across worktrees is most likely, and the current coordination layer assumes all writers run the same schema/authority model.

## Finding: Retiring the no-cutover gate drops invariants that have no successor home, and no CI runs the gates today

- **Claim**: `gate:semantic-shadow-no-cutover` encodes 8 structural AST checks plus 15 behavioral witnesses whose asserted behavior is pre-cutover authority (e.g., "legacy milestone status remains public when canonical lifecycle disagrees", "resolveDispatch keeps legacy milestone status authoritative"). Those witness tests fail by design at cutover and must be removed/inverted per AGENTS.md, but no post-cutover gate script exists — the only cutover-related gate in `package.json` is the no-cutover one, `verify:pr` = `build:core && typecheck:extensions && test:unit` (no gate scripts), and no CI workflow references `legacy:cleanup:*`, `semantic-shadow`, or `baseline:refactor:gate`. The single-writer invariant survives independently (static allowlist scanner `tests/single-writer-invariant.test.ts` inside the unit suite), but projection-fidelity / frozen-response / dispatch-authority invariants have no re-homed check.
- **Source**: `scripts/semantic-shadow-no-cutover-gate.mjs:98-128,646-690`; `package.json:79-83,140`; grep of `.github/workflows/` for `legacy:cleanup|semantic-shadow|refactor:gate` → no matches; `src/resources/extensions/gsd/tests/single-writer-invariant.test.ts:284-327`.
- **Confidence**: high
- **Why it matters here**: Success criterion 2 requires every invariant the gate protects to have an explicit post-cutover home as a runnable check; today there is no successor check, and because the gates are not wired into `verify:pr` or CI, a retired-but-not-re-homed invariant would vanish silently — exactly the failure mode INTENT.md lists.

## Assigned questions — answers

- **Q2: What telemetry exists today to prove legacy filesystem-state path usage is zero, and is it sufficient — or must evidence collection be added before deletion can be scheduled?** → **Not sufficient; evidence collection must be added (or the proof re-based on static analysis) before deletion.** What exists: (a) a runtime counter layer (`src/resources/extensions/gsd/legacy-telemetry.ts`) with five counters for *other* Phase 8 legacy categories — none for the filesystem-state/markdown-fallback path, despite the plan-of-plans claiming `legacy.markdownFallbackUsed` was wired (`docs/dev/2026-05-03-long-running-refactor-plan-of-plans.md:639` vs. `scripts/legacy-cleanup-gate.mjs:6-12`); (b) opt-in local persistence via `GSD_LEGACY_TELEMETRY_FILE` with process-local, whole-file-overwrite semantics; (c) `legacy:cleanup:evidence`/`legacy:cleanup:gate` scripts that pass on a fabricated all-zero report when no telemetry file exists (`scripts/legacy-cleanup-evidence.mjs:73-87`); (d) no field/remote telemetry of any kind for the npm installed base. What exists that *is* strong evidence: the live `deriveState` seam already refuses markdown derivation when the DB is unavailable and `_deriveStateImpl` has zero production callers (`state/derive/index.ts:85-97` + grep), so a static no-caller/no-importer proof plus migration of the 15+ `parsers-legacy` readers is a more honest gate than any counter the current pipeline can produce.

## Dead ends

- `worktree-registry` as a module — exists only as the test name `auto-worktree-registry.test.ts` (wired into `baseline:refactor:phase0`, `package.json:81`); it tests the per-process auto-worktree *session* registry that replaced the `originalBase` singleton (`auto-worktree-session-registry.ts`), not a cross-worktree/cross-process DB writer registry. Cross-process coordination lives in the v24 lease tables instead.
- Remote/field telemetry endpoints — repo grep of `src/` for telemetry upload/analytics endpoints found no runtime implementation; the former unwired telemetry UI was retired separately.
- `legacy.markdownFallbackUsed` implementation — searched repo-wide; exists only in the plan-of-plans doc. Recorded as Finding 1 (stale doc claim) rather than implemented-but-mislabeled code.
- `scripts/refactor-baseline.mjs` as a telemetry source — it is a read-only metrics/dashboard harness (file hashes, contract surfaces, prompt sizes) and reports the five legacy counters from the same in-memory layer; it adds no independent usage evidence.
