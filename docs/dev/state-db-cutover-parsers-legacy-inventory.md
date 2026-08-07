# parsers-legacy importer union inventory with per-consumer dispositions

Wave-1 deliverable (T004) for the state-DB cutover milestone. This is the
authoritative union inventory of production importers of
`src/resources/extensions/gsd/parsers-legacy.ts`, with a disposition per
importer for the wave-3 consumer tasks (T008, T010–T014) and the wave-4
deletions (T020, T022). Disposition classes per `.project/research/SYNTHESIS.md`
("parsers-legacy consumer web"):

- **(a) re-point** — consumer switches to DB-backed reads; the parsers-legacy
  import is removed.
- **(b) stamped projection-read** — legitimate projection read; kept, but
  re-homed onto the relocated shared parsers and validated against the DB
  state-version stamp.
- **(c) delete** — the code that imports parsers-legacy is deleted together
  with the legacy path (or, for the markdown import path, only its dependency
  on the legacy module is deleted after parser relocation).

## Verified union (16 production importers)

| # | Importer | Import site(s) | Disposition | Executing task |
|---|----------|----------------|-------------|----------------|
| 1 | `src/resources/extensions/gsd/doctor.ts` | `parseLegacyRoadmap` imported at line 4; used at line 157 to parse ROADMAP content for a diagnostics-only report | (a) re-point — diagnostics surface reads slice state from the DB instead of parsing the projection | T010 |
| 2 | `src/resources/extensions/gsd/doctor-state-checks.ts` | `parseLegacyRoadmap`/`parseLegacyPlan` imported at line 5; used at lines 216/367 with the comment at line 358 "prefer DB, fall back to parsers-legacy" | (a) re-point — state checks already prefer the DB; drop the legacy fallback and read the DB only | T010 |
| 3 | `src/resources/extensions/gsd/doctor-engine-checks.ts` | `parsePlan` imported at line 31; used at line 149 to read task checkboxes for engine diagnostics | (a) re-point — diagnostics-only comparison of PLAN checkboxes vs DB status; read task status from the DB | T010 |
| 4 | `src/resources/extensions/gsd/reactive-graph.ts` | `parsePlan` imported at line 18; used at line 238 in an explicit degraded-mode fallback when the DB has no task rows (warns on use) | (a) re-point — after T007 the DB is authoritative at the derive seam; the degraded-mode fallback is removed and the graph reads DB task rows | T010 |
| 5 | `src/resources/extensions/gsd/artifact-verification.ts` | `parseLegacyRoadmap`/`parseLegacyPlan` imported at line 7; used at lines 338/462/537 in pre-migration/DB-unavailable recovery fallback branches | (a) re-point — recovery verification re-pointed to DB-backed reads; the pre-migration fallback branches go away with the cutover | T010 |
| 6 | `src/resources/extensions/gsd/workspace-index.ts` | `parseRoadmap`/`parsePlan` imported at line 5; used at lines 115/177 to build a display-only workspace index | (a) re-point — display/telemetry-only surface reads the DB | T011 |
| 7 | `src/resources/extensions/gsd/visualizer-data.ts` | `parseRoadmap`/`parsePlan` imported at line 9; used at lines 867/903 to feed the visualizer | (a) re-point — display-only surface reads the DB | T011 |
| 8 | `src/resources/extensions/gsd/auto-prompts.ts` | `parseRoadmap` imported at line 26; used at lines 1084/1675/1693/3328/3537 to build prompt context strings | (a) re-point — prompt context is display text injected into unit prompts; source the same fields from the DB | T011 |
| 9 | `src/resources/extensions/github-sync/sync.ts` | `parseRoadmap`/`parsePlan` imported at line 14; used at lines 164/246/326 to render GitHub issue/PR bodies | (a) re-point — display-only GitHub body sync reads the DB | T011 |
| 10 | `src/resources/extensions/gsd/commands-maintenance.ts` | dynamic `await import("./parsers-legacy.js")` at line 71; `parseRoadmap` used at line 108 in maintenance commands | (a) re-point — maintenance command reads milestone completion from the DB; lands with the backup-restore command | T014 |
| 11 | `src/resources/extensions/gsd/markdown-renderer.ts` | `parseRoadmap`/`parsePlan` imported at line 51; used in the self-read-back merge/stale-render paths (`parseProjectionByIdentity` at lines 1084/1118) and the render-verification helper `roadmapRenderMarksSliceDone` at line 1221 | (a) re-point — the projection writer stops parsing its own projections back; merge/self-read-back paths re-point to DB reads and projections gain an additive DB state-version stamp | T008 |
| 12 | `src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts` | `parseRoadmap` imported at line 17; used at line 56 to parse the ROADMAP projection for drift comparison against the DB | (b) stamped projection-read — drift detection compares projection vs DB by design; after T012 relocates the shared parsers it reads via the new parser home and validates against the DB state-version stamp | T013 |
| 13 | `src/resources/extensions/gsd/state-reconciliation/drift/sketch-flag.ts` | `parsePlan` imported at line 18; used at line 75 to distinguish a real plan from a stub before clearing a stale `is_sketch` flag (#1287) | (b) stamped projection-read — same drift-detection rationale as roadmap.ts; re-home onto the relocated parsers and validate against the DB state-version stamp | T013 |
| 14 | `src/resources/extensions/gsd/state.ts` | `parseRoadmap`/`parsePlan` imported at lines 21–23; used only inside `_deriveStateImpl` (lines 273/393/404/869), the pre-migration markdown fallback | (c) delete — T007 flips read authority at the derive seam so the markdown fallback is unreachable on the live path; T022 deletes `_deriveStateImpl` and with it this import | T007 / T022 |
| 15 | `src/resources/extensions/gsd/md-importer.ts` | `parseRoadmap`/`parsePlan` imported at line 50; used at lines 719/825 to parse legacy markdown INTO the DB | (c) delete — legacy markdown import into the DB stays; only its dependency on the legacy module goes once T012 relocates the shared parsers to `schemas/parsers.ts` | T012 |
| 16 | `src/resources/extensions/gsd/migration-auto-check.ts` | `parsePlan`/`parseRoadmap` imported at line 11; used at lines 190/200 by the pre-migration auto-check | (c) delete — same as md-importer: the migration check keeps working against the relocated parsers; only the parsers-legacy import is deleted | T012 |

## Grep vs allowlist vs research-count reconciliation

- **Mechanical grep** (task step 1 command:
  `grep -rln "parsers-legacy" src/resources/extensions --include="*.ts" | grep -v "/tests/" | grep -v "\.test\."`)
  returns **18 paths**.
  - `gsd/parsers-legacy.ts` is the module itself, not an importer → 17.
  - `gsd/files.ts` matches the bare string only in comments (lines 56/61/67
    describe the cache-clear callback parsers-legacy registers); it has no
    import statement and does not match the registry test's `IMPORT_RE`
    (`from "…parsers-legacy…"`, `import(…)`, or `require(…)`) → **16 actual
    production importers**.
- **Registry allowlist** (`ALLOWED_IMPORTERS` in
  `src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts`) names
  exactly the same 16 paths — a 1:1 match with the grep-derived importer set,
  no missing and no stale entries (the registry test's own "no stale entries"
  assertion enforces this continuously).
- **Research counts**: evidence-domain.md found 15 non-test importers scoped to
  the gsd extension (its list omits `github-sync/sync.ts`); evidence-pitfalls.md
  found the hidden 16th importer, `github-sync/sync.ts` (a separate bundled
  extension), at line 14. The verified union is 15 + 1 = **16**, matching both
  the grep and the allowlist exactly.
- **Test-only importers** (excluded from all production counts): 12 test files
  reference parsers-legacy (`tests/auto-recovery.test.ts`,
  `tests/complete-slice.test.ts`, `tests/integration/auto-recovery.test.ts`,
  `tests/legacy-import-corpus.test.ts`, `tests/markdown-renderer.test.ts`,
  `tests/migrate-writer.test.ts`, `tests/parsers-legacy-importers.test.ts`,
  `tests/parsers.test.ts`, `tests/plan-milestone.test.ts`,
  `tests/plan-slice.test.ts`, `tests/plan-task.test.ts`,
  `tests/planning-crossval.test.ts`, `tests/replan-handler.test.ts`,
  `tests/roadmap-slices.test.ts` — 14 by raw grep, with
  `parsers-legacy-importers.test.ts` being the registry itself and the rest
  exercising the parsers directly); the registry walker skips `tests/`
  directories and `*.test.ts`, so they never enter the allowlist. Their fate is
  owned by the wave-3/4 tasks that move or delete the parsers they exercise.

## Downstream contract

- Wave-3 consumer tasks T008, T010, T011, T012, T013, T014 execute the
  dispositions above; T016 reconciles the registry allowlist afterward (it is
  the single wave-3 owner of `parsers-legacy-importers.test.ts`).
- T020 deletes `parsers-legacy.ts` only when the registry shows zero production
  importers; T022's deletion of `_deriveStateImpl` removes the final (c)-class
  import, so the wave-4 order is T022 → T020.
- No production code is modified by this task; this document is inventory and
  assignment only.
