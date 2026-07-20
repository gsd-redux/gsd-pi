// GSD Web — Next.js instrumentation hook.
//
// Runs once at server startup (not during `next build`). In cloud mode
// (GSD_CLOUD_MODE=1, ADR-047) the gateway env vars are mandatory — fail fast
// with a clear message instead of booting a broken server.

import { isCloudMode, missingCloudEnvVars } from "./lib/cloud-mode.ts";

export function register(): void {
  if (!isCloudMode()) return;
  const missing = missingCloudEnvVars();
  if (missing.length > 0) {
    throw new Error(
      `GSD_CLOUD_MODE=1 requires these env vars to be set: ${missing.join(", ")}`,
    );
  }
}
