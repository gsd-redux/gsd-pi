# ADR-006: Extension Modularization & Install Infrastructure

**Status:** Accepted — In Progress
**Date:** 2026-03-28 (accepted), last updated 2026-04-23
**Deciders:** Jeremy McSpadden
**Tracking Issue:** [#2995](https://github.com/gsd-build/gsd-2/issues/2995)
**Related:** [ADR-007](./ADR-007-model-catalog-split.md) (model catalog split), [ADR-010](./ADR-010-pi-clean-seam-architecture.md) (pi clean seam), `packages/pi-coding-agent/src/core/extensions/`, `src/resources/extensions/`

## Context

GSD2 ships as a monolith: 177K LOC in the core `gsd` extension, 20 bundled extensions, 19 bundled skills, 842 MB `node_modules`. Every user gets everything — playwright, koffi, every AI provider SDK, every skill — whether they use it or not.

The extension system infrastructure is mature (discovery, registry, manifests, enable/disable, rich ExtensionAPI), but everything ships bundled. There is no mechanism to install, update, or uninstall extensions after initial setup.

### Problems

1. **Bloated install size** — 842 MB node_modules; users who never use browser automation still download playwright (14 MB); macOS-only koffi costs 86 MB for everyone.
2. **Slow startup** — 20 extensions loaded eagerly; barrel import in `cli.ts` pulls 57K LOC on every invocation.
3. **Monolithic core** — 177K LOC gsd extension is a single unit with deep internal coupling; modifying one feature risks breaking others.
4. **Architecture coupling** — `shared` → `gsd` reverse dependency, `gsd` ↔ `cmux` bidirectional coupling, 5+ extensions import `gsd/preferences.js` by file path.
5. **Provider SDK waste** — 48 MB of AI provider SDKs loaded even though users typically use 1–2 providers.

## Decision

Modularize GSD2 across 7 milestones (v1.3–v1.9), each independently shippable.

### v1.3: Foundation & Install Infrastructure

- Remove unused root dependencies, relocate misplaced workspace deps.
- Fix reverse dependency: `shared/rtk-session-stats.ts` → `gsd/paths.js`.
- Fix bidirectional coupling: `gsd/auto.ts` ↔ `cmux/` via event-based contract.
- Define extension package format (npm packages with `gsd.extension: true` marker).
- Implement `gsd extensions install/uninstall/update` commands.
- Extension discovery for `~/.gsd/extensions/` installed extensions.
- Extension dependency enforcement at load time (topological loader).

### v1.4: Tier 1 Extension Extraction

- Extract 8 self-contained, zero-coupling extensions to npm packages.
- `browser-tools` (-14 MB), `mac-tools` (-86 MB), `context7`, `google-search`, `claude-code-cli`, `aws-auth`, `universal-config`, `mcp-client`.
- ~100 MB `node_modules` savings.

### v1.5: Preferences API & Tier 2 Extraction

- Add `preferences` service to ExtensionAPI (read-only for non-core extensions).
- Add shared utilities service (`pi.utils.debug`, `pi.utils.paths`, `pi.utils.rtk`).
- Extract 6 more extensions: `search-the-web`, `subagent`, `voice`, `async-jobs`, `remote-questions`, `slash-commands`.
- Zero direct file-path imports from `gsd/` in any non-core extension.

### v1.6: Skills & Agent Packs

- Move 18 skills and 2 agents to installable packs via `npx skills add`.
- 4 skill packs: web-design (9), meta (3), debug (2), integration (2).
- 1 agent pack: language (JS/TS pros).
- Core ships with only `lint`, `review`, `test` skills.

### v1.7: GSD Core Decomposition

- Create `@gsd/extension-sdk` package for shared utilities.
- Extract sub-extensions: parallel orchestrator, watch/dashboard, doctor, forensics, workflow templates, marketplace.
- Extract `github-sync` (most coupled non-core extension).
- Core `gsd` extension: 177K → 15–20K LOC.

### v1.8: Provider Lazy Loading

- Lazy-load AI provider SDKs (only active provider imported at runtime).
- Move non-default provider SDKs to `optionalDependencies`.
- Graceful missing SDK handling with install prompts.

### v1.9: Barrel Import Optimization

- Create subpath exports for `@gsd/pi-coding-agent`.
- Lazy-import non-essential modules in `cli.ts`.
- Target: ~50% cold-start time reduction.

## Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Extensions as npm packages with `gsd.extension: true` | Leverages existing npm ecosystem; no custom registry needed |
| Installed to `~/.gsd/extensions/` (separate from bundled) | Clean separation; installed can override bundled by ID |
| Event-based decoupling over direct imports | Breaks bidirectional coupling; extensions communicate via `pi.on()`/`pi.emit()` |
| Preferences as read-only ExtensionAPI service | Prevents conflicts; core owns preferences, others consume |
| Permissive defaults for unknown extensions | Installed extensions override bundled; fails open to preserve behavior |
| `@gsd/extension-sdk` for shared utilities | Single import target replaces 6+ file-path imports from gsd internals |
| Deprecation stubs for 2 major versions | Extracted extensions leave a stub that suggests `gsd extensions install` |

## Success Metrics

| Metric | Current | After v1.4 | After v1.7 | After v1.9 |
|--------|---------|------------|------------|------------|
| Core extension LOC | 177,000 | 177,000 | 15,000–20,000 | 15,000–20,000 |
| Bundled extensions | 20 | 12 | 5 | 5 |
| Bundled skills | 19 | 19 | 3 | 3 |
| `node_modules` size | 842 MB | ~742 MB | ~600 MB | ~450 MB |
| Cold startup (`gsd --version`) | ~1.5s | ~1.3s | ~0.8s | ~0.4s |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Breaking existing user workflows | Medium | High | Deprecation stubs with install hints; bundled for 2 versions |
| Extension dependency conflicts | Medium | Medium | Isolate extension `node_modules`; peerDep on core |
| GSD core decomposition regressions | High | High | Extensive integration tests; one sub-extension at a time |
| npm publish friction for users | Medium | Medium | Auto-suggest installs; `--recommended` bundle |
| Supply-chain / arbitrary npm execution | Medium | High | Mandatory `--ignore-scripts` on install; checksum + trusted-provider registry (open; see Progress) |

## Consequences

**Positive:**
- Dramatically smaller default install (842 MB → ~450 MB).
- Faster startup (1.5s → ~0.4s cold start).
- Maintainable core (177K → 15–20K LOC).
- Extension ecosystem enables community contributions.
- Users only pay for features they use.

**Negative:**
- Users must install extensions for non-core features (mitigated by onboarding wizard).
- More moving parts in distribution (npm packages, version management).
- Migration period where both bundled and installed extensions coexist.

## Progress

| Milestone | Status | Landed | Notes |
|-----------|--------|--------|-------|
| **v1.3** Foundation & install infra | ✅ Shipped | [#4694](https://github.com/gsd-build/gsd-2/pull/4694), [#4697](https://github.com/gsd-build/gsd-2/pull/4697) (2026-04-23) | Revival of stale [#3030](https://github.com/gsd-build/gsd-2/pull/3030); 19 commits cherry-picked onto current main. Decoupling + validator + `install/uninstall/update` + topological loader all landed. |
| **v1.4** Tier 1 extraction | 🟡 In Progress (1/8) | [#4696](https://github.com/gsd-build/gsd-2/pull/4696) (2026-04-23) | `google-search` extracted as the reference pattern; deprecation stub + `gsd extensions validate` subcommand landed. Remaining: `browser-tools`, `mac-tools`, `context7`, `claude-code-cli`, `aws-auth`, `universal-config`, `mcp-client`. |
| **v1.5** Preferences API + Tier 2 | ⬜ Not started | — | Blocked on v1.4 completion. |
| **v1.6** Skills & agent packs | ⬜ Not started | — | Requires stable `GSDExtensionAPI` ([#3338](https://github.com/gsd-build/gsd-2/issues/3338)) before encouraging third-party authors. |
| **v1.7** Core decomposition | ⬜ Not started | — | Largest milestone; 177K → 15–20K LOC. |
| **v1.8** Provider SDK lazy loading | ⬜ Not started | — | Independent of other milestones; can parallelize. |
| **v1.9** Barrel import optimization | ⬜ Not started | — | Final startup-perf milestone. |

### Forensic Context

The v1.3/v1.4 revival on 2026-04-23 followed from forensic reconciliation of stalled PRs #3030 (v1.3 foundation, 1,726 commits behind main) and #3036 (Phase 10 pilot, closed stale 2026-04-20). Rather than rebase across the drift, commits were cherry-picked onto current main. See `.planning/forensics/report-20260422-phase10-missing.md` (local-only) for the full trace.

### Open Cross-Cutting Items

- **Supply-chain security:** Checksum verification and trusted-provider registry for `gsd extensions install` — called out in initial reviews, not yet designed.
- **Stable `GSDExtensionAPI`:** Tracking [#3338](https://github.com/gsd-build/gsd-2/issues/3338). Blocks v1.6 community-author enablement.
- **Architecture enforcement:** Ports/hexagonal suggestion from community review (2026-04-23) — unresolved.
