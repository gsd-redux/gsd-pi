// Project/App: Open GSD
// File Purpose: The Executor seam — the contract CloudRuntime drives to run GSD
//               work locally, decoupled from any particular backend engine.
//
// The daemon shipped one concrete implementation (LocalToolExecutor, which linked
// @opengsd/mcp-server directly). This package instead depends only on this
// INTERFACE, so the standalone agent stays free of the internal `@gsd/*` scope.
// Concrete adapters (gsd-pi shell-out, and later codex / claude -p) live beside
// this file and are chosen by selectExecutor().

/**
 * A project advertised to the cloud gateway. Matches the shape the daemon's
 * LocalToolExecutor.advertisedProjects() produced and that the gateway's
 * `hello` message expects.
 */
export interface AdvertisedProject {
  alias: string;
  path: string;
  repoIdentity: string;
  remoteLabel?: string;
  markers: string[];
}

/**
 * The behaviour CloudRuntime requires from a local execution backend.
 *
 * - `execute` runs a single GSD workflow tool call and returns its result
 *   (typically MCP `{ content: [...] }`), which CloudRuntime relays back to the
 *   gateway verbatim as a `tool_result`.
 * - `advertisedProjects` lists the projects this runtime is willing to act on;
 *   CloudRuntime sends them in the `hello` message on every (re)connect.
 */
export interface Executor {
  execute(toolName: string, rawArgs: Record<string, unknown>, projectAlias?: string): Promise<unknown>;
  advertisedProjects(): Promise<AdvertisedProject[]>;

  /** Optional teardown hook (e.g. kill a spawned child process). */
  close?(): Promise<void> | void;
}
