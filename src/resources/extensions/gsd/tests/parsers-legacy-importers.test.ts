// Structural invariant: the legacy markdown state parsers are banned from
// decision paths (ADR-017).
//
// The DB is the single source of truth; `.gsd/*.md` files are projections.
// Dispatch/gate/completion code must read state via gsd-db queries (e.g.
// getMilestoneSliceSummaries), never by parsing markdown projections.
//
// KEYED ON SYMBOLS, NOT THE MODULE SPECIFIER (T033). T012 relocated the legacy
// parsers byte-identically from parsers-legacy.ts to schemas/parsers.ts, and
// the wave-3 consumer migration mostly rewrote the import path around unchanged
// call sites. A registry keyed on the `parsers-legacy` specifier alone reads
// "one importer left" while seven modules parse legacy markdown via the same
// functions at their new home. This registry therefore counts a module as a
// legacy-parser consumer when it references `parseLegacyRoadmap`/`parseLegacyPlan`
// OR imports the parsers-legacy shim. It mirrors, and must stay in agreement
// with, scripts/legacy-state-path-proof.mjs.
//
// Two assertions:
// 1. Decision-path modules must NOT consume the legacy parsers (hard ban).
// 2. Every other consumer must be on the explicit allowlist below, each with
//    a one-line justification naming the task that retires it (or `none` when
//    no task owns it yet). When this test fails, do not extend the allowlist
//    for a decision path — add/extend a query in db/queries.ts and read the DB
//    instead.
//
// End state: T020 deletes the parsers-legacy shim and T022 deletes state.ts's
// pre-migration fallback, but both are gated on the allowlist reaching empty —
// which now requires the seven relocated-symbol consumers to be addressed
// first. The allowlist only ever shrinks: a new entry is a regression, not a
// migration step.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const extensionsDir = join(process.cwd(), "src/resources/extensions");

// Modules that make dispatch/gate/completion decisions. Consuming the legacy
// parsers here is always a violation, allowlist or not.
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

// Tolerated consumers, each with a justification naming the task that retires
// it, or `none` when no task owns it yet. Anything not listed here (and not
// under a tests/ directory) fails the test. `none` is not an excuse — it is the
// honest record that the legacy read path is still in production use and that
// T020/T022 are unreachable until these are addressed.
const ALLOWED_IMPORTERS = new Set([
  // pre-migration fallback: `_deriveStateImpl` must work before the DB exists.
  // Only remaining importer of the parsers-legacy shim — retired by T022.
  "gsd/state.ts",
  // verify-time reads of ROADMAP/PLAN projections. Retired by: none.
  "gsd/artifact-verification.ts",
  // doctor diagnostic reads PLAN task checkboxes. Retired by: none.
  "gsd/doctor-engine-checks.ts",
  // roadmap self-read-back during projection render. Retired by: none.
  "gsd/markdown-renderer.ts",
  // markdown → DB import, parses by design. Retired by: none.
  "gsd/md-importer.ts",
  // pre-migration detection, parses by design. Retired by: none.
  "gsd/migration-auto-check.ts",
  // drift detection compares both sources by design. Retired by: none.
  "gsd/state-reconciliation/drift/roadmap.ts",
  // drift detection compares both sources by design. Retired by: none.
  "gsd/state-reconciliation/drift/sketch-flag.ts",
]);

// The re-export shim itself, and the declaration home of the relocated
// symbols. Neither is a consumer; T020 deletes the shim once the allowlist is
// empty, and the symbols retire with their last caller.
const SELF_PATHS = new Set(["gsd/parsers-legacy.ts", "gsd/schemas/parsers.ts"]);

// Specifier anywhere in a string literal — covers `from '…'`, `import('…')`,
// `require('…')`, the side-effect form (`import './parsers-legacy.js';`) and
// the specifier-on-its-own-line form.
const SPECIFIER_RE = /["'][^"']*parsers-legacy(?:\.js)?["']/;
// The legacy exports of schemas/parsers.ts that parse projection markdown as a
// data source. `parseRoadmap` is the unrelated validation parser, not listed.
const LEGACY_PARSER_SYMBOL_RE = /\b(?:parseLegacyRoadmap|parseLegacyPlan)\b/;

/** Blank out `//` and `/* … *\/` comments, preserving string literals, so a
 *  banned symbol named in prose is not a false positive. */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let inBlock = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

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
    if (SELF_PATHS.has(rel)) continue; // the shim and the symbols' own home
    const code = stripComments(readFileSync(file, "utf-8"));
    if (SPECIFIER_RE.test(code) || LEGACY_PARSER_SYMBOL_RE.test(code)) importers.push(rel);
  }
  return importers.sort();
}

test("decision-path modules do not consume the legacy parsers (ADR-017)", () => {
  const violations = findImporters().filter((rel) => BANNED_DECISION_PATHS.has(rel));
  assert.deepEqual(
    violations,
    [],
    `Decision-path modules must read the DB (db/queries.ts, e.g. getMilestoneSliceSummaries), ` +
      `not parse .gsd/*.md projections. Violations:\n  ${violations.join("\n  ")}`,
  );
});

test("every legacy-parser consumer is on the explicit allowlist", () => {
  const unexpected = findImporters().filter((rel) => !ALLOWED_IMPORTERS.has(rel));
  assert.deepEqual(
    unexpected,
    [],
    `New legacy-parser consumer(s) detected:\n  ${unexpected.join("\n  ")}\n` +
      `If this is migration/drift/display-only code, add it to ALLOWED_IMPORTERS ` +
      `with a one-line justification naming the retiring task (or \`none\`). If it ` +
      `makes dispatch/gate/completion decisions, read the DB instead (db/queries.ts).`,
  );
});

test("allowlist has no stale entries", () => {
  const importers = new Set(findImporters());
  const stale = [...ALLOWED_IMPORTERS].filter((rel) => !importers.has(rel));
  assert.deepEqual(
    stale,
    [],
    `Allowlist entries no longer consume the legacy parsers — remove them:\n  ${stale.join("\n  ")}`,
  );
});
