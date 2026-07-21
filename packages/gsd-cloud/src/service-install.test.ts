// Project/App: Open GSD
// File Purpose: Unit coverage for OS service unit rendering, platform dispatch, and failure paths.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { formatUsage, handleCloudCommand } from "./cli.js";
import { runtimeLogPath } from "./runtime-process.js";
import {
  escapeXml,
  generateLaunchdPlist,
  generateSystemdUnit,
  installService,
  LAUNCHD_LABEL,
  launchdPlistPath,
  serviceManagerForPlatform,
  serviceStatus,
  SYSTEMD_UNIT_NAME,
  systemdUnitPath,
  uninstallService,
  type RunServiceCommandFn,
  type ServiceInstallOptions,
} from "./service-install.js";

function tmpHome(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseInstallOpts(home: string, overrides?: Partial<ServiceInstallOptions>): ServiceInstallOptions {
  return {
    nodePath: "/usr/local/bin/node",
    binaryPath: "/usr/local/lib/node_modules/@opengsd/gsd-cloud/bin/gsd-cloud.js",
    configPath: join(home, ".gsd", "daemon.yaml"),
    homeDir: home,
    environment: {},
    ...overrides,
  };
}

/** A runCommand mock that records argv arrays and serves canned responses. */
function mockRunCommand(responder?: (args: string[]) => string): {
  calls: string[][];
  run: RunServiceCommandFn;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      return responder ? responder(args) : "";
    },
  };
}

// --------------- platform dispatch ---------------

test("service manager dispatch maps macOS and Linux, rejects other platforms", () => {
  assert.equal(serviceManagerForPlatform("darwin"), "launchd");
  assert.equal(serviceManagerForPlatform("linux"), "systemd");
  assert.throws(() => serviceManagerForPlatform("win32"), /not supported on win32/);
  assert.throws(() => serviceManagerForPlatform("freebsd"), /macOS \(launchd\) and Linux \(systemd user units\)/);
});

test("unsupported platforms fail every service operation with a clear error", () => {
  assert.throws(() => installService(baseInstallOpts("/tmp/nowhere", { platform: "win32" })), /not supported on win32/);
  assert.throws(() => uninstallService({ platform: "win32" }), /not supported on win32/);
  assert.throws(() => serviceStatus({ platform: "win32" }), /not supported on win32/);
});

test("unit paths live under the user's home directory", (t) => {
  const home = tmpHome(t);
  assert.equal(
    launchdPlistPath(home),
    join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  );
  assert.equal(
    systemdUnitPath(home),
    join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME),
  );
});

// --------------- launchd plist rendering ---------------

test("launchd plist renders label, program arguments, and supervision policy", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home);
  const xml = generateLaunchdPlist(opts);

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes("<plist version=\"1.0\">"));
  assert.ok(xml.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(xml.includes(`<string>${opts.nodePath}</string>`));
  assert.ok(xml.includes(`<string>${opts.binaryPath}</string>`));
  // The service runs the foreground runtime so PID/state files stay shared.
  for (const argument of ["connect", "--foreground", "--config", opts.configPath]) {
    assert.ok(xml.includes(`<string>${argument}</string>`), `missing ${argument}`);
  }
  assert.ok(xml.includes("<key>KeepAlive</key>"));
  assert.ok(xml.includes("<key>SuccessfulExit</key>"));
  assert.ok(xml.includes("<false/>"));
  assert.ok(xml.includes("<key>RunAtLoad</key>"));
  assert.ok(xml.includes("<true/>"));
});

test("launchd plist logs to the runtime artifact log and carries an NVM-aware PATH", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, {
    nodePath: "/home/user/.nvm/versions/node/v22.0.0/bin/node",
  });
  const xml = generateLaunchdPlist(opts);

  const logPath = runtimeLogPath(opts.configPath);
  assert.equal(logPath, join(home, ".gsd", "cloud-runtime.log"));
  assert.equal(xml.split(`<string>${logPath}</string>`).length - 1, 2);
  assert.ok(xml.includes("/home/user/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
  assert.ok(xml.includes(`<key>HOME</key>\n\t\t<string>${home}</string>`));
  assert.ok(xml.includes(`<key>WorkingDirectory</key>\n\t<string>${home}</string>`));
});

test("launchd plist escapes XML-special characters in paths", (t) => {
  const home = tmpHome(t);
  const configPath = join(home, "configs", "John & Jane.yaml");
  const xml = generateLaunchdPlist(baseInstallOpts(home, { configPath }));
  assert.ok(xml.includes("John &amp; Jane.yaml"));
  assert.ok(!xml.includes("John & Jane.yaml"));
  assert.equal(escapeXml('a&b<c>d"e\'f'), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

// --------------- systemd unit rendering ---------------

test("systemd unit renders exec line, restart policy, environment, and journal logging", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home);
  const unit = generateSystemdUnit(opts);

  assert.ok(unit.includes("Description=GSD Cloud runtime agent (gsd-cloud)"));
  assert.ok(unit.includes(
    `ExecStart="${opts.nodePath}" "${opts.binaryPath}" connect --foreground --config "${opts.configPath}"`,
  ));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("RestartSec=5"));
  assert.ok(unit.includes(`Environment="HOME=${home}"`));
  assert.ok(unit.includes(`Environment="PATH=/usr/local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`));
  assert.ok(unit.includes("StandardOutput=journal"));
  assert.ok(unit.includes("StandardError=journal"));
  assert.ok(unit.includes("SyslogIdentifier=gsd-cloud"));
  assert.ok(unit.includes("WantedBy=default.target"));
});

test("systemd unit quotes arguments containing spaces", (t) => {
  const home = tmpHome(t);
  const configPath = join(home, "my configs", "daemon.yaml");
  const unit = generateSystemdUnit(baseInstallOpts(home, { configPath }));
  assert.ok(unit.includes(`--config "${configPath}"`));
  assert.ok(!unit.includes(`--config ${configPath}\n`));
});

test("service unit PATH appends the install-time PATH so interactive-only commands resolve", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, {
    nodePath: "/opt/node/bin/node",
    environment: { PATH: `/home/user/.local/bin:/usr/bin:${join(home, "bin")}` },
  });
  // Node bin dir + system dirs stay first; interactive-only dirs are appended,
  // and dirs already in the base (e.g. /usr/bin) are not duplicated. This lets a
  // bare GSD_WORKFLOW_MCP_COMMAND on ~/.local/bin resolve under the service.
  const expected =
    `/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/home/user/.local/bin:${join(home, "bin")}`;

  const xml = generateLaunchdPlist(opts);
  assert.ok(xml.includes(`<key>PATH</key>\n\t\t<string>${expected}</string>`));

  const unit = generateSystemdUnit(opts);
  assert.ok(unit.includes(`Environment="PATH=${expected}"`));
});

test("service units preserve workflow MCP discovery overrides", (t) => {
  const home = tmpHome(t);
  const environment = {
    GSD_BIN_PATH: "/opt/gsd/bin/gsd",
    GSD_WORKFLOW_MCP_COMMAND: "/opt/workflow/bin/server",
    GSD_WORKFLOW_MCP_ARGS: '["--label","one & two"]',
    GSD_WORKFLOW_MCP_ENV: '{"TOKEN":"quote\\\" & percent%"}',
    GSD_WORKFLOW_MCP_CWD: "/srv/workflow & projects",
  };
  const opts = baseInstallOpts(home, {
    environment,
  });

  const plist = generateLaunchdPlist(opts);
  const unit = generateSystemdUnit(opts);

  for (const [key, value] of Object.entries(environment)) {
    assert.ok(plist.includes(`<key>${key}</key>`), `launchd missing ${key}`);
    assert.ok(plist.includes(`<string>${escapeXml(value)}</string>`), `launchd missing ${key} value`);
    const escapedForSystemd = value
      .replace(/%/g, "%%")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    assert.ok(
      unit.includes(`Environment="${key}=${escapedForSystemd}"`),
      `systemd missing ${key}`,
    );
  }

  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // installService with environment:undefined captures process.env at install
  // time, and buildEnvPath now folds that env's PATH into the unit PATH. Render
  // the expectation from the same process.env so the equality reflects the
  // fallback path rather than the PATH-free opts used for the key assertions.
  const expectedPlist = generateLaunchdPlist({ ...opts, environment: process.env });
  const expectedUnit = generateSystemdUnit({ ...opts, environment: process.env });

  for (const platform of ["darwin", "linux"] as const) {
    const unitPath = join(home, `${platform}.service`);
    installService(
      { ...opts, platform, unitPath, environment: undefined },
      mockRunCommand().run,
    );
    assert.equal(
      readFileSync(unitPath, "utf8"),
      platform === "darwin" ? expectedPlist : expectedUnit,
    );
  }
});

test("gsdCliPath pins GSD_CLI_PATH and GSD_BIN_PATH together, overriding a stale GSD_BIN_PATH", (t) => {
  const home = tmpHome(t);
  // A mismatched GSD_BIN_PATH in the captured environment must not survive: the
  // two vars are equivalent CLI-path overrides downstream, so both must resolve
  // to the freshly resolved binary rather than disagreeing.
  const opts = baseInstallOpts(home, {
    gsdCliPath: "/opt/homebrew/bin/gsd",
    environment: { GSD_BIN_PATH: "/stale/daemon/gsd" },
  });

  const plist = generateLaunchdPlist(opts);
  assert.ok(plist.includes("<key>GSD_CLI_PATH</key>\n\t\t<string>/opt/homebrew/bin/gsd</string>"));
  assert.ok(plist.includes("<key>GSD_BIN_PATH</key>\n\t\t<string>/opt/homebrew/bin/gsd</string>"));
  assert.ok(!plist.includes("/stale/daemon/gsd"));

  const unit = generateSystemdUnit(opts);
  assert.ok(unit.includes(`Environment="GSD_CLI_PATH=/opt/homebrew/bin/gsd"`));
  assert.ok(unit.includes(`Environment="GSD_BIN_PATH=/opt/homebrew/bin/gsd"`));
  assert.ok(!unit.includes("/stale/daemon/gsd"));
});

// --------------- install ---------------

test("installService writes the launchd plist, loads it, and verifies registration", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "darwin" });
  const { calls, run } = mockRunCommand();

  const installed = installService(opts, run);

  const plistPath = launchdPlistPath(home);
  assert.equal(installed.manager, "launchd");
  assert.equal(installed.unitPath, plistPath);
  assert.equal(installed.logPath, runtimeLogPath(opts.configPath));
  assert.equal(existsSync(plistPath), true);
  assert.equal(readFileSync(plistPath, "utf8"), generateLaunchdPlist(opts));
  assert.deepEqual(calls, [
    ["launchctl", "load", plistPath],
    ["launchctl", "list", LAUNCHD_LABEL],
  ]);
});

test("installService unloads a pre-existing launchd agent before reloading", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "darwin" });
  const plistPath = launchdPlistPath(home);
  const { calls, run } = mockRunCommand();

  installService(opts, run);
  installService(opts, run);

  const unloads = calls.filter((args) => args[1] === "unload");
  assert.equal(unloads.length, 1);
  assert.deepEqual(unloads[0], ["launchctl", "unload", plistPath]);
  // Tolerates "already unloaded" errors during the idempotent unload.
  const tolerant = mockRunCommand((args) => {
    if (args[1] === "unload") throw new Error("Could not find specified service");
    return "";
  });
  installService(opts, tolerant.run);
  assert.ok(tolerant.calls.some((args) => args[1] === "load"));
});

test("installService throws when launchctl load fails", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "darwin" });
  const { run } = mockRunCommand((args) => {
    if (args[1] === "load") throw Object.assign(new Error("launchctl failed"), { stderr: "Bootstrap failed: 5" });
    return "";
  });

  assert.throws(() => installService(opts, run), /launchctl load failed.*Bootstrap failed: 5/);
});

test("installService throws when the launchd agent cannot be verified after load", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "darwin" });
  const { run } = mockRunCommand((args) => {
    if (args[1] === "list") throw new Error("Could not find service");
    return "";
  });

  assert.throws(() => installService(opts, run), /the service may not have started/);
});

test("installService writes the systemd unit and enables it immediately", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "linux" });
  const { calls, run } = mockRunCommand();

  const installed = installService(opts, run);

  const unitPath = systemdUnitPath(home);
  assert.equal(installed.manager, "systemd");
  assert.equal(installed.unitPath, unitPath);
  assert.equal(installed.logPath, null);
  assert.equal(existsSync(unitPath), true);
  assert.equal(readFileSync(unitPath, "utf8"), generateSystemdUnit(opts));
  assert.deepEqual(calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME],
  ]);
});

test("installService surfaces systemctl failures with user-session guidance", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "linux" });
  const { run } = mockRunCommand(() => {
    throw Object.assign(new Error("systemctl failed"), { stderr: "Failed to connect to bus: No medium found" });
  });

  assert.throws(
    () => installService(opts, run),
    /Failed to connect to bus: No medium found.*loginctl enable-linger/s,
  );
});

test("installService writes unit files owner-only so persisted secrets stay private", (t) => {
  const home = tmpHome(t);
  // The unit files can embed GSD_WORKFLOW_MCP_ENV credentials, so they must not
  // be readable by other local users.
  const secretEnv = { GSD_WORKFLOW_MCP_ENV: '{"TOKEN":"s3cret"}' };

  const darwin = baseInstallOpts(home, { platform: "darwin", environment: secretEnv });
  installService(darwin, mockRunCommand().run);
  assert.equal(statSync(launchdPlistPath(home)).mode & 0o777, 0o600);

  const linux = baseInstallOpts(home, { platform: "linux", environment: secretEnv });
  installService(linux, mockRunCommand().run);
  assert.equal(statSync(systemdUnitPath(home)).mode & 0o777, 0o600);
});

// --------------- uninstall ---------------

test("uninstallService unloads and removes the launchd plist", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "darwin" });
  installService(opts, mockRunCommand().run);
  const plistPath = launchdPlistPath(home);
  assert.equal(existsSync(plistPath), true);

  const { calls, run } = mockRunCommand();
  const removed = uninstallService({ platform: "darwin", homeDir: home }, run);

  assert.equal(removed.removed, true);
  assert.equal(removed.unitPath, plistPath);
  assert.equal(existsSync(plistPath), false);
  assert.deepEqual(calls, [["launchctl", "unload", plistPath]]);
});

test("uninstallService disables and removes the systemd unit, then reloads the manager", (t) => {
  const home = tmpHome(t);
  const opts = baseInstallOpts(home, { platform: "linux" });
  installService(opts, mockRunCommand().run);
  const unitPath = systemdUnitPath(home);

  const { calls, run } = mockRunCommand();
  const removed = uninstallService({ platform: "linux", homeDir: home }, run);

  assert.equal(removed.removed, true);
  assert.equal(existsSync(unitPath), false);
  assert.deepEqual(calls, [
    ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME],
    ["systemctl", "--user", "daemon-reload"],
  ]);
});

test("uninstallService is a graceful no-op when the unit file is missing", (t) => {
  const home = tmpHome(t);
  for (const platform of ["darwin", "linux"] as const) {
    const { calls, run } = mockRunCommand();
    const removed = uninstallService({ platform, homeDir: home }, run);
    assert.equal(removed.removed, false);
    assert.deepEqual(calls, []);
  }
});

test("uninstallService tolerates service-manager errors and still removes the unit", (t) => {
  const home = tmpHome(t);
  for (const platform of ["darwin", "linux"] as const) {
    const opts = baseInstallOpts(home, { platform });
    installService(opts, mockRunCommand().run);
    const { run } = mockRunCommand(() => {
      throw new Error("service manager unavailable");
    });
    const removed = uninstallService({ platform, homeDir: home }, run);
    assert.equal(removed.removed, true);
    assert.equal(existsSync(removed.unitPath), false);
  }
});

// --------------- status ---------------

test("serviceStatus reports not installed without touching the service manager", (t) => {
  const home = tmpHome(t);
  for (const platform of ["darwin", "linux"] as const) {
    const { calls, run } = mockRunCommand();
    const status = serviceStatus({ platform, homeDir: home }, run);
    assert.equal(status.installed, false);
    assert.equal(status.loaded, false);
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.deepEqual(calls, []);
  }
});

test("serviceStatus parses tabular launchctl list output", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "darwin" }), mockRunCommand().run);
  const { run } = mockRunCommand(() => `PID\tStatus\tLabel\n1234\t0\t${LAUNCHD_LABEL}\n`);

  const status = serviceStatus({ platform: "darwin", homeDir: home }, run);

  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.running, true);
  assert.equal(status.pid, 1234);
  assert.equal(status.lastExitStatus, 0);
});

test("serviceStatus parses dict-style launchctl list output for a stopped agent", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "darwin" }), mockRunCommand().run);
  const { run } = mockRunCommand(() => `{\n\t"Label" = "${LAUNCHD_LABEL}";\n\t"LastExitStatus" = 1;\n};`);

  const status = serviceStatus({ platform: "darwin", homeDir: home }, run);

  assert.equal(status.loaded, true);
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(status.lastExitStatus, 1);
});

test("serviceStatus reports installed-but-unloaded when launchctl does not know the label", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "darwin" }), mockRunCommand().run);
  const { run } = mockRunCommand(() => {
    throw new Error(`Could not find service "${LAUNCHD_LABEL}" in domain for port`);
  });

  const status = serviceStatus({ platform: "darwin", homeDir: home }, run);

  assert.equal(status.installed, true);
  assert.equal(status.loaded, false);
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});

test("serviceStatus parses systemctl show output for a running unit", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "linux" }), mockRunCommand().run);
  const { calls, run } = mockRunCommand(() => "LoadState=loaded\nActiveState=active\nMainPID=4321\n");

  const status = serviceStatus({ platform: "linux", homeDir: home }, run);

  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.running, true);
  assert.equal(status.pid, 4321);
  assert.deepEqual(calls, [[
    "systemctl", "--user", "show", SYSTEMD_UNIT_NAME,
    "--no-page", "--property=LoadState,ActiveState,MainPID",
  ]]);
});

test("serviceStatus parses systemctl show output for an inactive unit", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "linux" }), mockRunCommand().run);
  const { run } = mockRunCommand(() => "LoadState=loaded\nActiveState=failed\nMainPID=0\n");

  const status = serviceStatus({ platform: "linux", homeDir: home }, run);

  assert.equal(status.loaded, true);
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});

test("serviceStatus falls back to on-disk truth when the systemd user bus is unavailable", (t) => {
  const home = tmpHome(t);
  installService(baseInstallOpts(home, { platform: "linux" }), mockRunCommand().run);
  const { run } = mockRunCommand(() => {
    throw new Error("Failed to connect to bus");
  });

  const status = serviceStatus({ platform: "linux", homeDir: home }, run);

  assert.equal(status.installed, true);
  assert.equal(status.loaded, false);
  assert.equal(status.running, false);
});

// --------------- CLI wiring ---------------

test("service command rejects unknown subcommands", async () => {
  await assert.rejects(
    handleCloudCommand(["service", "bogus"], { binaryName: "gsd-cloud" }),
    /Unknown service command: bogus \(expected install, uninstall, or status\)/,
  );
});

test("service command without a subcommand prints service usage", async (t) => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = originalWrite;
  });

  await handleCloudCommand(["service"], { binaryName: "gsd-cloud" });

  const usage = writes.join("");
  assert.match(usage, /gsd-cloud service install/);
  assert.match(usage, /gsd-cloud service uninstall/);
  assert.match(usage, /gsd-cloud service status/);
});

test("top-level usage documents the service commands", () => {
  const usage = formatUsage("gsd-cloud");
  assert.match(usage, /gsd-cloud service install \[--config <path>\]/);
  assert.match(usage, /gsd-cloud service uninstall/);
  assert.match(usage, /gsd-cloud service status/);
  assert.match(usage, /service --help/);
});
