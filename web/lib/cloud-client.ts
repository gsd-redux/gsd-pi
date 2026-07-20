// GSD Web — Cloud mode client helpers (ADR-047 web convergence).
//
// The server layout injects the verified cloud session claims onto
// `window.__GSD_CLOUD__` (see web/app/layout.tsx). Client components use
// these helpers to gate cloud-only behaviors — hiding the exit hook, and
// disabling mutation surfaces (prompt input, approvals, terminal input)
// for the viewer role.

import type { CloudRole } from "./cloud-mode.ts";

export interface CloudClientSession {
  sub: string;
  deviceId: string;
  role: CloudRole;
  projects: string[];
}

declare global {
  interface Window {
    __GSD_CLOUD__?: CloudClientSession;
  }
}

/** Read the injected cloud session, or null in local mode / on the server. */
export function getCloudClientSession(): CloudClientSession | null {
  if (typeof window === "undefined") return null;
  const session = window.__GSD_CLOUD__;
  if (!session || typeof session !== "object") return null;
  if (typeof session.deviceId !== "string" || !Array.isArray(session.projects)) return null;
  return session;
}

/** True when the app is running inside the gsd-cloud SaaS. */
export function isCloudModeClient(): boolean {
  return getCloudClientSession() !== null;
}

/** True when the current session may mutate (anything but the viewer role). */
export function canCloudMutate(session: CloudClientSession | null = getCloudClientSession()): boolean {
  if (!session) return true; // local mode — unrestricted
  return session.role !== "viewer";
}
