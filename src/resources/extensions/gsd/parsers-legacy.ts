// DEPRECATED — deletion gated on zero production importers (T020); do not add imports.
// GSD Extension - Legacy Parsers
//
// ADR-017: the DB is the single source of truth; `.gsd/*.md` files are
// projections. These parsers may be imported ONLY for:
//   - drift detection that compares both sources by design
//     (state-reconciliation/drift, markdown-renderer stale-render detection)
//   - explicit pre-migration / DB-unavailable fallbacks (state.ts)
//   - diagnostics and display/telemetry-only surfaces (doctor,
//     doctor-git-checks, workspace-index, visualizer-data, auto-prompts
//     context text, commands-maintenance, milestone-closeout, github-sync)
//   - tests
//
// Dispatch/gate/completion DECISION paths must NOT import this module — they
// read the DB via gsd-db queries (e.g. getMilestoneSliceSummaries). Enforced
// by tests/parsers-legacy-importers.test.ts; new importers must be added to
// its allowlist with a one-line justification.
//
// T012: the parseRoadmap/parsePlan implementations moved byte-identically to
// schemas/parsers.ts (as parseLegacyRoadmap/parseLegacyPlan); this module now
// only re-exports them under their original names for the remaining consumers
// above until T020 deletes it.

// Re-export parseRoadmapSlices so callers can import all legacy parsers from one module
import { parseRoadmapSlices } from './roadmap-slices.js';
export { parseRoadmapSlices };

export {
  parseLegacyRoadmap as parseRoadmap,
  parseLegacyPlan as parsePlan,
  clearLegacyParseCache,
} from './schemas/parsers.js';
