// GSD Web — Cloud bootstrap (ADR-047 web convergence).
//
// Entry point into the cloud-hosted app. The gsd-cloud SaaS redirects the
// browser here with a short-lived HMAC app bridge token
// (POST /api/machines/[id]/app-token on the SaaS). On success we mint an
// 8h httpOnly session cookie and redirect to the app root; every other
// /api/* route then requires that cookie (see web/lib/proxy-auth.ts).

import { getCloudModeConfig, isCloudMode } from "../../../../lib/cloud-mode.ts";
import {
  mintCloudSessionCookie,
  serializeCloudSessionCookie,
  validateAppBridgeToken,
} from "../../../../lib/cloud-auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isCloudMode()) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const config = getCloudModeConfig();
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const session = token ? validateAppBridgeToken(token, config.appBridgeSecret) : null;

  if (!session) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Behind a TLS-terminating reverse proxy `url.protocol` is "http:", which
  // would drop the Secure attribute in production. Trust the first
  // x-forwarded-proto value when present, falling back to the URL scheme.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const scheme = forwardedProto
    ? forwardedProto.split(",")[0]!.trim().toLowerCase()
    : url.protocol.replace(/:$/, "");

  const cookieValue = mintCloudSessionCookie(session, config.appBridgeSecret);
  const headers = new Headers({ Location: "/" });
  headers.append(
    "Set-Cookie",
    serializeCloudSessionCookie(cookieValue, { secure: scheme === "https" }),
  );

  return new Response(null, { status: 302, headers });
}
