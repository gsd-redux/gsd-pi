/** When set, stdio MCP is a short-lived tools/list probe — skip PID registry side effects. */
export const GSD_MCP_PROBE_ENV = 'GSD_MCP_PROBE';

export function isMcpProbeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[GSD_MCP_PROBE_ENV];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
