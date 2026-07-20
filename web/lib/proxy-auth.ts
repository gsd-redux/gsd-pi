/**
 * gsd-pi Web proxy auth decision logic.
 *
 * Local mode (default): when GSD_WEB_AUTH_TOKEN is set, every /api/* request
 * must carry the matching bearer token (or `_token` query param for SSE).
 *
 * Cloud mode (GSD_CLOUD_MODE=1, ADR-047): every /api/* request must carry a
 * valid HMAC-signed session cookie (minted by /api/cloud/bootstrap, which is
 * itself unauthenticated). A `?project=` alias must be one of the projects
 * granted by the cookie.
 */

import { getCloudSessionFromHeaders } from "./cloud-auth.ts"
import { isCloudMode } from "./cloud-mode.ts"

export type WebProxyAuthRequest = {
  pathname: string
  searchParams: URLSearchParams
  headers: {
    get(name: string): string | null
  }
}

export type WebProxyAuthDecision =
  | { kind: 'next' }
  | { kind: 'json'; status: 401 | 403; body: { error: string } }

function evaluateCloudProxyAuth(
  request: WebProxyAuthRequest,
  env: NodeJS.ProcessEnv,
): WebProxyAuthDecision {
  // The bootstrap endpoint authenticates via its own HMAC app token.
  if (request.pathname === '/api/cloud/bootstrap') return { kind: 'next' }

  const session = getCloudSessionFromHeaders(request.headers, env)
  if (!session) {
    return {
      kind: 'json',
      status: 401,
      body: { error: 'Unauthorized' },
    }
  }

  // `?project=` carries a project alias in cloud mode; it must be granted by
  // the session cookie.
  const project = request.searchParams.get('project')
  if (project && !session.projects.includes(project)) {
    return {
      kind: 'json',
      status: 403,
      body: { error: 'Forbidden: project not granted' },
    }
  }

  return { kind: 'next' }
}

export function evaluateWebProxyAuth(
  request: WebProxyAuthRequest,
  env: NodeJS.ProcessEnv = process.env,
): WebProxyAuthDecision {
  if (!request.pathname.startsWith('/api/')) return { kind: 'next' }

  if (isCloudMode(env)) {
    return evaluateCloudProxyAuth(request, env)
  }

  const expectedToken = env.GSD_WEB_AUTH_TOKEN
  if (!expectedToken) return { kind: 'next' }

  const origin = request.headers.get('origin')
  if (origin) {
    const host = env.GSD_WEB_HOST || '127.0.0.1'
    const port = env.GSD_WEB_PORT || '3000'
    const allowed = new Set([`http://${host}:${port}`])
    const extra = env.GSD_WEB_ALLOWED_ORIGINS
    if (extra) {
      for (const entry of extra.split(',')) {
        const trimmed = entry.trim()
        if (trimmed) allowed.add(trimmed)
      }
    }

    if (!allowed.has(origin)) {
      return {
        kind: 'json',
        status: 403,
        body: { error: 'Forbidden: origin mismatch' },
      }
    }
  }

  let token: string | null = null
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  }

  if (!token) {
    token = request.searchParams.get('_token')
  }

  if (!token || token !== expectedToken) {
    return {
      kind: 'json',
      status: 401,
      body: { error: 'Unauthorized' },
    }
  }

  return { kind: 'next' }
}
