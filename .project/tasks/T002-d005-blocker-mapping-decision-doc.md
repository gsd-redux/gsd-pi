---
id: T002
title: Map T07 deferred blockers and write the D005 supersede-for-filesystem-state-only milestone decision doc
wave: 1
deps: []
status: done
agent: build_T002
commit: 47d3ee1ab5f8ef9a688fb41ae3dd0e76ab7c3daf
base: 254f51d046caa5863956f350210749b6daab680c
worktree: .worktrees/gsd-path-T002
task_branch: gsd-path/T002
files:
  - docs/dev/state-db-cutover-milestone-decision.md
---

# T002 — Map T07 deferred blockers; write D005 supersede-for-filesystem-state-only decision doc

## Context

Decision D005 (recorded in `.gsd/DECISIONS.md`, row `D005`) keeps legacy
handler responses and reads authoritative for M003 scope; the T07 dossier
(`docs/dev/m003-s07-cutover-dossier.json`, research docs
`docs/dev/M003-S07-T07-DOSSIER-RESEARCH.md`,
`docs/dev/M003-S07-T07-CUTOVER-DECISION-RESEARCH.md`,
`docs/dev/M003-S07-T07-UAT-SHIP-RESEARCH.md`) records a NO-GO for canonical
lifecycle read-authority cutover with named deferred blockers and zero live
observation rows for lifecycle reads. SYNTHESIS.md settles: this milestone
supersedes D005 ONLY for filesystem-state (markdown) authority — gsd-db
hierarchy reads are already the DB authority, files become pure projections,
the markdown fallback is deleted. The canonical *lifecycle* read-authority
cutover stays deferred under the M003 shadow program. Note a count discrepancy
to resolve: the checked dossier JSON lists 9 `deferredCutoverBlockers`;
SYNTHESIS.md references 13 named blockers. This task must reconcile the
authoritative count from the dossier JSON, the T07 research docs, and the
project DB record, and state the reconciliation explicitly.

## Steps

1. Read `.gsd/DECISIONS.md` (D005 row), `docs/dev/m003-s07-cutover-dossier.json`
   (`deferredCutoverBlockers`, `observationCoverage`, `recommendation`), and
   the three T07 research docs. Extract the authoritative full blocker list
   (the 9 dossier ids are: production-read-authority,
   canonical-dependency-eligibility, integrated-slice-source-uat-identity,
   closeout-effects, merge/publication-settlement — note the JSON spelling
   `merge-publication-settlement`, park-unpark-discard-adoption,
   projection-work-redesign, legacy-cascade-deletion,
   compatibility-retirement). Reconcile against SYNTHESIS.md's "13 named
   blockers": identify the additional blockers from the T07 research docs
   (e.g. zero live observation rows / observation-coverage items) or record
   that 9 is the authoritative count and 13 was a synthesis over-count.
2. For EVERY blocker in the reconciled list, classify: touches
   filesystem-state (markdown projection) deletion — YES/NO, with a one-line
   justification citing the dossier/research text. The expected outcome per
   synthesis is that all blockers concern canonical-lifecycle authority only;
   if any blocker touches filesystem-state deletion, mark the task BLOCKED
   and surface it — the plan scope changes.
3. Write `docs/dev/state-db-cutover-milestone-decision.md` recording: (a) the
   milestone decision — D005 is superseded for filesystem-state (markdown)
   read/write authority only; D005 remains in force for canonical lifecycle
   read authority, which stays deferred under the M003 shadow program and the
   successor gate `gate:lifecycle-shadow-no-cutover`; (b) the full blocker
   classification table from step 2; (c) the count reconciliation; (d)
   explicit statement that the out-of-repo reader set behind the
   `.gsd → ~/.gsd/projects/<hash>/` symlink is unobservable and that this risk
   is accepted via the frozen byte-compatible projection format; (e)
   statement that gate retirement never contradicts D005 by silence.

## Acceptance criteria

1. `docs/dev/state-db-cutover-milestone-decision.md` exists and contains the
   D005 supersede-for-filesystem-state-only decision, explicitly scoped.
2. Every blocker in the reconciled list appears in the file with a YES/NO
   filesystem-state classification and justification; all are NO, or the task
   is marked BLOCKED in its Log.
3. The count reconciliation (9 vs 13) is stated explicitly with its source.
4. No production code is modified.

## Verify

```bash
grep -q "D005" docs/dev/state-db-cutover-milestone-decision.md && grep -q "filesystem-state" docs/dev/state-db-cutover-milestone-decision.md && grep -q "production-read-authority" docs/dev/state-db-cutover-milestone-decision.md && grep -q "compatibility-retirement" docs/dev/state-db-cutover-milestone-decision.md && grep -qiE "reconcil" docs/dev/state-db-cutover-milestone-decision.md
```

## Log

- 2026-08-01 — created by planner
- 2026-08-02 — coder: reconciled blocker count from the dossier JSON (9
  `deferredCutoverBlockers` ids, authoritative), the T07 cutover-decision
  research (13 numbered NO-GO items), and the project DB record (zero live
  `lifecycle-shadow-observed` audit rows, corroborating
  `observationEvidencePlane: "capstone_fixture"`). Mapping: research items
  1,2,4,5,7 map 1:1 onto dossier ids; item 3 folds into
  `canonical-dependency-eligibility`; item 6 splits into two ids; items 8–9
  share `compatibility-retirement` (yielding 9 unique ids); items 10–11 are
  observation-coverage facts, item 12 a since-closed T07 verification
  prerequisite, item 13 the D005 governance precondition. Classified all 9
  blockers for filesystem-state deletion impact: all NO (each concerns
  canonical-lifecycle read authority or lifecycle compatibility surfaces
  only). Wrote `docs/dev/state-db-cutover-milestone-decision.md` recording
  the D005 supersede-for-filesystem-state-only decision, the full
  classification table, the 9-vs-13 reconciliation, the accepted
  unobservable-symlink-reader risk (frozen byte-compatible projection
  format), and the no-contradiction-by-silence gate-retirement statement.
  Verify: PASS (all five greps). No production code modified.
