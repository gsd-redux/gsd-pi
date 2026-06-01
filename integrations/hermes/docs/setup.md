# Hermes × GSD Gateway Setup Checklist

Manual validation before releasing `open-gsd-hermes` 1.2.x. Complete **local preflight** first, then run the **Slack** or **Telegram** gateway walkthrough on a real GSD project.

---

## Quick start

```bash
# End-user path after installing/upgrading @opengsd/gsd-pi
gsd hermes install --project /absolute/path/to/your/project
hermes plugins list                                  # open-gsd-hermes should be enabled
hermes gateway restart                               # or restart your Hermes CLI/gateway process

# Source-checkout validation path
npm run build:core                                   # dist/loader.js for read CLI
pip install -e integrations/hermes[dev]
bash integrations/hermes/scripts/preflight.sh        # local gates (no Hermes)
```

Record results in the [Sign-off](#sign-off) section at the bottom.

---

## Part 1 — Local preflight (no gateway)

Run before touching Slack or Telegram.

| Step | Command / check | Pass criteria |
|------|-----------------|---------------|
| P1 | `bash integrations/hermes/scripts/preflight.sh` | All checks ✓, exit 0 |
| P2 | `gsd --version` | Semver in `>=2.53,<3` (or your configured `gsd_version_min`) |
| P3 | `which gsd-mcp-server` | Binary on PATH or path set in `~/.hermes/gsd.yaml` |
| P4 | `gsd read progress --json --project <your-project>` | JSON with `"integration_version": 1` and `activeMilestone` |
| P5 | Project has `.gsd/` (or `.planning/`) with `STATE.md` | `read progress` shows phase/milestone |

**Fixture smoke (optional):**

```bash
node dist/loader.js read progress --json \
  --project integrations/hermes/tests/fixtures/minimal-project
# Expect activeMilestone.id == "M001"
```

---

## Part 2 — Hermes gateway setup

### Install plugin

Preferred end-user path:

```bash
gsd hermes install --project /absolute/path/to/your/project
hermes plugins list   # should show open-gsd-hermes enabled
```

Manual source-checkout path:

```bash
pip install -e /path/to/gsd-pi/integrations/hermes
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
cp -R /path/to/gsd-pi/integrations/hermes "$HERMES_HOME/plugins/open-gsd-hermes"
hermes plugins enable open-gsd-hermes
hermes plugins list   # should show open-gsd-hermes enabled
```

Restart the Hermes gateway after enabling the plugin.

### Configuration (`~/.hermes/gsd.yaml`)

```yaml
gsd:
  # Use absolute paths in production
  cli_path: /usr/local/bin/gsd          # or an executable wrapper around dist/loader.js
  mcp_server_path: /usr/local/bin/gsd-mcp-server
  credential_source: gsd                # 6a: GSD-managed API keys
  default_project: ~/code/myapp         # optional fallback
  poll_interval_seconds: 12
  cache_ttl_seconds: 45
  notification_level: normal            # quiet | normal | verbose
  bindings:
    slack:
      C0123456789: ~/code/myapp         # Slack channel ID (see below)
    telegram:
      "123456789": ~/code/myapp         # Telegram chat ID (see below)
```

**Binding tiers (first match wins):** cron explicit → slash argument → `/gsd bind` session binding → channel map → `default_project` → cwd heuristic.

**Credentials:** With `credential_source: gsd`, ensure GSD’s normal provider keys are configured (`~/.gsd/` or env). Hermes passthrough (`credential_source: hermes`) is 6b+.

### Verify plugin loaded

- [ ] Gateway logs show no `GsdVersionError` on startup
- [ ] `/gsd help` (or `/gsd` with no args) returns the command list
- [ ] No MCP spawn errors in logs when running `/gsd status`

---

## Part 3 — Slack gateway walkthrough

Use a **dedicated test channel** (not `#general`). Invite the Hermes bot.

### Slack-specific config

1. Copy the **channel ID** (right-click channel → *View channel details* → bottom of About, or from URL `C…`).
2. Add to `~/.hermes/gsd.yaml` under `bindings.slack` **or** skip and use `/gsd bind` only.
3. Ensure the Hermes Slack app has slash-command / message permissions for that channel.

**Session key shape (notifications):** `agent:main:slack:{chat_type}:{channel_id}`

Supervisor push uses `ctx.dispatch_tool("send_message", …)` — **not** `inject_message`.

### Slack checklist

#### Bind

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| S1 | `/gsd bind /absolute/path/to/project` | `Bound to \`/absolute/path/to/project\`` | [ ] |
| S2 | `/gsd status` | Snapshot with `## GSD Project Snapshot`, phase, active milestone/slice | [ ] |
| S3 | Wrong path: `/gsd bind /nonexistent` | Error or bind failure (path not a GSD project) | [ ] |

#### Auto + supervision

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| S4 | `/gsd auto` | `Started GSD auto mode (session \`<uuid>\`)` | [ ] |
| S5 | Wait for unit transition (or set `notification_level: verbose`) | Push message: `📋 GSD: milestone → …` or slice/task transition | [ ] |
| S6 | Send a normal message to the agent (not a slash command) | Agent context includes GSD snapshot (check Hermes debug/logs if available) | [ ] |

#### Blocker reply

Trigger a blocker (project with a pending gate, or auto mode that hits `AskUserQuestion`).

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| S7 | Auto blocks | Push: `🚧 GSD blocker: …` with `/gsd reply` hint | [ ] |
| S8 | `/gsd reply <your answer>` | `Blocker response sent.` | [ ] |
| S9 | `/gsd status` or wait for resume | Session no longer blocked; auto continues | [ ] |

#### Cancel

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| S10 | `/gsd auto` (new session) | Session id returned | [ ] |
| S11 | `/gsd cancel` while running | `Cancel requested.` then `⏹ GSD session cancelled.` push | [ ] |
| S12 | After cancel | No further transition notifications | [ ] |

#### Fail closed

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| S13 | New Slack thread/channel with **no** bind/default | `/gsd auto` → `No GSD project bound. Use \`/gsd bind <path>\`…` | [ ] |

---

## Part 4 — Telegram gateway walkthrough

Use a **private test chat** or small group where you control noise.

### Telegram-specific config

1. Get **chat ID** (message `@userinfobot`, or Bot API `getUpdates` after messaging the bot).
2. Add under `bindings.telegram` as a string key, **or** use `/gsd bind` per chat.
3. Ensure the Hermes Telegram bot is running and can receive commands in that chat.

**Session key shape:** `agent:main:telegram:{chat_type}:{chat_id}`

### Telegram checklist

Repeat the same flow as Slack (steps **S1–S13**), substituting Telegram commands:

| # | Action | Expected result | ✓ |
|---|--------|-----------------|---|
| T1 | `/gsd bind /absolute/path/to/project` | Bound confirmation | [ ] |
| T2 | `/gsd status` | GSD snapshot in reply | [ ] |
| T3 | `/gsd auto` | Session id in reply | [ ] |
| T4 | Transition notification | `📋 GSD: …` in chat | [ ] |
| T5 | Blocker + `/gsd reply <text>` | Blocker push, then `Blocker response sent.` | [ ] |
| T6 | `/gsd cancel` | Cancel confirmation + `⏹` push | [ ] |
| T7 | Unbound chat `/gsd auto` | Fail-closed bind error | [ ] |

**Telegram notes:**

- Long replies may split; confirm the **session id** line appears in the first chunk.
- In groups, ensure the bot receives commands (privacy mode / mention rules per Hermes config).

---

## Part 5 — Notification levels (6b)

Verify on **one** platform (Slack or Telegram):

| `notification_level` | Transitions | Blockers | Terminal (done/fail/cancel) |
|----------------------|-------------|----------|------------------------------|
| `quiet` | suppressed | ✓ | ✓ |
| `normal` (default) | ✓ | ✓ | ✓ |
| `verbose` | ✓ (all) | ✓ | ✓ |

- [ ] `quiet`: no `📋 GSD:` transition spam during auto
- [ ] `normal`: transitions + blockers + terminal messages appear
- [ ] `verbose`: same as normal (reserved for future detail)

---

## Part 6 — Cron + read CLI (optional, post-6a)

| # | Check | Pass | ✓ |
|---|-------|------|---|
| C1 | `hermes-gsd-cron ~/code/myapp` | Exit 0 or documented code when queue empty | [ ] |
| C2 | Hermes cron job with `deliver:` | Completion/failure posted to home channel | [ ] |
| C3 | `gsd read progress --json --project <path>` | `integration_version: 1` | [ ] |
| C4 | Memory prefetch (6c) | Agent/memory hook includes GSD memories for query ≥2 chars | [ ] |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `GsdVersionError` on start | `gsd` outside semver range | Set `gsd_version_min` in `gsd.yaml` or upgrade gsd |
| MCP spawn fails | Wrong `mcp_server_path` | `which gsd-mcp-server`; set absolute path |
| `/gsd status` hangs | MCP sidecar stuck | Check `GSD_CLI_PATH`; restart gateway; kill orphaned `gsd-mcp-server` |
| No push notifications | Invalid session key / target | Key must match `agent:main:{platform}:{chat_type}:{chat_id}`; check Hermes gateway logs |
| Notifications in CLI but not Slack | `DeliveryTarget.from_session_key` returned None | Run checklist in **gateway** mode, not CLI-only |
| Cancel ignored | Stale session id | `/gsd cancel` uses `gsd_cancel_by_project` fallback when no session id |
| Bind works, auto fails | Missing API credentials | Configure GSD provider keys (`credential_source: gsd`) |
| Empty snapshot | No `.gsd/STATE.md` | Run `/gsd status` in interactive GSD once to generate state |
| Channel map ignored | Wrong binding key | Use Slack **channel ID** (`C…`), not display name `#foo` |

### Debug commands

```bash
# Local
bash integrations/hermes/scripts/preflight.sh
gsd read progress --json --project "$PROJECT"

# MCP sidecar (manual)
GSD_CLI_PATH=gsd gsd-mcp-server   # should stay running; Ctrl+C to stop
```

---

## Sign-off

Complete after running **Slack** and/or **Telegram** walkthroughs.

| Field | Value |
|-------|-------|
| Date | |
| Tester | |
| `gsd --version` | |
| `open-gsd-hermes` version | |
| Hermes version | |
| Platform validated | [ ] Slack  [ ] Telegram |
| Preflight script | [ ] pass |
| S1–S13 (Slack) | [ ] all pass |
| T1–T7 (Telegram) | [ ] all pass |
| Blocker round-trip | [ ] pass |
| Cancel + no ghost notifications | [ ] pass |
| Fail closed (unbound chat) | [ ] pass |

**Release gate:** All checked items for at least **one** chat platform before tagging `open-gsd-hermes` 1.0.x.

---

## Upstream Hermes PR

See [`upstream-hermes-pr.md`](upstream-hermes-pr.md) for documentation PR steps to Nous Research Hermes repo.
