# CLI Flags

## Starting GSD

| Flag | Description |
|------|-------------|
| `gsd` | Start a new interactive session |
| `gsd --continue` (`-c`) | Resume the most recent session |
| `gsd --model <id>` | Override the default model for this session |
| `gsd --thinking <level>` | Override thinking level for this session (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `gsd --web [path]` | Start browser-based web interface |
| `gsd --worktree` (`-w`) [name] | Start in a git worktree |
| `gsd --no-session` | Disable session persistence |
| `gsd --extension <path>` | Load an additional extension (repeatable) |
| `gsd --append-system-prompt <text>` | Append text to the system prompt |
| `gsd --tools <list>` | Comma-separated tools to enable |
| `gsd --version` (`-v`) | Print version and exit |
| `gsd --help` (`-h`) | Print help and exit |
| `gsd --debug` | Enable diagnostic logging |

## Non-Interactive Modes

| Flag | Description |
|------|-------------|
| `gsd --print "msg"` (`-p`) | Single-shot prompt mode (no TUI) |
| `gsd --mode <text\|json\|rpc\|mcp>` | Output mode for non-interactive use |

## Session Management

| Command | Description |
|---------|-------------|
| `gsd sessions` | Interactive session picker — list and resume saved sessions |
| `gsd --session <path\|id>` | Resume a specific session file or session ID |
| `gsd --session-dir <dir>` | Store and look up sessions in a custom directory |
| `gsd --list-models [search]` | List available models and exit |

## Configuration

| Command | Description |
|---------|-------------|
| `gsd config` | Set up global API keys |
| `gsd update` | See the [authoritative CLI reference](../../docs/user-docs/commands.md#cli-flags) for update targets |

## Headless Mode

| Flag | Description |
|------|-------------|
| `gsd headless` | Run without TUI |
| `gsd headless --timeout N` | Timeout in ms (default: 300000) |
| `gsd headless --max-restarts N` | Auto-restart on crash (default: 3) |
| `gsd headless --json` | Stream events as JSONL |
| `gsd headless --model ID` | Override model |
| `gsd headless --thinking LEVEL` | Override thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `gsd headless --context <file>` | Context file for `new-milestone` |
| `gsd headless --context-text <text>` | Inline context for `new-milestone` |
| `gsd headless --auto` | Chain into auto mode after milestone creation |
| `gsd headless query` | Instant JSON state snapshot (~50ms) |

## Web Interface

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `3000` | Port |
| `--allowed-origins` | (none) | CORS origins |
| `--no-auth` | disabled | Disable the built-in bearer token gate |

`--no-auth` is refused on non-loopback hosts by default (loopback is exempt). `--no-auth` alone is not enough. To deliberately combine unauthenticated web mode with a LAN-facing bind such as `--host 0.0.0.0`, set `GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1`; this exposes terminal and file APIs unless trusted external access control is in place.

```bash
# POSIX shell (bash, zsh)
GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1 gsd --web --host 0.0.0.0 --no-auth
```

```powershell
# PowerShell
$env:GSD_WEB_ALLOW_UNAUTHENTICATED_LAN="1"; gsd --web --host 0.0.0.0 --no-auth
```

```bat
REM CMD
set GSD_WEB_ALLOW_UNAUTHENTICATED_LAN=1
gsd --web --host 0.0.0.0 --no-auth
```
