# CONTEXT — open-gsd-openclaw plugin

A bounded context: the OpenClaw chat gateway to GSD Pi. This is a glossary,
not a spec. Implementation decisions live in code; the tracking issue
(open-gsd/gsd-pi#2134) records the alternatives that were surveyed.

## Domain glossary

- **GSD command surface (chat)**: the `/gsd` subcommands the plugin registers
  with the OpenClaw Gateway through `api.registerCommand`. The Gateway dispatches
  them before any model or agent runtime is selected, so they behave the same on
  every first-party channel, runtime, and provider. Read: `status`, `bind`,
  `unbind`, `help`. Runs: `auto`, `new-milestone`, `quick`, `reply`, `cancel`.
- **Supervised run**: one `gsd headless <command> --supervised
  --output-format stream-json` child per project, owned by the `Supervisor`
  (`supervisor.ts`). Its JSONL stdout is the event stream; interactive
  `extension_ui_request`s (select, confirm, input, editor) park the run as
  *blocked* until `/gsd reply` writes an `extension_ui_response` to stdin.
  Terminal signal is the child's `close`, never `exit`. A lockfile under
  `.gsd/runtime/` keeps the one-run-per-project guard across Gateway restarts.
- **Notifier** (`notify.ts`): delivers run events to the route that started the
  run through the channel outbound adapter, falling back to a session-scoped
  system event plus a heartbeat wake for WebChat, the CLI, or a declined send.
- **`gsd_status` tool** (`tool.ts`): the read seam plus the run line, exposed to
  the agent; declared in `contracts.tools`. `skills/gsd/SKILL.md` ships as an
  optional shared skill directory, not as a manifest `skills` entry: on
  OpenClaw 2026.8.2 that entry makes typed `/gsd` commands miss text-command
  matching (verified against a real Gateway; see the README).
- **Route**: the conversation identity a command arrives on (channel, account,
  conversation id, thread). Bindings are keyed by route, not by session key,
  because native slash commands and typed commands run under different session
  keys for the same chat. Owned by `binding.ts`.
- **Binding resolution**: explicit path argument → conversation binding →
  `defaultProject`. Nothing is inferred from a working directory; with no match
  the command fails closed and names the source it consulted.
- **Read seam**: `gsd read progress --json --project <dir>`, the versioned
  envelope (`integration_version: 1`) the plugin consumes. Owned by
  `gsd-cli.ts`.
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
