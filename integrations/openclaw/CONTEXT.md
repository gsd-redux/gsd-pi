# CONTEXT — open-gsd-openclaw plugin

A bounded context: the OpenClaw chat gateway to GSD Pi. This is a glossary,
not a spec. Implementation decisions live in code; the tracking issue
(open-gsd/gsd-pi#2134) records the alternatives that were surveyed.

## Domain glossary

- **GSD command surface (chat)**: the `/gsd` subcommands the plugin registers
  with the OpenClaw Gateway through `api.registerCommand`. The Gateway dispatches
  them before any model or agent runtime is selected, so they behave the same on
  every first-party channel, runtime, and provider. Phase 1: `status`, `bind`,
  `unbind`, `help`.
- **Route**: the conversation identity a command arrives on (channel, account,
  conversation id, thread). Bindings are keyed by route, not by session key,
  because native slash commands and typed commands run under different session
  keys for the same chat. Owned by `binding.ts`.
- **Binding resolution**: explicit path argument → conversation binding →
  `defaultProject`. Nothing is inferred from a working directory; with no match
  the command fails closed and names the source it consulted.
- **Read seam**: `gsd read progress --json --project <dir>`, the versioned
  envelope (`integration_version: 1`) the plugin consumes. It is the only child
  process this phase can run. Owned by `gsd-cli.ts`.
- **Snapshot**: the compact chat rendering of the read seam (phase, active
  milestone/slice/task, counts, blockers, next action). Project-derived content,
  posted unredacted; only CLI stderr is redacted. Owned by `snapshot.ts` and
  `redact.ts`.
- **Host authorization**: `/gsd` declares `requiredScopes: ["operator.write"]`
  and keeps no allowlist of its own; OpenClaw's command-owner rules decide who
  may run it. The README's "What a sender can reach" section is the threat model.
- **Service**: the one `api.registerService` entry that owns plugin state under
  `<stateDir>/plugin-state/open-gsd-openclaw/`.

## Boundaries

- The package is a pnpm workspace member at `integrations/openclaw`, built by
  `pnpm run build:integrations` (not part of `build:core`) and published as
  `@opengsd/open-gsd-openclaw`. Only `src/index.ts` imports the OpenClaw SDK;
  `src/openclaw-sdk.d.ts` declares the structural subset the plugin uses.
- No GSD engine changes: everything the plugin needs comes from the existing
  `gsd read` and `gsd headless --supervised` contracts.
