# Evidence — similar

<!-- Written by one researcher role. Consumed by the synthesizer. -->

Dimension: similar
Questions assigned: none (all findings tied to INTENT.md risks: hidden readers, thin telemetry, live-data migration, downgrade story, concurrent writers, gate retirement)

## Finding: Kubernetes proves a deprecated path is dead with a purpose-built usage gauge, not absence-of-complaints

- **Claim**: Since v1.19, every request to a deprecated Kubernetes API sets an `apiserver_requested_deprecated_apis` gauge (labeled by group/version/resource plus `removed_release`), adds a Warning header, and annotates the audit event; operators can join the gauge against `apiserver_request_total` to measure — not guess — remaining usage before removal, and the deprecation policy then binds removal to explicit timelines (e.g. beta APIs unserved 9 months/3 releases after deprecation). Deprecated metrics additionally pass through a "hidden" stage (unregistered but re-enableable via `--show-hidden-metrics-for-version`) for one release before deletion.
- **Source**: https://kubernetes.io/docs/reference/using-api/deprecation-policy/ (opened; Rule #4a/4b, REST-resource telemetry section, metric deprecation rules #11a/11b)
- **Confidence**: high
- **Why it matters here**: Directly answers the "thin telemetry" risk: the proof that the legacy filesystem-state path is unused (`legacy:cleanup:evidence`) should be an instrumented counter on the legacy read/write path itself, shipped at least one release before deletion — the k8s pattern shows measurement is added first, removal is gated on it, and an escape hatch (hidden stage) survives one more cycle.

## Finding: Kubernetes mandates a version-skew window so rollback never strands state written by the newer release

- **Claim**: Deprecation-policy Rule #4b forbids advancing the preferred/storage version until a release exists that supports both old and new, explicitly so users "can upgrade to a new release and then roll back to a previous release without converting anything... or suffering breakages"; a companion note forbids removing any API version that has been persisted to storage, requiring the server to remain able to decode previously persisted data even after the endpoint is disabled.
- **Source**: https://kubernetes.io/docs/reference/using-api/deprecation-policy/ (opened; Rule #4b and the #52185 storage note)
- **Confidence**: high
- **Why it matters here**: This is the "downgrade story" risk formalized: the cutover release must keep emitting (or be able to regenerate) the file projections the previous binary reads, so that rolling back the CLI never leaves DB-authored state unreadable; it also sets a precedent that "stop serving" and "stop being able to decode old data" are separable stages.

## Finding: Kubernetes feature gates have a staged retirement where disabling a non-operational gate fails loudly instead of running silently

- **Claim**: k8s feature gates move disabled-by-default (alpha) → enabled-by-default (beta) → deprecated and non-operational at GA → removed after the deprecation window (GA gates must function ≥6 months or 2 releases); critically, "when an invocation tries to disable a non-operational feature gate, the call fails in order to avoid unsupported scenarios that might otherwise run silently," and deprecated gates must warn and be documented in release notes and CLI help.
- **Source**: https://kubernetes.io/docs/reference/using-api/deprecation-policy/ (opened; "Deprecating a feature or behavior", Rules #9/#10)
- **Confidence**: high
- **Why it matters here**: Maps to the gate-retirement risk for `gate:semantic-shadow-no-cutover`: inverting/retiring the gate should not silently drop its invariants — the k8s pattern makes the retired gate an explicit error with the protected invariants re-homed as named checks, rather than a no-op that lets a misconfiguration run silently.

## Finding: npm evolved its lockfile format with explicit per-version compatibility windows and kept writing legacy fields for downgraders

- **Claim**: npm's `package-lock.json` format is versioned (`lockfileVersion` 1/2/3); v2 (npm 7–8) is documented as "backwards compatible to v1 lockfiles" and v3 (npm 9+) as "backwards compatible to npm v7"; npm v7 continued to maintain the legacy `dependencies` section "in order to support switching between npm v6 and npm v7," auto-upgrades old lockfiles on install by backfilling missing data, and states it "will always attempt to get whatever data it can out of a lockfile, even if it is not a version that it was designed to support."
- **Source**: https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json (opened; `lockfileVersion`, "Handling Old Lockfiles", `dependencies` section)
- **Confidence**: high
- **Why it matters here**: A shipped CLI's answer to "downgrade must not strand user data": keep the old representation as a maintained projection during the compatibility window (exactly gsd-pi's DB→file projection plan), auto-migrate forward on first run, and degrade gracefully (best-effort read) instead of hard-failing on newer/older formats — concrete precedent for the NEEDS-USER "how many released versions must a downgrade stay readable for" question.

## Finding: Git's plumbing/porcelain split made the low-level object format the stable contract, which is why external tooling survived decades of UI change

- **Claim**: Git is "fundamentally a content-addressable filesystem with a VCS user interface written on top of it"; the plumbing commands (operating on `.git/objects`, `refs`, `HEAD`, `index`) are "designed to be chained together UNIX-style or called from scripts" as building blocks for other tools, while the user-friendly porcelain layer was free to be refined from a complex early UI into the modern one without breaking script consumers.
- **Source**: https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain (opened)
- **Confidence**: medium (primary doc, but the "plumbing is a de facto stable API" inference is interpretive)
- **Why it matters here**: Speaks to the "hidden readers" risk: any on-disk state format that external tools, scripts, or other extensions read becomes a de facto stable API regardless of intent — before files become "pure projections," gsd-pi needs an explicit policy for what stability the projection layer promises (and to enumerate those readers), because Git's experience is that the low-level format, not the UI, is what the ecosystem binds to.

## Finding: Jujutsu replaced lock files with an operation log that always commits and merges divergent heads instead of blocking writers

- **Claim**: jj's repo state is a DAG of "operation" objects pointing at "view" objects (heads, bookmarks, working-copy commits) in content-addressed storage; every command loads a consistent view and always succeeds in writing its operation — concurrent writers create divergent op-log heads, which the next command 3-way merges, recording conflicts (e.g. a bookmark moved two ways) in the view instead of erroring; the op-log head is tracked via atomic add-then-remove of empty marker files. jj explicitly rejects lock files because they corrupt on distributed filesystems and serialize non-conflicting operations.
- **Source**: https://docs.jj-vcs.dev/latest/technical/concurrency/ (opened)
- **Confidence**: high
- **Why it matters here**: Directly informs the "concurrent writers" risk with dozens of linked worktrees: a single-writer invariant can be enforced by an append-only operation log with deterministic conflict surfacing rather than by blocking; also a cautionary data point — jj documents that its Git backend is "not entirely lock-free" and repository corruption is possible, i.e. the invariant is only as strong as the storage backend's atomicity.

## Finding: Jujutsu treats the working copy as a recoverable projection of the store, with explicit staleness detection and a recovery-commit path

- **Claim**: Every jj command runs snapshot → mutate-in-memory-and-record-operation → update-working-copy; the working copy records which operation it was last updated to, so a missed or interrupted step 3 is detected as "stale" and repaired with `jj workspace update-stale`; if the underlying operation was lost, the update creates a "recovery commit" from the working-copy contents parented to the current operation — i.e. the projection can be rebuilt from the store, and store loss can be partially rebuilt from the projection.
- **Source**: https://docs.jj-vcs.dev/latest/working-copy/ (opened; "Stale working copy")
- **Confidence**: high
- **Why it matters here**: A working blueprint for "files as pure read-only projections": stamp each projection with the DB state version it was rendered from, detect staleness by comparing stamps instead of trusting file contents, and provide an explicit repair command — and note the bidirectional lesson that projections double as a disaster-recovery source if the authoritative store is lost, which matters for the live-data migration risk in `~/.gsd`.

## Finding: Android Room ships migration correctness as a tested artifact chain: exported schema history in VCS plus tests that run old-version databases through every migration

- **Claim**: Room requires exporting the database schema as JSON at compile time and storing it in version control "so that you can re-create lower versions of the database for testing"; its `MigrationTestHelper` creates a database at an old version, seeds it with raw SQL, runs `runMigrationsAndValidate`, and the official guidance is to test *all* migrations end-to-end ("migrateAll"); a missing migration path throws `IllegalStateException` at runtime, and downgrade behavior is an explicit builder choice (`fallbackToDestructiveMigrationOnDowngrade`) rather than an accident.
- **Source**: https://developer.android.com/training/data-storage/room/migrating-db-versions (opened)
- **Confidence**: high
- **Why it matters here**: The most transferable migration-engineering pattern for the `~/.gsd` live-data migration: version the state schema, commit fixtures of real old-version state, and make idempotency/rollback tests run the actual old→new path — and make the downgrade behavior an explicit, tested decision (which the intent's NEEDS-USER rollback-tolerance question must settle) instead of undefined behavior.

## Finding: Chromium's deprecation pipeline is measure → deprecate ≥1 milestone → disable behind a runtime flag → monitor after Stable → only then delete code

- **Claim**: Chromium requires feature removals to first add a `UseCounter` measurement (which takes 5–9 weeks just to reach Stable telemetry), deprecate for at least one milestone, land the removal behind a runtime-enabled feature flag, disable by default, monitor "developer chatter and bug reports for at least a month or two" after the change hits Stable (with the flag retained so the feature can be turned back on "if the removal goes particularly badly"), and only as Step 9 "Remove Code — once it's clear that developers are no longer relying on the disabled feature."
- **Source**: https://www.chromium.org/blink/launching-features/ (opened; "Feature deprecations", Steps 1–9)
- **Confidence**: high
- **Why it matters here**: Validates gsd-pi's evidence→gate→delete ordering (`legacy:cleanup:evidence` → `legacy:cleanup:gate` → delete) and quantifies the "thin telemetry" risk: measurement itself has a latency cost, so instrumentation of the legacy path must ship well before the deletion milestone; the retained runtime flag as a post-removal safety valve is a concrete model for keeping a re-enable path during the first release(s) after the legacy path is bypassed but before it is deleted.

## Finding: A shipped agent CLI with SQLite state in `~/.codex` shows the failure modes to design against: corrupt DB wedges startup, and the proposed fix is narrow error matching + timestamped quarantine + rebuild-from-projection

- **Claim**: OpenAI's Codex CLI/Desktop issue reports show `state_5.sqlite` corruption (truncated file, stale `-wal`/`-shm` sidecars, "file is not a database" code 26) blocking all startup with no automatic recovery, and a separate "migration 1 was previously applied but has been modified" error leaving the VS Code extension stuck with no official repair path; the community-proposed fix restricts recovery to the specific corruption error, quarantines the file and sidecars with a `.corrupt-<UTC timestamp>` suffix (never deletes), recreates via the existing migrator, and rebuilds metadata from the JSONL files that are the durable record.
- **Source**: https://github.com/openai/codex/issues/21750 (opened); corroborating: https://github.com/openai/codex/issues/27361 (search result content)
- **Confidence**: medium-high (issue reports with code references, not a merged design doc)
- **Why it matters here**: This is gsd-pi's exact shape (shipped CLI, SQLite state under a home directory, files as rebuildable record) hitting the "live-data migration" and "downgrade story" risks in production: migration must be idempotent and distinguish corruption from real migration/lock/permission failures, back up by quarantining rather than deleting, and treat the file projections as the rebuild source of last resort.

## Assigned questions — answers

- None assigned directly. Each finding above names the INTENT.md risk it addresses: thin telemetry (k8s metric, Chromium UseCounter), downgrade story (k8s Rule #4b, npm lockfileVersion, Room downgrade fallback), gate retirement (k8s feature gates), concurrent writers (jj op-log), hidden readers (Git plumbing/porcelain, Chromium dev-trial step), live-data migration (Room, Codex), projection fidelity (jj working copy).

## Dead ends

<!-- What was checked and didn't pan out, so nobody re-treads it. -->
- VS Code state-storage migration to SQLite — search returned unrelated noise (openai/codex issues, Ghost CLI forum posts about `@vscode/sqlite3`); no primary microsoft/vscode design doc or issue was opened within budget. The Codex findings partially cover the same ground (editor-adjacent SQLite state).
- Mozilla support page `https://support.mozilla.org/en-US/kb/dedicated-profiles-firefox-installation` — fetch returned a JS-blocked shell; Firefox's downgrade-protection design (`compatibility.ini`, `--allow-downgrade`) is real and visible in secondary sources and Bugzilla (bug 1610712 thread surfaced in search), but no clean primary doc was opened, so it was not promoted to a finding. It would support the same "block downgrade loudly rather than corrupt silently" lesson already covered by npm/Room.
- 1Password 8 / Obsidian Sync storage internals — no public primary engineering sources (design docs, ADRs, or source) on their SQLite cutover/downgrade handling; blog-level material only, below the evidence bar.
- JetBrains IDE state/index storage migrations — no primary design documents surfaced quickly; platform sources are closed. Not pursued further.
