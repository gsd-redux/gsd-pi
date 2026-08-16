// Project/App: gsd-pi
// File Purpose: Static no-caller/no-importer proof for the legacy state-read path.

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Discovery discipline: line-scoped regex, matching the existing importer
// registry (src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts).
// A TypeScript-AST scan was the alternative, but `typescript` is not a runtime
// dependency of scripts/ and the bans below are lexical (symbols and a module
// specifier), so the registry's regex discipline proves the same fact with no
// new dependency. Comments are stripped before matching so a mention in prose
// is not reported as usage.
//
// WHY SYMBOLS, NOT THE SPECIFIER: T012 relocated the legacy markdown state
// parsers byte-identically from parsers-legacy.ts to schemas/parsers.ts, and
// the wave-3 consumer migration mostly rewrote `from './parsers-legacy.js'` to
// `from './schemas/parsers.js'` around unchanged call sites. A proof keyed on
// the `parsers-legacy` specifier alone is therefore satisfied by a rename while
// the legacy read path is still in production use. This proof keys on the
// relocated SYMBOLS and keeps the specifier as an additional signal — a module
// importing the shim is still an offender.
const DERIVE_CALL_RE = /\b_deriveStateImpl\s*\(/;
const DERIVE_DECL_RE = /\bfunction\s+_deriveStateImpl\b/;
// Any occurrence of the specifier inside a string literal: covers `from '…'`,
// dynamic `import('…')`, `require('…')`, the side-effect form
// (`import './parsers-legacy.js';`, no `from`) and the specifier-on-its-own-line
// form that a line-scoped `from …` regex misses.
const PARSERS_LEGACY_SPECIFIER_RE = /["'][^"']*parsers-legacy(?:\.js)?["']/;
// The legacy exports of schemas/parsers.ts that parse projection markdown as a
// data source. `parseRoadmap` (schemas/parsers.ts:311) is the unrelated
// validation parser and is deliberately not listed.
const LEGACY_PARSER_SYMBOL_RE = /\b(?:parseLegacyRoadmap|parseLegacyPlan)\b/;

// The re-export shim: it is the module under ban, not a consumer of it, and
// T020 deletes it once the offender list is empty.
const PARSERS_LEGACY_SHIM = "/gsd/parsers-legacy.ts";
// The declaration home of the legacy parser symbols; T020/T022 retire the
// symbols themselves, so their definitions are not usage.
const LEGACY_PARSER_HOME = "/gsd/schemas/parsers.ts";

const SKIP_DIRS = new Set(["node_modules", "tests", "dist", "dist-test", ".git"]);

export const LEGACY_PROOF_SCAN_DIR = join("src", "resources", "extensions");

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { root: process.cwd(), json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a path");
      opts.root = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      opts.root = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

/** Blank out comments across a whole file, tracking `/* … *\/` state between
 *  lines so a block comment mentioning a banned symbol is not a false positive.
 *  String literals are skipped intact so a specifier containing `//` survives.
 *  Returns one code-only string per input line (line numbering preserved). */
export function stripComments(lines) {
  const out = [];
  let inBlock = false;

  for (const raw of lines) {
    let code = "";
    let quote = null;
    let i = 0;

    while (i < raw.length) {
      const ch = raw[i];
      const next = raw[i + 1];

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
        code += ch;
        if (ch === "\\") {
          code += next ?? "";
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        code += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 2;
        continue;
      }

      code += ch;
      i += 1;
    }

    out.push(code);
  }

  return out;
}

async function collectSourceFiles(dir) {
  const out = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // A missing scan directory is reported by the caller, not here.
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  }

  return out.sort();
}

export async function collectLegacyStatePathProof(opts = {}) {
  const root = opts.root ?? process.cwd();
  const scanDir = join(root, LEGACY_PROOF_SCAN_DIR);
  const offenders = [];

  for (const file of await collectSourceFiles(scanDir)) {
    const rel = relative(root, file).split(sep).join("/");
    const isShim = rel.endsWith(PARSERS_LEGACY_SHIM);
    const isParserHome = rel.endsWith(LEGACY_PARSER_HOME);
    const content = await readFile(file, "utf-8");
    const lines = content.split("\n");
    const code = stripComments(lines);

    for (let i = 0; i < lines.length; i += 1) {
      const line = code[i];
      const location = { file: rel, line: i + 1, text: lines[i].trim() };

      if (DERIVE_CALL_RE.test(line) && !DERIVE_DECL_RE.test(line)) {
        offenders.push({ kind: "deriveStateImplCaller", ...location });
      }
      if (!isShim && PARSERS_LEGACY_SPECIFIER_RE.test(line)) {
        offenders.push({ kind: "parsersLegacyImporter", ...location });
        continue;
      }
      if (!isShim && !isParserHome && LEGACY_PARSER_SYMBOL_RE.test(line)) {
        offenders.push({ kind: "legacyParserSymbol", ...location });
      }
    }
  }

  return {
    ok: offenders.length === 0,
    scanned: relative(root, scanDir).split(sep).join("/"),
    offenders,
  };
}

export function renderLegacyStatePathProofSummary(result) {
  const lines = [
    "gsd-pi Legacy State-Path Proof",
    `Scanned: ${result.scanned}`,
    `Status: ${result.ok ? "PASS" : "BLOCK"}`,
  ];

  if (result.offenders.length > 0) {
    lines.push("", "Offenders:");
    for (const offender of result.offenders) {
      lines.push(`- ${offender.kind} ${offender.file}:${offender.line} ${offender.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  try {
    const opts = parseArgs();
    const result = await collectLegacyStatePathProof(opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderLegacyStatePathProofSummary(result));
    }
    process.exitCode = result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
