/**
 * @opengsd/mcp-server CLI — stdio transport entry point.
 *
 * Connects the MCP server to stdin/stdout for use by Claude Code,
 * Cursor, and other MCP-compatible clients.
 */

import { installGlobalErrorHandlers } from './cli-errors.js';
import { runMcpServerCli } from './cli-runner.js';

installGlobalErrorHandlers();

runMcpServerCli().catch((err) => {
  process.stderr.write(
    `[gsd-mcp-server] Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
