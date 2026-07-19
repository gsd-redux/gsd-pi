// Project/App: Open GSD
// File Purpose: Standalone gsd-cloud CLI — login / status / connect / disconnect.
//
// Wires device-flow + CloudRuntime + a selected Executor adapter DIRECTLY. It has
// no dependency on any Daemon or Orchestrator class; the only cloud behaviour is
// the WS relay client driving the local GSD runtime through the Executor seam.

import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { resolveConfigPath, loadConfig, loadScanRoots } from "./config.js";
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
import {
  acquireRuntimeStartLock,
  backgroundRuntimeStatus,
  clearRuntimeState,
  startBackgroundRuntime,
  stopBackgroundRuntime,
  writeRuntimeState,
} from "./runtime-process.js";
import { clearRuntimeTelemetry, readRuntimeTelemetry, RuntimeTelemetryStore } from "./runtime-telemetry.js";
import { installService, serviceStatus, uninstallService } from "./service-install.js";
import type { DaemonConfig } from "./types.js";

export async function handleCloudCommand(argv: string[], opts: {
  binaryName: string;
}): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(formatUsage(opts.binaryName));
    process.exit(0);
  }

  const command = argv[0];

  if (command === "service") {
    await handleServiceCommand(argv.slice(1), opts.binaryName);
    return;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string", short: "c" },
      gateway: { type: "string" },
      code: { type: "string" },
      "runtime-name": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      foreground: { type: "boolean", default: false },
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
    const config = loadConfig(configPath);
    process.stdout.write(`${JSON.stringify({
      ...redactedCloudStatus(config),
      projects: config.projects.scan_roots,
      background: backgroundRuntimeStatus(configPath),
      telemetry: readRuntimeTelemetry(configPath),
    }, null, 2)}\n`);
    return;
  }

  if (command === "disconnect") {
    await stopBackgroundRuntime(configPath);
    clearCloudConfig(configPath);
    clearRuntimeTelemetry(configPath);
    process.stdout.write(`${opts.binaryName}: background runtime stopped and cloud credentials removed.\n`);
    return;
  }

  if (command === "stop") {
    const stopped = await stopBackgroundRuntime(configPath);
    process.stdout.write(stopped
      ? `${opts.binaryName}: background runtime stopped.\n`
      : `${opts.binaryName}: background runtime is not running.\n`);
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
    const projectDirs = selectedProjectDirs([]);
    const config = saveCloudConfig(configPath, {
      gateway_url: gatewayUrl,
      device_token: deviceToken,
      runtime_id: runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    }, projectDirs);
    process.stdout.write(`${opts.binaryName}: cloud runtime ${runtimeId} paired — connecting...\n`);
    if (values.foreground) {
      await runForegroundCloudRuntime(config, configPath, opts.binaryName, values.verbose, projectDirs);
      return;
    }
    await startAndReportBackgroundRuntime(configPath, projectDirs, opts.binaryName, values.verbose);
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
    const projectDirs = selectedProjectDirs(loadScanRoots(configPath));
    saveCloudConfig(configPath, {
      gateway_url: values.gateway,
      device_token: result.deviceToken,
      runtime_id: result.runtimeId,
      ...(runtimeName ? { runtime_name: runtimeName } : {}),
      enabled: true,
    }, projectDirs);
    process.stdout.write(`${opts.binaryName}: paired cloud runtime ${result.runtimeId}.\n`);
    return;
  }

  if (command === "connect") {
    let config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error("cloud runtime is not paired; run `login` first");
    }
    const projectDirs = selectedProjectDirs(config.projects.scan_roots);
    config = saveCloudConfig(configPath, config.cloud, projectDirs);
    if (values.foreground) {
      await runForegroundCloudRuntime(config, configPath, opts.binaryName, values.verbose, projectDirs);
      return;
    }
    await startAndReportBackgroundRuntime(configPath, projectDirs, opts.binaryName, values.verbose);
    return;
  }

  if (command === "_run") {
    const config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error("cloud runtime is not paired; run `login` first");
    }
    const projectDirs = selectedProjectDirs(config.projects.scan_roots);
    await runCloudRuntime(config, configPath, opts.binaryName, values.verbose, projectDirs, {
      onConnected: () => {
        process.send?.({ type: "ready" });
      },
    });
    return;
  }

  throw new Error(`Unknown cloud runtime command: ${command}`);
}

async function runForegroundCloudRuntime(
  config: DaemonConfig,
  configPath: string,
  binaryName: string,
  verbose: boolean,
  projectDirs: string[],
): Promise<void> {
  const releaseStartLock = await acquireRuntimeStartLock(configPath);
  try {
    await stopBackgroundRuntime(configPath);
    await runCloudRuntime(config, configPath, binaryName, verbose, projectDirs, {
      registerConfigPath: configPath,
      onConnected: releaseStartLock,
    });
  } finally {
    releaseStartLock();
  }
}

/**
 * Start the WS relay and block until the process is signalled. This is the whole
 * "daemon" for the standalone agent: one CloudRuntime + one Executor, no Discord,
 * no scanner, no session-manager class.
 */
async function runCloudRuntime(
  config: DaemonConfig,
  configPath: string,
  binaryName: string,
  verbose: boolean,
  projectDirs: string[],
  opts: { onConnected?: () => void; registerConfigPath?: string } = {},
): Promise<void> {
  if (!config.cloud) throw new Error("cloud runtime is not configured");
  if (config.cloud.enabled === false) {
    throw new Error("cloud runtime is disabled in config; set cloud.enabled to true to connect");
  }
  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose,
  });
  const executor = selectExecutor(logger, { projectDirs });
  const telemetry = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: config.cloud.gateway_url,
    runtimeId: config.cloud.runtime_id,
    runtimeName: config.cloud.runtime_name,
  });
  const runtime = new CloudRuntime(config.cloud, executor, logger, telemetry);
  // A foreground session owns the runtime itself, so it records its own PID in
  // the shared state file. That lets a later `connect`/`disconnect` find and
  // stop it, just like a detached background runtime. Background `_run` children
  // do not register here; their launcher records the child PID instead.
  if (opts.registerConfigPath) {
    writeRuntimeState(opts.registerConfigPath, process.pid, projectDirs);
  }
  try {
    await runtime.start();
  } catch (error) {
    if (opts.registerConfigPath) clearRuntimeState(opts.registerConfigPath);
    throw error;
  }
  opts.onConnected?.();
  process.stdout.write(`${binaryName}: connected to ${config.cloud.gateway_url}. Press Ctrl+C to stop.\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      if (opts.registerConfigPath) clearRuntimeState(opts.registerConfigPath);
      runtime.stop();
      void Promise.resolve(executor.close?.()).finally(() => {
        void logger.close().finally(() => resolve());
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function startAndReportBackgroundRuntime(
  configPath: string,
  projectDirs: string[],
  binaryName: string,
  verbose = false,
): Promise<void> {
  const binaryPath = process.argv[1];
  if (!binaryPath) throw new Error("could not resolve the gsd-cloud executable path");
  const status = await startBackgroundRuntime({ binaryPath, configPath, projectDirs, verbose });
  process.stdout.write(`${binaryName}: connected in the background (PID ${status.pid}).\n`);
  for (const project of projectDirs) process.stdout.write(`${binaryName}: project ${project}\n`);
  process.stdout.write(`${binaryName}: logs ${status.log_file}\n`);
}

async function handleServiceCommand(argv: string[], binaryName: string): Promise<void> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(formatServiceUsage(binaryName));
    return;
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(formatServiceUsage(binaryName));
    return;
  }

  if (subcommand === "install") {
    const configPath = resolveConfigPath(values.config);
    const config = loadConfig(configPath);
    if (!config.cloud?.device_token || !config.cloud.runtime_id) {
      throw new Error("cloud runtime is not paired; run `login` or `pair` first");
    }
    const projectDirs = selectedProjectDirs(config.projects.scan_roots);
    saveCloudConfig(configPath, config.cloud, projectDirs);
    await stopBackgroundRuntime(configPath);
    const binaryPath = process.argv[1];
    if (!binaryPath) throw new Error("could not resolve the gsd-cloud executable path");
    const installed = installService({
      nodePath: process.execPath,
      binaryPath,
      configPath,
      ...(process.env["GSD_CLI_PATH"] ? { gsdCliPath: process.env["GSD_CLI_PATH"] } : {}),
    });
    process.stdout.write(`${binaryName}: ${installed.manager} service installed and started.\n`);
    process.stdout.write(`${binaryName}: unit ${installed.unitPath}\n`);
    process.stdout.write(installed.logPath
      ? `${binaryName}: the runtime now starts at login and restarts on crash; logs ${installed.logPath}\n`
      : `${binaryName}: the runtime now starts at login and restarts on crash; logs \`journalctl --user -u gsd-cloud\`\n`);
    return;
  }

  if (subcommand === "uninstall") {
    const removed = uninstallService();
    process.stdout.write(removed.removed
      ? `${binaryName}: ${removed.manager} service uninstalled (${removed.unitPath} removed).\n`
      : `${binaryName}: service is not installed.\n`);
    return;
  }

  if (subcommand === "status") {
    const status = serviceStatus();
    if (!status.installed) {
      process.stdout.write(`${binaryName}: service is not installed (no ${status.manager} unit at ${status.unitPath}).\n`);
      return;
    }
    const state = status.running
      ? `running (PID ${status.pid})`
      : status.loaded
        ? `loaded but not running${status.lastExitStatus != null ? ` (last exit status: ${status.lastExitStatus})` : ""}`
        : "installed but not loaded";
    process.stdout.write(`${binaryName}: ${status.manager} service ${status.label} is ${state}.\n`);
    process.stdout.write(`${binaryName}: unit ${status.unitPath}\n`);
    return;
  }

  throw new Error(`Unknown service command: ${subcommand} (expected install, uninstall, or status)`);
}

function selectedProjectDirs(savedProjectDirs: string[]): string[] {
  const configured = process.env["GSD_CLOUD_PROJECTS"];
  if (configured?.trim()) {
    const configuredPaths = uniqueResolvedPaths(configured.split(delimiter));
    if (configuredPaths.length > 0) return configuredPaths;
  }
  if (savedProjectDirs.length > 0) {
    const savedPaths = uniqueResolvedPaths(savedProjectDirs);
    if (savedPaths.length > 0) return savedPaths;
  }
  return [canonicalizePath(process.cwd())];
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const resolved = paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => canonicalizePath(path));
  return [...new Set(resolved)];
}

/**
 * Resolve a project path to its canonical, symlink-free absolute form. The
 * executor advertises project paths via `resolve()` alone, so canonicalizing
 * here keeps the saved `scan_roots` and the advertised hello paths identical to
 * the real directory (e.g. when the cwd or GSD_CLOUD_PROJECTS points through a
 * symlink). Falls back to the plain resolved path when the target does not yet
 * exist on disk.
 */
function canonicalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function formatUsage(binaryName: string): string {
  return `Usage: ${binaryName} login [--gateway <url>] [--runtime-name <name>] [--config <path>] [--foreground]
       ${binaryName} status [--config <path>]
       ${binaryName} pair --gateway <url> --code <code> [--runtime-name <name>] [--config <path>]
       ${binaryName} connect [--config <path>] [--verbose] [--foreground]
       ${binaryName} stop [--config <path>]
       ${binaryName} disconnect [--config <path>]
       ${binaryName} service install [--config <path>]
       ${binaryName} service uninstall
       ${binaryName} service status

Commands:
  login      (Recommended) Browser-based pairing — opens an approval URL, then
             connects the current project in the background. Defaults to the
             public GSD Cloud gateway.
  status     Show current cloud runtime configuration and connection status.
  pair       Exchange a pairing code for a device token (headless/CI environments).
  connect    Start a background connection using saved credentials and projects.
  stop       Stop the background runtime without removing saved credentials.
  disconnect Stop the background runtime and remove local cloud credentials.
  service    Manage the OS background service (launchd on macOS, systemd user
             unit on Linux) that starts the runtime at login and restarts it
             on crash. See \`${binaryName} service --help\`.

Options:
  --config <path>        Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --gateway <url>        Cloud gateway URL (login defaults to https://cloud.opengsd.net)
  --code <code>          Pairing code from the gateway (pair only)
  --runtime-name <name>  Friendly name for this local GSD runtime
  --verbose              Print log entries to stderr in addition to the log file
  --foreground           Keep login/connect attached to this terminal (debugging)
  --help                 Show this help message and exit

Environment:
  GSD_CLOUD_PROJECTS     Path-delimiter separated project dirs to advertise
                         (default: current working directory)
  GSD_CLI_PATH           Path to the gsd binary (default: gsd on PATH)
  GSD_CLOUD_EXECUTOR     Backend adapter: gsd-pi (default), codex, claude
`;
}

function formatServiceUsage(binaryName: string): string {
  return `Usage: ${binaryName} service install [--config <path>]
       ${binaryName} service uninstall
       ${binaryName} service status

Commands:
  install    Install and start the OS service for the cloud runtime — a
             launchd LaunchAgent on macOS (starts at login, KeepAlive on crash)
             or a systemd user unit on Linux (starts at login, Restart=on-failure).
             Pair with \`${binaryName} login\` first.
  uninstall  Stop and remove the OS service. Pairing and credentials are kept.
  status     Show whether the OS service is installed, loaded, and running.

Options:
  --config <path>  Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --help           Show this help message and exit
`;
}
