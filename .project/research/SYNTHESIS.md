# Synthesis

<!-- Written by the synthesizer role. The planner treats Decisions as settled. -->

Milestone: state-DB cutover in gsd-pi — flip project state to DB-authoritative with
files as pure projections, prove the legacy filesystem-state path is unused, delete it.

## Decisions

<!-- One block per resolved choice. -->
### Cutover flip shape

- **Decision**: Read-through shadow → flip → delete (continue the current course), run as
  a bounded expand/migrate/contract: extend evidence collection, flip read authority at
  the filesystem-state seam, then delete the legacy path as a deliberate final step gated
  on `legacy:cleanup:evidence` → `legacy:cleanup:gate`. The shadow/comparison/capstone
  machinery is already built, so remaining cost is lowest here.
- **Runner-up**: Big-bang flag flip across the 8 gate-pinned files in one commit — lost
  because it makes every older released binary immediately unsafe to migrated projects
  (the downgrade window, since ruled at 2 stable releases + ≥60 days, forbids that), and
  it inverts all 16 behavioral witnesses in a single review. Per-surface strangler lost
  harder: highest total cost, one evidence cycle per surface, and it prolongs the
  dual-authority window toward the permanent-coexistence failure mode the repo is
  already drifting into.
- **Evidence**: evidence-stack.md § Strategy comparison; evidence-stack.md § A read-through
  shadow with comparison already exists; evidence-migration.md § Expand/migrate/contract
  (ParallelChange) is the canonical bounded dual-run window; evidence-stack.md § External
  pattern evidence favors evidence-gated deletion over permanent coexistence
- **Confidence**: high

### D005 standing NO-GO (T07 dossier)

- **Decision**: Scope around D005, do not broadly supersede it. This milestone supersedes
  D005 only for filesystem-state (markdown) authority: gsd-db hierarchy reads are already
  the DB authority, files become pure projections, and the markdown fallback is deleted.
  The canonical *lifecycle* read-authority cutover (status-response authority, the subject
  of the T07 NO-GO with 13 named blockers including zero live observation rows) stays
  deferred under the M003 shadow program. Record this as an explicit milestone decision
  doc so the gate retirement never contradicts a recorded decision by silence.
- **Runner-up**: Formally supersede D005 wholesale and flip canonical lifecycle reads too
  — lost because INTENT.md scopes this milestone to the filesystem-state path (its scope
  list and success criteria never mention canonical lifecycle tables), the T07 dossier
  records zero live observation rows for lifecycle reads, and inflating scope to lifecycle
  authority would import 13 deferred blockers into a milestone whose vetoes demand a
  narrow blast radius.
- **Evidence**: evidence-domain.md § A prior explicit decision (D005) still names legacy
  hierarchy reads as authoritative; INTENT.md § Scope: in / Success criteria;
  evidence-domain.md § The no-cutover gate protects 8 structural import-policy invariants
- **Confidence**: medium — the filesystem-vs-lifecycle scoping reading of INTENT is
  solid; wave 1 must map the 13 T07 blockers to confirm none of them blocks
  filesystem-state deletion itself.

### Deletion-proof strategy (the `markdownFallbackUsed` telemetry gap)

- **Decision**: Re-base the deletion proof on static evidence, not on building the missing
  runtime counter. The live derive seam already refuses markdown fallback
  (`_deriveStateImpl` has zero production callers — a counter there can never fire), so
  the honest proof is: (a) a static no-caller/no-importer AST proof for the legacy
  state-read path, (b) the `parsers-legacy` importer-registry test driven to zero
  production importers, and (c) a redesigned `legacy:cleanup:evidence` that fails closed —
  today it fabricates an all-zero report when no telemetry file exists, so green is
  satisfiable by construction and proves nothing. The five existing counters keep their
  current categories; no `legacy.markdownFallbackUsed` counter is added at the dead seam.
- **Runner-up**: Wire `legacy.markdownFallbackUsed` per the plan-of-plans claim and gate
  deletion on observed zero usage (the Kubernetes/Chromium instrument-then-remove
  pattern) — lost because that pattern applies to *live* deprecated paths; pitfalls
  evidence shows the seam is unreachable in production, telemetry is per-process,
  env-gated, clobbered across processes, and there is no field telemetry for the
  installed base, so a new counter would produce a fabricated-feeling zero either way.
- **Evidence**: evidence-pitfalls.md § The counter the cutover milestone actually needs
  was never wired in code; evidence-pitfalls.md § The evidence pipeline can report "zero
  usage" without any usage ever being measured; evidence-pitfalls.md § The live derive
  path already refuses the markdown fallback; evidence-pitfalls.md § Assigned questions —
  answers (Q2); evidence-domain.md § The telemetry that would prove the legacy
  filesystem-state path is unused does not exist
- **Confidence**: high

### parsers-legacy consumer web (hidden readers)

- **Decision**: Treat deletion of the legacy read path as a consumer-web migration, not a
  function deletion. Classify each of the ~16 production importers (15 in the gsd
  extension plus `github-sync/sync.ts`) as: (a) re-point to DB-backed reads (doctor
  fallback, drift detection, renderer merge — including `markdown-renderer.ts` reading
  its own projections back), (b) legitimate projection-read, kept but stamped/validated
  against DB state version, or (c) deleted with the path. The existing
  `parsers-legacy-importers.test.ts` registry is the enforcement seam; `parsers-legacy.ts`
  is deleted only when the registry shows zero production importers.
- **Runner-up**: Delete `parsers-legacy.ts` and fix importers as they break — lost
  because doctor, github-sync, reactive-graph, and the renderer would fail silently on
  real user projects; INTENT's top risk is exactly this silent reader breakage.
- **Evidence**: evidence-domain.md § The real in-repo legacy read paths are the ~15 live
  `parsers-legacy.ts` consumers; evidence-pitfalls.md § Hidden readers are already in the
  repo — `parsers-legacy.ts` has 15+ production importers, including a second extension
- **Confidence**: high

### Projection format contract (external readers)

- **Decision**: Freeze the projection format for this milestone. Files become pure,
  read-only projections but stay byte-compatible with the pre-cutover format and
  location; changes are additive-only (a DB state-version stamp on each projection for
  staleness detection, per the jj working-copy pattern). `@opengsd/mcp-server` readers,
  `packages/daemon`, and `integrations/hermes` treat STATE.md parsing and
  PLAN/SUMMARY existence as ground truth — the projection layer is a de facto public
  API and is documented as such.
- **Runner-up**: Version/restructure the projection format during the cutover — lost
  because it breaks three separately packaged reader surfaces at the same moment
  authority flips, doubling the blast radius against INTENT's hidden-readers risk; and
  the `.gsd → ~/.gsd/projects/<hash>/` symlink means the full reader set is unobservable
  from the repo.
- **Evidence**: evidence-domain.md § External/tooling readers of projected files exist in
  three separately packaged surfaces; evidence-domain.md § Projected state physically
  lives outside the repo behind a symlink; evidence-similar.md § Git's plumbing/porcelain
  split; evidence-similar.md § Jujutsu treats the working copy as a recoverable
  projection of the store
- **Confidence**: high

### Migration and rollback design for live `~/.gsd` state

- **Decision**: Ride the existing machinery; build no new migration path. The flip is one
  more versioned step in the existing `migrateSchema` chain plus the existing
  `project-authority-cutover-domain-operation.ts` (consent tokens, authority-epoch
  checks, persisted cutover receipts). Backup = existing verified same-directory copy
  (`wal_checkpoint(TRUNCATE)` → `gsd.db.backup-v<N>` → ATTACH + `quick_check` + version
  match; backup failure aborts the cutover). Idempotency key = composite of
  schema_version row + cutover receipt + existing `GSD_IDEMPOTENCY_CONFLICT` /
  `..._REPLAY_CONFLICT` codes; re-entry is a no-op. The atomic flip runs inside the
  existing startup EXCLUSIVE lock window. Rollback = restore the verified backup (per
  Flyway: backup-restore beats down-migrations for destructive changes); legacy files are
  never deleted in the same step as the flip. Fix the known wedge pattern from
  `migrate-external.ts`: a failed cutover must clean or own its partial destination so
  retry is never permanently blocked.
- **Runner-up**: A bespoke cutover migration script outside the legacy-import/authority-
  cutover seam — lost because it would duplicate a battle-tested idempotency, backup, and
  receipt model and create a second migration path to verify against live user data.
- **Evidence**: evidence-stack.md § Live-data migration machinery already exists and is
  large; evidence-migration.md § The repo already runs the canonical journaled,
  transaction-wrapped, idempotent migration chain; evidence-migration.md § The repo's
  pre-migration backup is a verified same-directory file copy; evidence-migration.md §
  Migration tooling guidance prefers backup-restore over down-migrations;
  evidence-migration.md § cutover-grade idempotency/replay machinery;
  evidence-pitfalls.md § A failed `~/.gsd` external-state migration leaves partial output
  that permanently blocks retry
- **Confidence**: high

### Downgrade compatibility

- **Decision**: Keep the existing loud
  refuse-newer guard (`gsd.db schema is vN, newer than the vM this gsd-pi supports`) as
  the floor — no silent corruption, ever. During the compatibility window, projection
  writing stays byte-compatible so a rolled-back binary still reads its files. Stamp
  `PRAGMA user_version` (and a fixed `application_id`) so older binaries and external
  tools can detect DB-authored state cheaply. Ship an explicit backup-restore command.
  **Window: two stable releases + ≥60 days, matching the ADR-046 compatibility window**
  (user ruling 2026-08-01).
- **Runner-up**: Promise indefinite downgrade readability via maintained dual-format
  writes — lost because it re-creates the permanent dual-authority coexistence this
  milestone exists to end; the npm lockfile precedent (maintain legacy fields only
  through a bounded window) and k8s Rule #4b (one overlapping release that speaks both)
  both bound the window rather than eliminate it.
- **Evidence**: evidence-pitfalls.md § Downgrade after cutover fails loudly at DB open;
  evidence-migration.md § Refuse-newer is the shipped-CLI norm for downgrade safety;
  evidence-migration.md § SQLite ships header fields intended for format/version
  identification; evidence-similar.md § Kubernetes mandates a version-skew window;
  evidence-similar.md § npm evolved its lockfile format with explicit per-version
  compatibility windows
- **Confidence**: high (mechanism and window — user-ruled 2026-08-01)

### Gate retirement and invariant re-homing

- **Decision**: Split-retire `gate:semantic-shadow-no-cutover`; no invariant is dropped.
  (a) Lifecycle-shadow invariants (status-response authority, disagreement witnesses,
  decision-boundary allowlists, validation-assessment authority) move verbatim into a
  successor gate `gate:lifecycle-shadow-no-cutover` — D005 remains in force there.
  (b) Filesystem-state invariants become positive post-cutover checks: a DB-authority
  test at the derive seam, the parsers-legacy importer-registry test, and a
  projection-fidelity check (stamped projections match DB state). (c) DB-unavailable
  fail-closed witnesses and the never-promote-`omitted` rule keep as-is in the unit
  tier. (d) Unadopted import/reconcile and frozen cross-mode response witnesses are
  deleted on the ADR-046 timebox (two stable releases + ≥60 days). (e)
  `closed-local-inputs` ports to the successor gate unchanged. Behavioral witnesses live
  as unit-tier tests so they run under `verify:pr`'s `test:unit`; the successor gate
  script is added to `verify:pr` (strengthening it — the veto only forbids weakening) so
  no retired invariant vanishes silently. Tests asserting legacy-wins behavior are
  inverted or removed per AGENTS.md.
- **Runner-up**: Invert the gate in place into a single post-cutover gate — lost because
  one inverted gate would mix lifecycle-shadow invariants (still pre-cutover under D005)
  with filesystem-state invariants (now post-cutover), asserting contradictory authority
  models in one script; the four-class disposition (flip/keep/delete-timeboxed/port)
  needs two homes, not one.
- **Evidence**: evidence-domain.md § Post-cutover homes divide the gate's invariants into
  four classes; evidence-pitfalls.md § Retiring the no-cutover gate drops invariants that
  have no successor home, and no CI runs the gates today; evidence-similar.md §
  Kubernetes feature gates have a staged retirement where disabling a non-operational
  gate fails loudly; evidence-stack.md § The no-cutover gate is a ready-made
  decomposition map
- **Confidence**: medium — the per-invariant disposition list is analysis, not an
  existing repo decision; wave 1 validates the mapping against the gate source.

### Mixed-version concurrent writers during the cutover window

- **Decision**: Migrate only inside the startup EXCLUSIVE claim (no concurrent writer can
  hold the DB mid-flip). Post-cutover binaries stamp schema version + authority epoch so
  any binary new enough to check refuses loudly on skew; WAL + lease tables
  (`unit-claims.db`, `milestone_leases` fencing) keep same-version multi-worktree writes
  correct as today. For pre-cutover binaries that cannot check the epoch (mixed-version
  worktrees sharing one project), rely on the existing drift-detection surface plus a
  release-note directive to upgrade all linked worktrees together, and accept the bounded
  residual risk for a local single-host CLI.
- **Runner-up**: Build a cross-version coordination shim so pre-cutover binaries detect
  cut-over projects — lost because pre-cutover released binaries cannot be patched
  retroactively; any shim only helps future old versions, and the exposure window is the
  user-chosen downgrade window, already bounded by that ruling.
- **Evidence**: evidence-pitfalls.md § Concurrent-writer protection is WAL + lease tables
  on local disk only; mixed-version worktrees during cutover are uncoordinated;
  evidence-stack.md § Concurrent-writer safety rests on three existing mechanisms;
  evidence-migration.md § SQLite's official backup guidance + the repo's EXCLUSIVE
  startup lock
- **Confidence**: low — the skew scenario is inferred, not tested ⇒ wave-1 spike: run a
  pre-cutover binary against a cut-over project fixture and record actual behavior
  (read-only? corrupts projections? silent divergence?) before finalizing the guard.

## For the planner

<!-- The shape of the build. -->
- **Wave-1 blockers**:
  1. Run `baseline:refactor:gate`, `baseline:refactor:phase0`, `gate:semantic-shadow-no-cutover`,
     and `legacy:cleanup:gate` at clean HEAD — every closeout claim is 2026-05-04 vintage,
     doc-claimed, never re-run; the whole plan assumes a green baseline that is unverified.
  2. D005 scoping verification: map the 13 T07 deferred blockers to filesystem-state vs.
     canonical-lifecycle — confirm none blocks filesystem-state deletion; write the
     milestone decision doc that supersedes D005 for filesystem authority only.
  3. Mixed-version skew spike (low-confidence decision above): pre-cutover binary vs.
     cut-over project fixture; record observed behavior.
  4. Authoritative parsers-legacy importer union: domain found 15, pitfalls found
     `github-sync/sync.ts` additionally — produce the complete verified inventory with
     per-consumer disposition (re-point / projection-read / delete).
- **Walking skeleton**: One project, end to end: a fixture `~/.gsd` project is migrated
  via the authority-cutover domain op inside the EXCLUSIVE claim (verified backup +
  receipt + idempotent re-entry as no-op); `deriveState` serves the real runtime path
  from the DB with files rendered as stamped read-only projections; one parsers-legacy
  consumer (`markdown-renderer.ts` reading its own projections back) is re-pointed to DB
  reads; rollback is demonstrated by restoring the verified backup; the successor gate
  plus re-homed unit checks are green. No canonical-lifecycle changes.
- **Pitfalls → tasks**:
  - Fabricated all-zero evidence report (pitfalls § evidence pipeline) → task: redesign
    `legacy:cleanup:evidence` to fail closed on missing telemetry and add the static
    no-caller/no-importer proof as the state-path evidence.
  - No field telemetry for the installed base (pitfalls § no field telemetry) → task:
    gate deletion on static proof + fail-loud shims; document accepted residual risk in
    the milestone decision doc; do not promise proof that cannot exist.
  - Hidden readers, 15+ parsers-legacy importers incl. github-sync (pitfalls § hidden
    readers) → task: per-consumer migration driving the importer registry to zero
    production importers before `parsers-legacy.ts` deletion.
  - Renderer reads its own projections back (domain § parsers-legacy consumers) → task:
    re-point `markdown-renderer.ts` merge paths (lines ~1084/1118/1221) to DB reads in
    the walking skeleton.
  - Partial-migration destination wedge (pitfalls § failed `~/.gsd` migration) → task:
    self-healing destination cleanup/ownership in the cutover migration so transient
    copy errors never permanently block retry on user machines.
  - Downgrade fails loud but with no restore path (pitfalls § downgrade story) → task:
    ship/decide the backup-restore command per the user's downgrade-window ruling.
  - Mixed-version worktree skew (pitfalls § concurrent writers) → wave-1 spike, then
    task: authority-epoch stamp + loud refusal + release-note directive.
  - Gate invariants vanish silently; no CI runs gates (pitfalls § gate retirement) →
    task: split-retire the gate, re-home witnesses to the unit tier, wire the successor
    gate into `verify:pr` (strengthen, never weaken).
  - Permanent-coexistence drift (stack § external pattern evidence; migration §
    ParallelChange) → the milestone itself is the contract phase; task: timebox the
    ADR-046-window witnesses with explicit deletion dates/releases.
  - Corrupt DB wedges startup; stale WAL sidecars (similar § Codex CLI failure modes) →
    task: migration hardening — narrow corruption-error matching, quarantine-never-delete
    backup handling, rebuild-from-projection as recovery source of last resort.

## User rulings

<!-- NEEDS-USER items answered at the synthesis checkpoint. Verbatim-ish. -->
- **[NEEDS-USER] Rollback tolerance: how many released versions must a downgrade stay
  readable for?** (carried verbatim from INTENT.md) — options:
  1. **1 release** — the immediately previous release must read a cut-over project's
     projections; anything older gets the loud refuse-newer guard plus manual backup
     restore.
  2. **2 stable releases + ≥60 days** — mirrors the ADR-046 compatibility-window
     precedent already in repo governance; requires shipping the explicit backup-restore
     command in this milestone.
  3. **Time-based, 90 days** — window ends on calendar, not release count; simplest to
     communicate, weakest protection for users who skip releases.
- **RULING 2026-08-01**: user: "your lean" → **Option 2 (2 stable releases + ≥60 days,
  ADR-046 window)**, the lean presented with the question. Consequences: the explicit
  backup-restore command ships in this milestone; ADR-046-timeboxed deletions (unadopted
  import/reconcile, frozen cross-mode witnesses) share this window; the deletion commit
  may not land until the window has elapsed after the cutover release.

## Still unknown

<!-- Carried-forward gaps. Never let a question vanish between phases. -->
- Current pass/fail status of `baseline:refactor:gate`, `baseline:refactor:phase0`,
  `gate:semantic-shadow-no-cutover`, `legacy:cleanup:gate` at HEAD — closeout claims are
  2026-05-04 vintage, doc-claimed only — **wave-1 spike** (run the gates at clean HEAD).
- Whether any of the 13 T07 deferred blockers touches filesystem-state deletion (vs.
  canonical-lifecycle authority only) — **wave-1 spike** (blocker mapping in the D005
  scoping task).
- Observed behavior of a pre-cutover binary opening a cut-over project (silent
  divergence vs. loud failure vs. read-only) — **wave-1 spike** (mixed-version fixture).
- Complete union of parsers-legacy production importers (domain's 15 vs. pitfalls' 15
  +github-sync) and the full set of out-of-repo readers behind the `.gsd` symlink —
  inventory **wave-1 spike** for the in-repo union; out-of-repo reader set is
  unobservable — **accept risk** (projection format frozen; documented in milestone
  decision doc).
- Depth of coupling in `integrations/hermes` (Python) to projection file formats —
  **accept risk** (format freeze makes this moot for this milestone; revisit when the
  projection contract is ever versioned).
- Rollback tolerance / downgrade readability window — **RULED 2026-08-01**: 2 stable
  releases + ≥60 days (ADR-046 window); see User rulings. The deletion commit may not
  land until the window has elapsed after the cutover release.
