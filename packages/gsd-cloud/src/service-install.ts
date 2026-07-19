// Project/App: Open GSD
// File Purpose: OS service install/uninstall/status for the gsd-cloud runtime.
//
// macOS installs a launchd LaunchAgent (~/Library/LaunchAgents/net.opengsd.gsd-cloud.plist)
// and Linux installs a systemd user unit (~/.config/systemd/user/gsd-cloud.service).
// Both run `gsd-cloud connect --foreground`, so the service-managed runtime shares
// the PID/state files and log artifacts with CLI-managed sessions: a clean
// SIGTERM stop exits 0, which both supervisors respect (KeepAlive only fires on
// unsuccessful exits; Restart=on-failure only fires on non-zero exits).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeLogPath } from "./runtime-process.js";

export type ServiceManager = "launchd" | "systemd";

export interface ServiceTargetOptions {
  /** Platform override (testing). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Home directory override (testing). Defaults to os.homedir(). */
  homeDir?: string;
  /** Unit file path override (testing). */
  unitPath?: string;
}

export interface ServiceInstallOptions extends ServiceTargetOptions {
  /** Absolute path to the Node.js binary (usually process.execPath). */
  nodePath: string;
  /** Absolute path to the gsd-cloud CLI script (bin/gsd-cloud.js). */
  binaryPath: string;
  /** Absolute path to the YAML config file. */
  configPath: string;
  /** Log file override (launchd only; defaults to the runtime artifact log). */
  logPath?: string;
  /** Path to the `gsd` binary for the executor (from GSD_CLI_PATH at install time). */
  gsdCliPath?: string;
}

export interface InstalledService {
  manager: ServiceManager;
  unitPath: string;
  /** launchd log file; null on systemd, which logs to the journal. */
  logPath: string | null;
}

export interface RemovedService {
  manager: ServiceManager;
  unitPath: string;
  removed: boolean;
}

export interface ServiceStatus {
  manager: ServiceManager;
  label: string;
  unitPath: string;
  /** Unit file exists on disk. */
  installed: boolean;
  /** Registered with the service manager (launchctl list / LoadState=loaded). */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  /** launchd only; always null on systemd. */
  lastExitStatus: number | null;
}

export type RunServiceCommandFn = (args: string[]) => string;

export const LAUNCHD_LABEL = "net.opengsd.gsd-cloud";
const LAUNCHD_PLIST_FILENAME = `${LAUNCHD_LABEL}.plist`;
export const SYSTEMD_UNIT_NAME = "gsd-cloud.service";
const SYSTEMD_RESTART_DELAY_SECONDS = 5;

// --------------- platform dispatch ---------------

export function serviceManagerForPlatform(
  platform: NodeJS.Platform = process.platform,
): ServiceManager {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(
    `gsd-cloud service install is not supported on ${platform}; `
    + "supported platforms are macOS (launchd) and Linux (systemd user units). "
    + "Use `connect` to run the runtime in the background instead.",
  );
}

export function launchdPlistPath(homeDir: string = homedir()): string {
  return join(homeDir, "Library", "LaunchAgents", LAUNCHD_PLIST_FILENAME);
}

export function systemdUnitPath(homeDir: string = homedir()): string {
  return join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

function resolveUnitPath(manager: ServiceManager, opts: ServiceTargetOptions): string {
  if (opts.unitPath) return opts.unitPath;
  const home = opts.homeDir ?? homedir();
  return manager === "launchd" ? launchdPlistPath(home) : systemdUnitPath(home);
}

// --------------- unit file rendering ---------------

/** Escape special XML characters in a string. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the NVM-aware PATH string. Includes the directory containing the Node
 * binary so the service can find node (and a PATH-local `gsd`) even when
 * launched outside a shell session where NVM isn't sourced.
 */
function buildEnvPath(nodePath: string): string {
  const nodeBinDir = dirname(nodePath);
  return `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
}

/** Quote one argument for a systemd unit line (no shell is involved). */
function systemdArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Generate the launchd plist XML for the gsd-cloud runtime. */
export function generateLaunchdPlist(opts: ServiceInstallOptions): string {
  const home = opts.homeDir ?? homedir();
  const logPath = opts.logPath ?? runtimeLogPath(opts.configPath);
  const envPath = buildEnvPath(opts.nodePath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(LAUNCHD_LABEL)}</string>

\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(opts.nodePath)}</string>
\t\t<string>${escapeXml(opts.binaryPath)}</string>
\t\t<string>connect</string>
\t\t<string>--foreground</string>
\t\t<string>--config</string>
\t\t<string>${escapeXml(opts.configPath)}</string>
\t</array>

\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>

\t<key>RunAtLoad</key>
\t<true/>

\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(envPath)}</string>
\t\t<key>HOME</key>
\t\t<string>${escapeXml(home)}</string>${opts.gsdCliPath ? `
\t\t<key>GSD_CLI_PATH</key>
\t\t<string>${escapeXml(opts.gsdCliPath)}</string>` : ""}
\t</dict>

\t<key>WorkingDirectory</key>
\t<string>${escapeXml(home)}</string>

\t<key>StandardOutPath</key>
\t<string>${escapeXml(logPath)}</string>

\t<key>StandardErrorPath</key>
\t<string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** Generate the systemd user unit for the gsd-cloud runtime. */
export function generateSystemdUnit(opts: ServiceInstallOptions): string {
  const home = opts.homeDir ?? homedir();
  const envPath = buildEnvPath(opts.nodePath);

  return `[Unit]
Description=GSD Cloud runtime agent (gsd-cloud)
After=default.target

[Service]
Type=simple
ExecStart=${systemdArg(opts.nodePath)} ${systemdArg(opts.binaryPath)} connect --foreground --config ${systemdArg(opts.configPath)}
Restart=on-failure
RestartSec=${SYSTEMD_RESTART_DELAY_SECONDS}
Environment=${systemdArg(`HOME=${home}`)}
Environment=${systemdArg(`PATH=${envPath}`)}${opts.gsdCliPath ? `
Environment=${systemdArg(`GSD_CLI_PATH=${opts.gsdCliPath}`)}` : ""}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gsd-cloud

[Install]
WantedBy=default.target
`;
}

// --------------- install / uninstall / status ---------------

function defaultRunServiceCommand(args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function commandErrorDetail(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install the OS service: write the unit file and load/enable + start it.
 * Idempotent — an existing launchd agent is unloaded first; systemd enable is
 * naturally idempotent.
 */
export function installService(
  opts: ServiceInstallOptions,
  runCommand: RunServiceCommandFn = defaultRunServiceCommand,
): InstalledService {
  const manager = serviceManagerForPlatform(opts.platform);
  const unitPath = resolveUnitPath(manager, opts);
  const logPath = manager === "launchd" ? (opts.logPath ?? runtimeLogPath(opts.configPath)) : null;
  mkdirSync(dirname(unitPath), { recursive: true });

  if (manager === "launchd") {
    if (existsSync(unitPath)) {
      try {
        runCommand(["launchctl", "unload", unitPath]);
      } catch {
        // already unloaded — fine
      }
    }
    mkdirSync(dirname(logPath!), { recursive: true });
    writeFileSync(unitPath, generateLaunchdPlist(opts), "utf8");
    chmodSync(unitPath, 0o644);
    try {
      runCommand(["launchctl", "load", unitPath]);
    } catch (error) {
      throw new Error(`launchctl load failed for ${unitPath}: ${commandErrorDetail(error)}`);
    }
    try {
      runCommand(["launchctl", "list", LAUNCHD_LABEL]);
    } catch {
      throw new Error(
        `the plist was written to ${unitPath} and launchctl load succeeded, `
        + `but launchctl list ${LAUNCHD_LABEL} failed; the service may not have started`,
      );
    }
  } else {
    writeFileSync(unitPath, generateSystemdUnit(opts), "utf8");
    chmodSync(unitPath, 0o644);
    try {
      runCommand(["systemctl", "--user", "daemon-reload"]);
      runCommand(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
    } catch (error) {
      throw new Error(
        `systemctl --user failed while enabling ${SYSTEMD_UNIT_NAME}: ${commandErrorDetail(error)}. `
        + "A systemd user session is required — on headless servers, log in once "
        + "or enable lingering with `loginctl enable-linger`.",
      );
    }
  }

  return { manager, unitPath, logPath };
}

/**
 * Uninstall the OS service: unload/disable + stop it and remove the unit file.
 * Graceful — does not throw when the service was never installed.
 */
export function uninstallService(
  opts: ServiceTargetOptions = {},
  runCommand: RunServiceCommandFn = defaultRunServiceCommand,
): RemovedService {
  const manager = serviceManagerForPlatform(opts.platform);
  const unitPath = resolveUnitPath(manager, opts);
  if (!existsSync(unitPath)) return { manager, unitPath, removed: false };

  if (manager === "launchd") {
    try {
      runCommand(["launchctl", "unload", unitPath]);
    } catch {
      // already unloaded — fine
    }
  } else {
    try {
      runCommand(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
    } catch {
      // already disabled/stopped or no user bus — still remove the unit file
    }
  }
  unlinkSync(unitPath);

  if (manager === "systemd") {
    try {
      runCommand(["systemctl", "--user", "daemon-reload"]);
    } catch {
      // unit file is gone; a stale manager cache is harmless
    }
  }
  return { manager, unitPath, removed: true };
}

/** Query the service manager for the gsd-cloud service status. */
export function serviceStatus(
  opts: ServiceTargetOptions = {},
  runCommand: RunServiceCommandFn = defaultRunServiceCommand,
): ServiceStatus {
  const manager = serviceManagerForPlatform(opts.platform);
  const unitPath = resolveUnitPath(manager, opts);
  const label = manager === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT_NAME;
  const installed = existsSync(unitPath);

  if (manager === "launchd") {
    const queried = installed ? queryLaunchd(runCommand) : null;
    return {
      manager,
      label,
      unitPath,
      installed,
      loaded: queried?.registered ?? false,
      running: queried?.pid != null,
      pid: queried?.pid ?? null,
      lastExitStatus: queried?.lastExitStatus ?? null,
    };
  }

  if (!installed) {
    return { manager, label, unitPath, installed, loaded: false, running: false, pid: null, lastExitStatus: null };
  }
  try {
    const output = runCommand([
      "systemctl", "--user", "show", SYSTEMD_UNIT_NAME,
      "--no-page", "--property=LoadState,ActiveState,MainPID",
    ]);
    const properties = parseSystemdShow(output);
    const mainPid = Number.parseInt(properties.get("MainPID") ?? "", 10);
    const pid = Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null;
    return {
      manager,
      label,
      unitPath,
      installed,
      loaded: properties.get("LoadState") === "loaded",
      running: properties.get("ActiveState") === "active",
      pid,
      lastExitStatus: null,
    };
  } catch {
    // No systemd user bus (headless/SSH-less session) — report the on-disk truth.
    return { manager, label, unitPath, installed, loaded: false, running: false, pid: null, lastExitStatus: null };
  }
}

interface LaunchdQueryResult {
  registered: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

/**
 * Parse `launchctl list <label>` output. Handles both the tabular format
 * ("PID\tStatus\tLabel") and the JSON-style dict format ("PID" = 1234;).
 */
function queryLaunchd(runCommand: RunServiceCommandFn): LaunchdQueryResult {
  try {
    const output = runCommand(["launchctl", "list", LAUNCHD_LABEL]);

    for (const line of output.trim().split("\n")) {
      const parts = line.trim().split(/\t+/);
      if (parts.length >= 3 && parts[2] === LAUNCHD_LABEL) {
        const pid = parts[0] === "-" ? null : Number.parseInt(parts[0]!, 10);
        const lastExitStatus = Number.parseInt(parts[1]!, 10);
        return {
          registered: true,
          pid: pid != null && Number.isNaN(pid) ? null : pid,
          lastExitStatus: Number.isNaN(lastExitStatus) ? null : lastExitStatus,
        };
      }
    }

    const pidMatch = /"PID"\s*=\s*(\d+)\s*;/.exec(output);
    const exitMatch = /"LastExitStatus"\s*=\s*(\d+)\s*;/.exec(output);
    if (pidMatch || exitMatch) {
      return {
        registered: true,
        pid: pidMatch ? Number.parseInt(pidMatch[1]!, 10) : null,
        lastExitStatus: exitMatch ? Number.parseInt(exitMatch[1]!, 10) : null,
      };
    }

    return { registered: true, pid: null, lastExitStatus: null };
  } catch {
    // launchctl list exits non-zero when the label isn't loaded
    return { registered: false, pid: null, lastExitStatus: null };
  }
}

function parseSystemdShow(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return properties;
}
