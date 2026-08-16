---
id: T004
title: Produce the authoritative parsers-legacy importer union inventory with per-consumer dispositions
wave: 1
deps: []
status: done
agent: build_T004
commit: ad1187974803678c68c03d2a30417745a1731653
base: 254f51d046caa5863956f350210749b6daab680c
worktree: .worktrees/gsd-path-T004
task_branch: gsd-path/T004
files:
  - docs/dev/state-db-cutover-parsers-legacy-inventory.md
---

# T004 — Authoritative parsers-legacy importer union inventory with dispositions

## Context

Deletion of the legacy read path is a consumer-web migration, not a function
deletion (SYNTHESIS.md). Domain research found 15 production importers of
`src/resources/extensions/gsd/parsers-legacy.ts`; pitfalls research found
`github-sync/sync.ts` additionally. The enforcement seam is the registry test
`src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts`, whose
`ALLOWED_IMPORTERS` allowlist currently names 16 production importers (15 in
the gsd extension plus `github-sync/sync.ts`). Wave-3 consumer tasks
(T010–T014) execute the dispositions this inventory assigns; T020 deletes
`parsers-legacy.ts` only when the registry shows zero production importers.
Disposition classes per synthesis: (a) re-point to DB-backed reads, (b)
legitimate projection-read — kept but stamped/validated against the DB
state-version stamp, (c) deleted with the path.

## Steps

1. Verify the union mechanically: run
   `grep -rln "parsers-legacy" src/resources/extensions --include="*.ts" | grep -v "/tests/" | grep -v "\.test\."`
   and cross-check against the `ALLOWED_IMPORTERS` set in
   `src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts`.
   Investigate and explain any difference between the grep result, the
   allowlist, and the 15+1 research counts (e.g. test-only importers,
   `parsers-legacy.ts` itself).
2. For each of the 16 production importers, read the actual import sites and
   assign one disposition — (a) re-point, (b) stamped projection-read, or
   (c) delete — with a one-line justification grounded in the code, not the
   allowlist comment. Expected mapping per synthesis (verify, don't assume):
   - re-point (a): `gsd/doctor.ts`, `gsd/doctor-state-checks.ts`,
     `gsd/doctor-engine-checks.ts`, `gsd/reactive-graph.ts`,
     `gsd/artifact-verification.ts`, `gsd/workspace-index.ts`,
     `gsd/visualizer-data.ts`, `gsd/auto-prompts.ts`,
     `gsd/commands-maintenance.ts`, `github-sync/sync.ts`,
     `gsd/markdown-renderer.ts` (merge/self-read-back paths ~lines
     1084/1118/1221);
   - stamped projection-read (b): `gsd/state-reconciliation/drift/roadmap.ts`,
     `gsd/state-reconciliation/drift/sketch-flag.ts` (drift detection compares
     projection vs DB by design — after T012 relocates the shared parsers off
     parsers-legacy, these read projections via the new parser home and
     validate against the DB state-version stamp);
   - delete with the path (c): the fallback branches in `gsd/state.ts`
     (`_deriveStateImpl`), and the parsers-legacy import itself in
     `gsd/md-importer.ts` / `gsd/migration-auto-check.ts` after the shared
     parsers are relocated to `schemas/parsers.ts` (legacy markdown IMPORT
     into the DB stays — only its dependency on the legacy module goes).
3. Write `docs/dev/state-db-cutover-parsers-legacy-inventory.md`: the verified
   union list (all 16 paths), per-importer import-site summary, disposition,
   target wave-3 task id (T008 for markdown-renderer, T007/T022 for state.ts,
   T010, T011, T012, T013, T014), and the grep/allowlist reconciliation.

## Acceptance criteria

1. The inventory file lists exactly the 16 production importers (or an
   explicitly reconciled different count with evidence) and assigns each a
   disposition of (a), (b), or (c) with justification.
2. Every disposition names its executing task id from PLAN.md.
3. The grep vs allowlist vs research-count reconciliation is stated.
4. No production code is modified.

## Verify

```bash
grep -q "github-sync/sync.ts" docs/dev/state-db-cutover-parsers-legacy-inventory.md && grep -q "markdown-renderer.ts" docs/dev/state-db-cutover-parsers-legacy-inventory.md && grep -q "md-importer.ts" docs/dev/state-db-cutover-parsers-legacy-inventory.md && grep -qE "re-point|projection-read|delete" docs/dev/state-db-cutover-parsers-legacy-inventory.md && grep -qE "T0(07|08|10|11|12|13|14|20|22)" docs/dev/state-db-cutover-parsers-legacy-inventory.md
```

## Log

- 2026-08-01 — created by planner
- 2026-08-01 — coder: mechanically verified the union — grep yields 18 hits; minus `parsers-legacy.ts` (self) and `files.ts` (comment-only, no import per registry IMPORT_RE) = 16 production importers, exactly matching the 16-entry `ALLOWED_IMPORTERS` allowlist and the 15 (domain, gsd-scoped) + 1 (pitfalls, `github-sync/sync.ts`) research union. Read every import site and assigned dispositions: (a) re-point ×11 (doctor.ts, doctor-state-checks.ts, doctor-engine-checks.ts, reactive-graph.ts, artifact-verification.ts → T010; workspace-index.ts, visualizer-data.ts, auto-prompts.ts, github-sync/sync.ts → T011; commands-maintenance.ts → T014; markdown-renderer.ts → T008), (b) stamped projection-read ×2 (drift/roadmap.ts, drift/sketch-flag.ts → T013), (c) delete ×3 (state.ts `_deriveStateImpl` → T007/T022; md-importer.ts, migration-auto-check.ts → T012). Wrote `docs/dev/state-db-cutover-parsers-legacy-inventory.md`. Verify: PASS. No production code modified.
