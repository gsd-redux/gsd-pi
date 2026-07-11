# ADR-023: Post-Unit Hook Outcomes Live in Artifact Frontmatter

**Status:** Accepted
**Date:** 2026-06-03

> **ADR-046 disposition:** [ADR-046](./ADR-046-database-authoritative-workflow-lifecycle.md)
> supersedes artifact frontmatter as a canonical outcome, required-work,
> idempotency, or routing contract. Hook artifacts and frontmatter may remain
> human-readable projections or durable output references, but immutable
> Verification Evidence, Technical Verdicts, and recovery routing live in the
> project database. The body below is retained as history.

Post-Unit Hook Outcomes use YAML frontmatter on the configured hook artifact as the canonical machine-readable contract. The artifact body remains human-readable review, verification, or diagnostic prose, while frontmatter records the verdict, severity, and required work needed for orchestration decisions.

Hook-authored verdicts describe the finding. Hook execution state is recorded separately by the runtime, so a cancelled, timed-out, or failed hook is not represented by a `failed` verdict in the artifact.

An `advisory` verdict records a finding without required work. Even for a Post-Unit Gate, a cleanly completed advisory outcome permits Unit progression.

`needs-attention` pauses for human review. Automated scheduling is reserved for rework and remediation outcomes whose required work is explicit enough for orchestration to route.

Severity is informational metadata for display and triage. Routing is driven by verdict and explicit block routing, not by severity thresholds.

Post-Unit Gates require a durable outcome source, such as a configured artifact. Missing required output is a gate failure; Advisory Post-Unit Hooks may still omit durable artifacts.

Configuration validation rejects a Post-Unit Gate that lacks a durable outcome source. Silent downgrade to advisory behavior would hide a user-requested gate.

For Advisory Post-Unit Hooks, artifact existence may remain an idempotency signal even when the artifact has no outcome frontmatter. The stricter outcome-frontmatter requirement applies to Post-Unit Gates because they make progression decisions.

This keeps the hook's human output and machine outcome together and follows existing GSD artifact patterns such as milestone validation and UAT assessment verdicts. Legacy `retry_on` sentinel files remain supported as a compatibility signal that maps to trigger-Unit rework, but sentinel existence is not the canonical outcome contract for new Post-Unit Gates.
