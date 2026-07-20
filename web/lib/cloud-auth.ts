// GSD Web — Cloud mode auth (ADR-047 web convergence).
//
// Two HMAC-SHA256 signed tokens share one wire format:
//
//   base64url(JSON payload) + "." + hex(hmacSHA256(base64url(JSON payload), APP_BRIDGE_SECRET))
//
// 1. The APP BRIDGE TOKEN: minted by the gsd-cloud SaaS
//    (POST /api/machines/[id]/app-token) and presented to
//    GET /api/cloud/bootstrap?token=... Payload:
//      { v:1, sub:<userId>, owner?:<device owner userId>, deviceId,
//        role:"owner"|"member"|"viewer", projects:<project aliases>,
//        exp:<unix seconds> }
//    `owner` is present when the SaaS mints a token for a shared member —
//    relay calls must address the device owner. Owner-only deployments omit
//    it; callers fall back to `sub`.
//
// 2. The SESSION COOKIE: minted by the bootstrap route on success — an
//    httpOnly, sameSite=lax cookie carrying the same payload shape with an
//    8h expiry. Every other /api/* route requires it in cloud mode.

import { createHmac, timingSafeEqual } from "node:crypto"
import {
  CLOUD_SESSION_COOKIE,
  CLOUD_SESSION_MAX_AGE_SECONDS,
  getCloudModeConfig,
  type CloudRole,
} from "./cloud-mode.ts"

export const APP_BRIDGE_TOKEN_VERSION = 1 as const

/** Verified identity + grants carried by the app bridge token / session cookie. */
export interface CloudSession {
  sub: string
  /** Device owner's user id when the session belongs to a shared member. */
  owner?: string
  deviceId: string
  role: CloudRole
  projects: string[]
  /** Expiry as unix seconds. */
  exp: number
}

const CLOUD_ROLES: ReadonlySet<string> = new Set(["owner", "member", "viewer"])

function hmacSha256Hex(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex")
}

function signatureMatches(expectedHex: string, providedHex: string): boolean {
  let expected: Buffer
  let provided: Buffer
  try {
    expected = Buffer.from(expectedHex, "hex")
    provided = Buffer.from(providedHex, "hex")
  } catch {
    return false
  }
  if (expected.length === 0 || expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

/** Sign a JSON payload into the shared wire format. */
export function signCloudPayload(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${body}.${hmacSha256Hex(body, secret)}`
}

/**
 * Verify the HMAC signature and decode the payload. Returns null on any
 * structural or signature failure. Expiry/version checks are the caller's job.
 */
export function verifyCloudToken(token: string, secret: string): Record<string, unknown> | null {
  const dot = token.lastIndexOf(".")
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!signatureMatches(hmacSha256Hex(body, secret), signature)) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeSessionPayload(payload: Record<string, unknown>): CloudSession | null {
  if (payload.v !== APP_BRIDGE_TOKEN_VERSION) return null
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null
  if (typeof payload.deviceId !== "string" || payload.deviceId.length === 0) return null
  if (typeof payload.role !== "string" || !CLOUD_ROLES.has(payload.role)) return null
  if (!Array.isArray(payload.projects) || payload.projects.some((p) => typeof p !== "string")) return null
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null
  if (payload.owner !== undefined && (typeof payload.owner !== "string" || payload.owner.length === 0)) return null
  return {
    sub: payload.sub,
    ...(typeof payload.owner === "string" ? { owner: payload.owner } : {}),
    deviceId: payload.deviceId,
    role: payload.role as CloudRole,
    projects: payload.projects as string[],
    exp: payload.exp,
  }
}

/**
 * Validate an app bridge token presented to /api/cloud/bootstrap.
 * Rejects bad signatures, v !== 1, malformed payloads, and expired tokens.
 */
export function validateAppBridgeToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CloudSession | null {
  const payload = verifyCloudToken(token, secret)
  if (!payload) return null
  const session = normalizeSessionPayload(payload)
  if (!session) return null
  if (session.exp <= nowSeconds) return null
  return session
}

/** Mint the session cookie value for a validated bootstrap. */
export function mintCloudSessionCookie(
  session: Omit<CloudSession, "exp">,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds: number = CLOUD_SESSION_MAX_AGE_SECONDS,
): string {
  return signCloudPayload(
    {
      v: APP_BRIDGE_TOKEN_VERSION,
      sub: session.sub,
      ...(session.owner !== undefined ? { owner: session.owner } : {}),
      deviceId: session.deviceId,
      role: session.role,
      projects: session.projects,
      exp: nowSeconds + maxAgeSeconds,
    },
    secret,
  )
}

/** Verify a session cookie value. Same construction as the app bridge token. */
export function verifyCloudSessionCookie(
  value: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CloudSession | null {
  return validateAppBridgeToken(value, secret, nowSeconds)
}

/** Extract a single cookie value from a Cookie header. */
export function parseCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    if (!value) return null
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

/** Serialize the session cookie for a Set-Cookie header. */
export function serializeCloudSessionCookie(value: string, options: { secure: boolean }): string {
  const parts = [
    `${CLOUD_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${CLOUD_SESSION_MAX_AGE_SECONDS}`,
  ]
  if (options.secure) parts.push("Secure")
  return parts.join("; ")
}

type HeaderGetter = { get(name: string): string | null }

/**
 * Resolve the cloud session from a request's Cookie header. Returns null when
 * the cookie is missing/invalid or cloud env config is incomplete (fail closed).
 */
export function getCloudSessionFromHeaders(
  headers: HeaderGetter,
  env: NodeJS.ProcessEnv = process.env,
): CloudSession | null {
  let secret: string
  try {
    secret = getCloudModeConfig(env).appBridgeSecret
  } catch {
    return null
  }
  const raw = parseCookieHeader(headers.get("cookie"), CLOUD_SESSION_COOKIE)
  if (!raw) return null
  return verifyCloudSessionCookie(raw, secret)
}

/** Request-scoped convenience wrapper over getCloudSessionFromHeaders. */
export function getCloudSessionFromRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): CloudSession | null {
  return getCloudSessionFromHeaders(request.headers, env)
}
