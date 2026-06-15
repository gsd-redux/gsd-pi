// Structural invariant: parsers-legacy is banned from decision paths (ADR-017).
//
// The DB is the single source of truth; `.gsd/*.md` files are projections.
// Dispatch/gate/completion code must read state via gsd-db queries (e.g.
// getMilestoneSliceSummaries), never by parsing markdown projections.
//
// Two assertions:
// 1. Decision-path modules must NOT import parsers-legacy (hard ban).
// 2. Every other importer must be on the explicit allowlist below, each with
//    a one-line justification. When this test fails, do not extend the
//    allowlist for a decision path — add/extend a query in db/queries.ts and
//    read the DB instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const extensionsDir = join(process.cwd(), "src/resources/extensions");

// Modules that make dispatch/gate/completion decisions. Importing
// parsers-legacy here is always a violation, allowlist or not.
const BANNED_DECISION_PATHS = new Set([
  "gsd/auto-direct-dispatch.ts",
  "gsd/dispatch-guard.ts",
  "gsd/auto-verification.ts",
  "gsd/auto-dispatch.ts",
  "gsd/auto-post-unit.ts",
  "gsd/milestone-closeout.ts",
  "gsd/auto/phases.ts",
  "gsd/auto/pre-dispatch.ts",
  "gsd/auto/dispatch.ts",
  "gsd/auto/unit-phase.ts",
  "gsd/auto/finalize.ts",
  "gsd/auto/closeout.ts",
  "gsd/auto/orchestrator.ts",
  "gsd/auto/loop.ts",
  "gsd/tools/complete-slice.ts",
]);

// Legitimate importers. Each entry carries its justification; anything not
// listed here (and not under a tests/ directory) fails the test.
const ALLOWED_IMPORTERS = new Set([
  // migration/import: parses markdown to populate the DB
  "gsd/md-importer.ts",
  "gsd/workflow-migration.ts",
  "gsd/migration-auto-check.ts",
  // drift detection: compares markdown projection against DB by design
  "gsd/state-reconciliation/drift/roadmap.ts",
  // stale-render detection + render verification helpers over rendered output
  "gsd/markdown-renderer.ts",
  // pre-migration fallback: deriveState must work before the DB exists
  "gsd/state.ts",
  // explicit degraded-mode fallback when DB has no task rows (warns on use)
  "gsd/reactive-graph.ts",
  // recovery path: explicit pre-migration/DB-unavailable fallback branches
  "gsd/auto-recovery.ts",
  // diagnostics-only surfaces: report on projections, make no dispatch decisions
  "gsd/doctor.ts",
  // display/telemetry-only surfaces
  "gsd/workspace-index.ts",
  "gsd/visualizer-data.ts",
  // prompt context text (display strings injected into unit prompts)
  "gsd/auto-prompts.ts",
  // cold-path maintenance command (branch cleanup messaging)
  "gsd/commands-maintenance.ts",
  // display-only GitHub issue/PR body sync
  "github-sync/sync.ts",
]);

const IMPORT_RE = /from\s+["'][^"']*parsers-legacy(?:\.js)?["']|import\(\s*["'][^"']*parsers-legacy(?:\.js)?["']\s*\)|require\(\s*["'][^"']*parsers-legacy(?:\.js)?["']\s*\)/;

function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "tests" || ent.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts")) continue;
      if (ent.name.startsWith(".")) continue;
      if (ent.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

function findImporters(): string[] {
  const importers: string[] = [];
  for (const file of walkTsFiles(extensionsDir)) {
    const rel = relative(extensionsDir, file).split("\\").join("/");
    if (rel === "gsd/parsers-legacy.ts") continue; // the module itself
    const content = readFileSync(file, "utf-8");
    if (IMPORT_RE.test(content)) importers.push(rel);
  }
  return importers.sort();
}

test("decision-path modules do not import parsers-legacy (ADR-017)", () => {
  const violations = findImporters().filter((rel) => BANNED_DECISION_PATHS.has(rel));
  assert.deepEqual(
    violations,
    [],
    `Decision-path modules must read the DB (db/queries.ts, e.g. getMilestoneSliceSummaries), ` +
      `not parse .gsd/*.md projections. Violations:\n  ${violations.join("\n  ")}`,
  );
});

test("every parsers-legacy importer is on the explicit allowlist", () => {
  const unexpected = findImporters().filter((rel) => !ALLOWED_IMPORTERS.has(rel));
  assert.deepEqual(
    unexpected,
    [],
    `New parsers-legacy importer(s) detected:\n  ${unexpected.join("\n  ")}\n` +
      `If this is migration/drift/display-only code, add it to ALLOWED_IMPORTERS ` +
      `with a one-line justification. If it makes dispatch/gate/completion ` +
      `decisions, read the DB instead (db/queries.ts).`,
  );
});

test("allowlist has no stale entries", () => {
  const importers = new Set(findImporters());
  const stale = [...ALLOWED_IMPORTERS].filter((rel) => !importers.has(rel));
  assert.deepEqual(
    stale,
    [],
    `Allowlist entries no longer import parsers-legacy — remove them:\n  ${stale.join("\n  ")}`,
  );
});
