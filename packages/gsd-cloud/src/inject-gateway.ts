// Project/App: Open GSD
// File Purpose: Default the cloud gateway for login/pair when the caller omits --gateway.

/**
 * The public GSD Cloud gateway. This default lives ONLY in @opengsd/gsd-cloud
 * (D-01): the SaaS-branded wrapper is the one place the cloud.opengsd.net URL is
 * intended to appear. The generic @opengsd/daemon requires --gateway explicitly.
 */
export const DEFAULT_GATEWAY = "https://cloud.opengsd.net";

/**
 * Insert `--gateway https://cloud.opengsd.net` for the `login` and `pair`
 * commands when the caller has not supplied their own `--gateway`. Any other
 * command (status/connect/disconnect) is returned unchanged, as is an explicit
 * `--gateway` (the caller-supplied flag always wins) and empty argv.
 *
 * Pure function — no process.argv side effects — so the contract is unit-testable.
 */
export function injectDefaultGateway(argv: string[]): string[] {
  const command = argv[0];
  const gatewayAwareCommand = command === "login" || command === "pair";
  if (!gatewayAwareCommand || argv.includes("--gateway")) {
    return argv;
  }
  return [...argv, "--gateway", DEFAULT_GATEWAY];
}
