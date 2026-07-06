// Project/App: Open GSD
// File Purpose: Standalone gsd-cloud CLI — login / status / connect / disconnect.
//
// Wires device-flow + CloudRuntime + a selected Executor adapter DIRECTLY. It has
// no dependency on any Daemon or Orchestrator class; the only cloud behaviour is
// the WS relay client driving the local GSD runtime through the Executor seam.

import { parseArgs } from "node:util";
import { resolveConfigPath, loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import {
  clearCloudConfig,
  exchangePairingCode,
  redactedCloudStatus,
  saveCloudConfig,
} from "./cloud-config.js";
import { runDeviceFlow } from "./device-flow.js";
import { CloudRuntime } from "./cloud-runtime.js";
import { selectExecutor } from "./executors/index.js";
import type { DaemonConfig } from "./types.js";

export async function handleCloudCommand(argv: string[], opts: {
  binaryName: string;
}): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(formatUsage(opts.binaryName));
    process.exit(0);
  }

  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string", short: "c" },
      gateway: { type: "string" },
      code: { type: "string" },
      "runtime-name": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help || !command) {
    process.stdout.write(formatUsage(opts.binaryName));
    process.exit(0);
  }

  const configPath = resolveConfigPath(values.config);

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(redactedCloudStatus(loadConfig(configPath)), null, 2)}\n`);
    return;
  }

  if (command === "disconnect") {
    clearCloudConfig(configPath);
    process.stdout.write(`${opts.binaryName}: cloud runtime disconnected locally.\n`);
    return;
  }

  if (command === "login") {
    if (!values.gateway) {
      throw new Error("login requires --gateway");
    }
    const runtimeName = values["runtime-name"];
    const { deviceToken, runtimeId, gatewayUrl } = await runDeviceFlow({
      gatewayUrl: values.gateway,
      configPath,
      runtimeName,
      binaryName: opts.binaryName,
    });
    const config = saveCloudConfig(configPath, {
      gateway_url: gatewayUrl,
      device_token: deviceToken,
      runtime_id: runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    });
    process.stdout.write(`${opts.binaryName}: cloud runtime ${runtimeId} paired — connecting...\n`);
    await runCloudRuntime(config, opts.binaryName, values.verbose);
    return;
  }

  if (command === "pair") {
    if (!values.gateway || !values.code) {
      throw new Error("pair requires --gateway and --code");
    }
    const runtimeName = values["runtime-name"];
    const result = await exchangePairingCode({
      gatewayUrl: values.gateway,
      code: values.code,
      runtimeName,
    });
    saveCloudConfig(configPath, {
      gateway_url: values.gateway,
      device_token: result.deviceToken,
      runtime_id: result.runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    });
    process.stdout.write(`${opts.binaryName}: paired cloud runtime ${result.runtimeId}.\n`);
    return;
  }

  if (command === "connect") {
    const config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error("cloud runtime is not paired; run `login` first");
    }
    await runCloudRuntime(config, opts.binaryName, values.verbose);
    return;
  }

  throw new Error(`Unknown cloud runtime command: ${command}`);
}

/**
 * Start the WS relay and block until the process is signalled. This is the whole
 * "daemon" for the standalone agent: one CloudRuntime + one Executor, no Discord,
 * no scanner, no session-manager class.
 */
async function runCloudRuntime(config: DaemonConfig, binaryName: string, verbose: boolean): Promise<void> {
  if (!config.cloud) throw new Error("cloud runtime is not configured");
  if (config.cloud.enabled === false) {
    throw new Error("cloud runtime is disabled in config; set cloud.enabled to true to connect");
  }
  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose,
  });
  const executor = selectExecutor(logger);
  const runtime = new CloudRuntime(config.cloud, executor, logger);
  await runtime.start();
  process.stdout.write(`${binaryName}: connected to ${config.cloud.gateway_url}. Press Ctrl+C to stop.\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      runtime.stop();
      void Promise.resolve(executor.close?.()).finally(() => {
        void logger.close().finally(() => resolve());
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function formatUsage(binaryName: string): string {
  return `Usage: ${binaryName} login [--gateway <url>] [--runtime-name <name>] [--config <path>]
       ${binaryName} status [--config <path>]
       ${binaryName} pair --gateway <url> --code <code> [--runtime-name <name>] [--config <path>]
       ${binaryName} connect [--config <path>] [--verbose]
       ${binaryName} disconnect [--config <path>]

Commands:
  login      (Recommended) Browser-based pairing — opens an approval URL in the
             terminal, polls for authorization, then auto-connects. Defaults to
             the public GSD Cloud gateway.
  status     Show current cloud runtime configuration and connection status.
  pair       Exchange a pairing code for a device token (headless/CI environments).
  connect    Connect using a previously paired device token.
  disconnect Remove cloud runtime configuration from the local config file.

Options:
  --config <path>        Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --gateway <url>        Cloud gateway URL (login defaults to https://cloud.opengsd.net)
  --code <code>          Pairing code from the gateway (pair only)
  --runtime-name <name>  Friendly name for this local GSD runtime
  --verbose              Print log entries to stderr in addition to the log file
  --help                 Show this help message and exit

Environment:
  GSD_CLOUD_PROJECTS     Path-delimiter separated project dirs to advertise
                         (default: current working directory)
  GSD_CLI_PATH           Path to the gsd binary (default: gsd on PATH)
  GSD_CLOUD_EXECUTOR     Backend adapter: gsd-pi (default), codex, claude
`;
}
