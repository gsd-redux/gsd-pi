// Project/App: Open GSD
// File Purpose: Trimmed, self-contained config/log types for the standalone cloud agent.
//
// This is a deliberately minimal copy of the daemon's types.ts. It defines ONLY
// what the extracted cloud path needs (config parsing, logging) and imports NO
// `@opengsd/rpc-client` or `@opengsd/contracts` — that is what makes this package
// installable without the internal `@gsd/*` scope.

/**
 * Log severity levels, ordered from most to least verbose.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A single structured log entry written as JSON-lines.
 */
export interface LogEntry {
  /** ISO-8601 timestamp */
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

/**
 * Top-level daemon configuration, loaded from YAML.
 *
 * Only the `cloud` and `log` blocks are load-bearing for the standalone agent.
 * The `discord` and `projects` blocks are preserved so an existing
 * `~/.gsd/daemon.yaml` written by the full daemon parses without loss, but the
 * standalone agent does not act on them (it uses its own project source).
 */
export interface DaemonConfig {
  cloud?: {
    gateway_url: string;
    device_token?: string;
    runtime_id?: string;
    runtime_name?: string;
    enabled?: boolean;
  };
  discord?: {
    token: string;
    guild_id: string;
    owner_id: string;
    dm_on_blocker?: boolean;
    control_channel_id?: string;
    orchestrator?: {
      model?: string;
      max_tokens?: number;
    };
  };
  projects: {
    scan_roots: string[];
  };
  log: {
    file: string;
    level: LogLevel;
    max_size_mb: number;
  };
}
