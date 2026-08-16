# Plan 045 — Whole-repo dead-code cleanup program

**Status:** approved (not executed)  
**Map:** [Wayfinder: whole-repo dead-code cleanup program](https://github.com/open-gsd/gsd-pi/issues/1741)  
**Approved in:** [Approve the dated cleanup program in plans/](https://github.com/open-gsd/gsd-pi/issues/1746)  
**Tree:** `origin/main` @ `cdc4fd1f23c24db22a0ccacde6495e8e8ec05840`  
**Prior art:** [Plan 032 — Lean & Mean Cleanup](032-lean-mean-cleanup.md), [Plan 032a — Dead Code & Unused-Dependency Audit](032a-dead-code-audit.md)  
**Draft ledger (path-level LOW-LEAD):** [`.project/research/045-dead-code-ledger.md`](https://github.com/open-gsd/gsd-pi/blob/research/dead-code-ledger/.project/research/045-dead-code-ledger.md)

This file is the execution-ready program. It does **not** delete or archive anything. Implementation follows after the map.

## Method

Refresh of 032a: `npx knip@latest --no-progress` (knip 6.32.2) as lead generator, then manual verification against published entry-point roots (package `exports` / bins, CLI flags, MCP tools, slash commands, workflow templates, skills). Tests are consumers, not roots. `studio/` is not an automatic root.

Raw knip capture: [045-knip-leads.md](https://github.com/open-gsd/gsd-pi/blob/research/knip-leads/.project/research/045-knip-leads.md).  
032a roll-forward: [045-032a-disposition.md](https://github.com/open-gsd/gsd-pi/blob/research/032a-disposition/.project/research/045-032a-disposition.md) (11 gone / 50 still valid / 1 changed).

## Tiers

| Tier | Meaning |
|---|---|
| **HIGH** | Unreachable after false-positive disposition. Each row names evidence and a verify gate. Safe to delete in the order below. |
| **MEDIUM** | Needs a human glance before delete or archive. |
| **LOW-LEAD** | Do not remove. Recorded so the next hunt does not re-litigate. |

## HIGH — delete in this order

### Gate 1 — `pnpm run build:core`

| Order | Path | Evidence |
|---|---|---|
| 1 | `packages/pi-ai/bedrock-provider.js` + `bedrock-provider.d.ts` | Unshipped one-line shims. Published export is `./dist/bedrock-provider.js`. Package `files` is `bin`, `dist`, `README.md` only. |
| 2 | `packages/mcp-server/src/readers/index.ts` | Unpublished barrel. `exports` names only `./readers/{graph,paths,roadmap,state}`. Package `src/index.ts` re-exports from the leaf files. No `readers/index` importers. |

### Gate 2 — `pnpm run typecheck:extensions`

| Order | Path | Evidence |
|---|---|---|
| 3 | `src/resources/extensions/gsd/compat/index.ts` | Unused barrel. Live callers import `./compat/compat-marker.js` (and siblings) directly. |
| 4 | `src/resources/extensions/gsd/migrate/index.ts` | Unused barrel. Live callers import leaf `./migrate/*.js` modules. |
| 5 | `src/resources/extensions/gsd/safe-fs.ts` | `safeMkdir` / `safeCopy` / `safeCopyRecursive` have no importers. One test mentions the filename as a string. |
| 6 | `src/resources/extensions/gsd/state/derive/interrupted-work.ts` | `detectInterruptedWork` / `interruptedWorkNextAction` have no callers. Header labels it a legacy path; it is dead, not dual-path residue. |

Do not batch both gates in one PR. Two PRs (or two commits with the named gate after each) so a failure names the class.

## MEDIUM — glance list (22)

032a leftovers (stay MEDIUM):

- `packages/gsd-agent-core/scripts/generate-session-decomposition.mjs`
- `packages/pi-ai/scripts/generate-test-image.ts`
- `src/resources/extensions/gsd/tests/integration/headless-command.ts`
- `studio/` (product call, not an automatic root)
- `tests/live-regression/benchmark.ts` — **changed** since 032a: `test:live-regression` now runs `run.ts`. File remains a manual harness. Owner chooses keep vs `scripts/archive/` at execution time.
- Root packaging deps: `balanced-match`, `brace-expansion`, `graceful-fs`, `retry`, `signal-exit` (gate if dropped: `validate-pack`)
- `@types/picomatch` (root `devDependencies`)

New glance rows:

- Unused package deps: `@gsd/native` (`@gsd/agent-core`), `@opengsd/contracts` (`@gsd/pi-coding-agent`), `extract-zip` (`@gsd/pi-coding-agent`), `@sinclair/typebox` (`@gsd/pi-tui`) — gate if dropped: `build:core`
- `web` unused devDeps: `@eslint/eslintrc`, `esbuild`
- Unused `web/components/gsd/{guided-dialog,onboarding/wizard-stepper,terminal}.tsx` and leftover `web/styles/globals.css` (named gates do not build `web/`)
- Unused-export remainder (788 unused exports / 537 unused exported types after FP disposition). First glance set: 61 unused exports in live `src/` CLI modules. Per-symbol `git grep` + a named gate before any delete.

## Scripts

No new `scripts/archive/` candidates. 032a already archived the unreferenced one-offs. `scripts/preview-dashboard.ts` stays (docs-referenced harness).

## LOW-LEAD — do not re-litigate

Summarized classes (full paths in the [draft ledger](https://github.com/open-gsd/gsd-pi/blob/research/dead-code-ledger/.project/research/045-dead-code-ledger.md)):

- jiti-discovered bundled extensions (`src/resources/extensions/*/index.ts` and tools)
- skill templates copied as text
- test worker fixtures spawned by path
- `packages/pi-coding-agent/examples/**` and other shipped examples
- shadcn / `web/components/ui/*` / `web/hooks/use-*`
- VS Code extension (manifest entry, not the import graph)
- package.json-script / CI / vendor / published `files` roots
- published package `exports` and bins
- 21 root-duplicate workspace deps (still `validate-pack`-gated)
- `@google/genai` and `ws` (dynamic `import()` from root — knip false positives)
- 032a §1f package/web leads (`canvas`, `@types/diff`, `@types/ms`, `shx`, `@xterm/xterm`)

220 unused-file false positives + 55 deps.

## Out of this program

- Executing the deletions (follows after this map)
- A standing CI knip gate
- Referenced dual-path residue
- God-module splits
- Slimming live characterization tests
- Dead branches inside live functions
- Consolidating live duplicate implementations
