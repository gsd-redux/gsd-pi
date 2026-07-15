You are running the GSD **audit-milestone** workflow — verify a milestone achieved its definition of done before it is archived.

## Target

{{target}}

## Process

1. **Load the milestone.** Read the milestone's ROADMAP entry, its slices' plans and SUMMARY/ASSESSMENT artifacts, and the requirements/acceptance criteria. If a specific milestone id was given, target it; otherwise target the active or most-recently-completed milestone.

2. **Aggregate per-slice verification.** For each slice, confirm its tasks were completed and its verification strategy was satisfied (tests pass, UAT recorded). Flag slices with incomplete verification.

3. **Check requirements coverage.** Map each requirement/acceptance criterion to the slice(s) and tasks that delivered it. Flag any requirement with no covering evidence.

4. **Check cross-slice integration.** Identify slices that touch shared resources (APIs, data models, state) and confirm their integration points are consistent — no broken handoffs, conflicting schemas, or sequencing gaps.

5. **Aggregate debt and deferred items.** Collect tech debt, deferred tasks, and known gaps into a single list with severity and owner-hint.

6. **Produce the verdict.** Report: `PASS` (done-of-definition met), `NEEDS-ATTENTION` (gaps that need a human call), or `NEEDS-REMEDIATION` (gaps that block archival). Recommend `/gsd dispatch validate` with current evidence or schedule remediation. Mention `/gsd verdict` only for an explicitly unadopted compatibility milestone; adopted milestones reject manual overrides.

## Success criteria

- Every requirement is mapped to covering evidence or flagged as uncovered.
- Cross-slice integration risks are explicit, not assumed away.
- The verdict is one of the three canonical values with supporting evidence.
- Debt/deferred items are listed, not silently dropped.
