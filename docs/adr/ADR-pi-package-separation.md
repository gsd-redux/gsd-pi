// GSD-2 + docs/adr/ADR-pi-package-separation.md — Decision record for separating upstream Pi packages from GSD behavior

# ADR: Pi Package Separation

## Status

Proposed

## Context

GSD currently vendors the Pi package family under `packages/pi-*` and builds it as part of the root package. GSD also adapts Pi runtime behavior through loader environment variables, bundled resource staging, and extension discovery. This makes upstream updates expensive because GSD-specific behavior can be mixed into Pi-owned source.

The current package boundary is useful for local development, but it does not clearly separate three different concerns:

- Upstream Pi runtime packages: `@gsd/pi-coding-agent`, `@gsd/pi-ai`, `@gsd/pi-agent-core`, `@gsd/pi-tui`, and the native package they build with.
- GSD compatibility setup: branding, config directory selection, package root paths, resource paths, and extension path staging.
- GSD extension behavior: bundled, community, and project-local extensions loaded through the extension SDK.

## Decision

GSD will treat Pi as an upstream-owned runtime with a GSD-owned compatibility boundary. Pi-owned packages may expose stable extension/plugin APIs, but GSD-specific workflow behavior must live in GSD source or GSD extensions.

The first separation step keeps the Pi packages in the npm workspace while extracting the GSD compatibility layer into source files owned by GSD:

- `src/pi-compat.ts` owns Pi runtime environment setup.
- `src/pi-extension-host.ts` owns the conversion from GSD resource locations to Pi extension entry paths.
- Root npm scripts distinguish upstream Pi builds from GSD runtime builds.
- Extension docs describe the public import surface plugins and extensions can rely on.

Externalizing Pi to npm, git subtree, or another upstream sync mechanism remains a later decision after this boundary is tested.

## Consequences

- Upstream Pi updates should be tested by rebuilding Pi packages and then running GSD compatibility tests.
- GSD extensions should import public types from `@gsd/pi-coding-agent`, `@gsd/pi-ai`, and `@gsd/pi-tui`.
- Direct relative imports from GSD source into Pi internals must be migrated behind compatibility modules unless explicitly justified.
- GSD-specific patches should land in GSD compatibility files or GSD extensions before editing Pi-owned internals.
- A real upstream update trial still requires an approved upstream Pi source and target version.
