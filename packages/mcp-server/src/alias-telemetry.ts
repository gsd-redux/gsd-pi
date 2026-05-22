// @gsd-build/mcp-server + alias-telemetry — usage telemetry on the 11 alias
// `gsd_*` tools. Step 1 of a two-step deprecation (#5031). Always-on so we
// actually capture data during the window. Single JSON line per invocation
// to stderr — negligible overhead vs. the MCP request handler itself.
//
// Capture pattern: `<mcp-server-launch> 2>> alias-usage.jsonl`. After a
// long-enough window with zero entries, the alias tools can be removed in
// a follow-up PR. Filter with `grep deprecation` — the `event` field is
// namespaced for that purpose.

/** JSONL `event` field. Namespaced for `grep deprecation`. */
export const ALIAS_USAGE_EVENT = "deprecation.mcp_alias_used" as const;

/**
 * Emit a single-line JSONL record signaling that an alias tool was invoked.
 * Failures are swallowed — telemetry must never break MCP request handling.
 */
export function logAliasUsage(alias: string, canonical: string): void {
	try {
		const record = {
			event: ALIAS_USAGE_EVENT,
			ts: Date.now(),
			alias,
			canonical,
		};
		process.stderr.write(`${JSON.stringify(record)}\n`);
	} catch {
		// swallow — telemetry must never break the request handler
	}
}
