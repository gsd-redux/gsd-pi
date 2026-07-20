// GSD Web — Cloud mode configuration (ADR-047 web convergence).
//
// When GSD_CLOUD_MODE=1, this app runs as the per-machine UI inside the
// gsd-cloud SaaS instead of against a local `gsd --mode rpc` child:
//
// - Auth comes from an HMAC-signed cookie minted by /api/cloud/bootstrap
//   (see web/lib/cloud-auth.ts), not the local #token fragment flow.
// - RPC traffic flows through the cloud gateway relay (CloudTransport)
//   rather than locally spawned child processes.
// - `?project=` carries a project ALIAS granted by the cookie, not a local
//   filesystem path.
// - Local-only behaviors (shutdown, local disk browsing, node-pty shells,
//   local service routes) are disabled.

export type CloudRole = "owner" | "member" | "viewer"

export interface CloudModeConfig {
  gatewayInternalUrl: string
  gatewayInternalToken: string
  appBridgeSecret: string
}

export const CLOUD_SESSION_COOKIE = "gsd_cloud_session"
export const CLOUD_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60 // 8 hours

export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GSD_CLOUD_MODE === "1"
}

const REQUIRED_CLOUD_ENV_VARS = [
  "GATEWAY_INTERNAL_URL",
  "GATEWAY_INTERNAL_TOKEN",
  "APP_BRIDGE_SECRET",
] as const

/** Names of required cloud-mode env vars that are missing or empty. */
export function missingCloudEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_CLOUD_ENV_VARS.filter((name) => !env[name])
}

/**
 * Resolve the cloud-mode configuration from the environment. Throws a clear
 * error when a required variable is missing — cloud mode cannot fail open.
 */
export function getCloudModeConfig(env: NodeJS.ProcessEnv = process.env): CloudModeConfig {
  const missing = missingCloudEnvVars(env)
  if (missing.length > 0) {
    throw new Error(`GSD_CLOUD_MODE=1 requires these env vars to be set: ${missing.join(", ")}`)
  }
  return {
    gatewayInternalUrl: env.GATEWAY_INTERNAL_URL!,
    gatewayInternalToken: env.GATEWAY_INTERNAL_TOKEN!,
    appBridgeSecret: env.APP_BRIDGE_SECRET!,
  }
}

/**
 * Guard for local-only API routes: returns a 404 Response in cloud mode, or
 * null in local mode so the route continues with its normal behavior.
 */
export function cloudModeLocalRouteGuard(env: NodeJS.ProcessEnv = process.env): Response | null {
  if (!isCloudMode(env)) return null
  return Response.json({ error: "Not available in cloud mode" }, { status: 404 })
}
