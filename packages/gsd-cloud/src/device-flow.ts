// Device flow handler: code request, terminal display, polling loop, config save.
// Implements RFC 8628 device authorization grant for the `gsd-cloud login` command.
import { hostname as osHostname } from "node:os";
import { cursorTo, clearLine } from "node:readline";
import { parseCloudGatewayUrl, postJsonToValidatedGateway, validateGatewayNetworkTarget } from "./cloud-config.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;

export interface DeviceFlowResult {
  deviceToken: string;
  runtimeId: string;
  /**
   * Resolved relay/gateway URL: the server-returned `gateway_url` from the approved
   * token-poll response when present AND valid, else the `gatewayUrl` the caller passed
   * (D-02 backward-compat — existing single-host `--gateway` users are unaffected).
   */
  gatewayUrl: string;
}

export interface DeviceFlowParams {
  gatewayUrl: string;
  configPath: string;
  runtimeName?: string;
  binaryName: string;
}

/** Simple sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full RFC 8628 device authorization flow.
 * Requests a device code, displays the verification URL and user code in the terminal,
 * polls for approval with a spinner, and returns the device token on success.
 * Calls process.exit(1) on denial (D-12) or timeout (D-11).
 */
export async function runDeviceFlow(params: DeviceFlowParams): Promise<DeviceFlowResult> {
  const base = parseCloudGatewayUrl(params.gatewayUrl);

  // ---- Step 1: Request device code (D-01, DEVF-01) ----
  const codeUrl = new URL(base.pathname.replace(/\/+$/, "") + "/api/device/code", base);
  const codeResponse = await postJsonToValidatedGateway(codeUrl, {
    hostname: osHostname(),
    os: process.platform,
    ...(params.runtimeName !== undefined ? { runtimeName: params.runtimeName } : {}),
  });

  const userCode = typeof codeResponse["userCode"] === "string" ? codeResponse["userCode"] : "";
  const deviceCode = typeof codeResponse["deviceCode"] === "string" ? codeResponse["deviceCode"] : "";
  const verificationUriComplete = typeof codeResponse["verificationUriComplete"] === "string"
    ? codeResponse["verificationUriComplete"]
    : "";
  const expiresIn = typeof codeResponse["expiresIn"] === "number" ? codeResponse["expiresIn"] : 600;

  if (!userCode || !deviceCode) {
    throw new Error("Device code response missing userCode or deviceCode");
  }

  // ---- Step 2: Display to user (D-02) ----
  process.stdout.write(`\n${params.binaryName}: Cloud Login\n`);
  process.stdout.write(`\nTo authorize this machine, open the following URL in your browser:\n`);
  process.stdout.write(`\n  ${verificationUriComplete}\n`);
  process.stdout.write(`\nOr visit the gateway and enter the code manually:\n`);
  process.stdout.write(`\n  ${base.origin}\n`);
  process.stdout.write(`\nYour code:  ${userCode}\n\n`);

  // ---- Step 3: Polling loop (D-10, D-11, D-12) ----
  const tokenUrl = new URL(base.pathname.replace(/\/+$/, "") + "/api/device/token", base);
  const expiresAt = Date.now() + expiresIn * 1_000;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let spinnerIndex = 0;

  const spinnerInterval = setInterval(() => {
    const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] ?? "⠋";
    spinnerIndex++;
    const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    process.stdout.write(`  ${frame} Waiting for approval... (expires in ${remaining}s)`);
  }, 100);

  try {
    while (Date.now() < expiresAt) {
      await sleep(pollIntervalMs);

      if (Date.now() >= expiresAt) break;

      let tokenResponse: Record<string, unknown>;
      try {
        tokenResponse = await postJsonToValidatedGateway(tokenUrl, { deviceCode });
      } catch {
        // Network errors during polling are transient — keep trying until expiry.
        continue;
      }

      const status = typeof tokenResponse["status"] === "string" ? tokenResponse["status"] : "";

      if (status === "approved") {
        clearInterval(spinnerInterval);
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write(`${params.binaryName}: Authorization approved!\n`);

        const deviceToken = typeof tokenResponse["token"] === "string" ? tokenResponse["token"] : "";
        const runtimeId = typeof tokenResponse["runtimeId"] === "string" ? tokenResponse["runtimeId"] : "";
        if (!deviceToken || !runtimeId) {
          throw new Error("Approval response missing token or runtimeId");
        }

        // Resolve the relay/gateway URL in exactly ONE place (D-02, D-03).
        // Default to the caller-supplied gateway; if the server sent a valid
        // `gateway_url`, use that instead. The server value is UNTRUSTED input —
        // re-validate it through the same SSRF guards applied to `--gateway`.
        let gatewayUrl = params.gatewayUrl;
        const serverGatewayUrl = typeof tokenResponse["gateway_url"] === "string"
          ? tokenResponse["gateway_url"]
          : undefined;
        if (serverGatewayUrl) {
          try {
            const parsed = parseCloudGatewayUrl(serverGatewayUrl);
            validateGatewayNetworkTarget(parsed);
            gatewayUrl = parsed.toString();
          } catch (err) {
            // Fail loud-but-non-fatal: a bad server-supplied relay URL must not
            // crash login. Warn and fall back to the configured `--gateway`.
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `${params.binaryName}: ignoring invalid server-supplied relay URL (${reason}); using configured --gateway instead.\n`,
            );
          }
        }

        return { deviceToken, runtimeId, gatewayUrl };
      }

      if (status === "denied") {
        clearInterval(spinnerInterval);
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
        process.stdout.write(`${params.binaryName}: Device request denied by user.\n`);
        process.exit(1);
      }

      if (status === "expired") {
        break;
      }

      if (status === "slow_down") {
        pollIntervalMs += SLOW_DOWN_INCREMENT_MS;
        continue;
      }

      // status === "pending" or unknown — keep polling
    }
  } finally {
    clearInterval(spinnerInterval);
  }

  // Timeout path (D-11)
  cursorTo(process.stdout, 0);
  clearLine(process.stdout, 0);
  process.stdout.write(`${params.binaryName}: Authorization request timed out. Please run login again.\n`);
  process.exit(1);
}
