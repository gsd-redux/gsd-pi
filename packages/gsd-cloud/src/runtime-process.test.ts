// Project/App: Open GSD
// File Purpose: Regression coverage for detached cloud runtime process timing and shutdown.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS } from "./cloud-runtime.js";
import {
  BACKGROUND_RUNTIME_READY_TIMEOUT_MS,
  acquireRuntimeStartLock,
  backgroundRuntimeStatus,
  commandLineMatchesRuntimeConfig,
  runtimeLogPath,
  runtimeStatePath,
  startBackgroundRuntime,
  stopBackgroundRuntime,
  writeRuntimeState,
} from "./runtime-process.js";
import { runtimeArtifactPath } from "./runtime-artifacts.js";
import { runtimeTelemetryPath } from "./runtime-telemetry.js";

test("background startup allows the cloud runtime's full initial reconnect window", () => {
  assert.ok(BACKGROUND_RUNTIME_READY_TIMEOUT_MS > CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS);
});

test("runtime artifacts are namespaced by config path while daemon.yaml stays legacy-compatible", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const defaultConfig = join(root, "daemon.yaml");
  const firstConfig = join(root, "first.yaml");
  const secondConfig = join(root, "second.yaml");

  assert.equal(runtimeStatePath(defaultConfig), join(root, "cloud-runtime.json"));
  assert.equal(runtimeLogPath(defaultConfig), join(root, "cloud-runtime.log"));
  assert.equal(runtimeTelemetryPath(defaultConfig), join(root, "cloud-runtime-status.json"));
  assert.notEqual(runtimeStatePath(firstConfig), runtimeStatePath(secondConfig));
  assert.notEqual(runtimeLogPath(firstConfig), runtimeLogPath(secondConfig));
  assert.notEqual(runtimeTelemetryPath(firstConfig), runtimeTelemetryPath(secondConfig));
});

test("runtime artifact namespace is stable across monitor implementations", () => {
  assert.equal(
    runtimeStatePath("/work/state/first.yaml"),
    "/work/state/cloud-runtime-58cb3ff924131c6e.json",
  );
});

test("stop refuses to signal a process whose identity does not match state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-reused-pid-"));
  const configPath = join(root, "daemon.yaml");
  const statePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  writeFileSync(statePath, `${JSON.stringify({
    pid: child.pid,
    projects: [root],
    process_start_identity: "not-this-process",
  })}\n`);

  assert.equal(await stopBackgroundRuntime(configPath), false);
  assert.equal(processIsRunning(child.pid), true);
  assert.equal(existsSync(statePath), true);
});

test("custom configs migrate matching live legacy runtime state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-legacy-state-"));
  const configPath = join(root, "custom.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    writeLegacyRuntime(root, "gsd-cloud.js"),
    "_run",
    "--config",
    configPath,
  ]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

  const status = backgroundRuntimeStatus(configPath);

  assert.equal(status.running, true);
  assert.equal(status.pid, child.pid);
  assert.equal(existsSync(runtimeStatePath(configPath)), true);
  assert.equal(existsSync(legacyStatePath), false);
});

for (const runtimeArgs of [
  ["connect"],
  ["login", "--foreground"],
]) {
  test(`custom configs migrate legacy ${runtimeArgs.join(" ")} runtime state`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "gsd-cloud-foreground-legacy-"));
    const configPath = join(root, "custom runtime.yaml");
    const legacyStatePath = join(root, "cloud-runtime.json");
    const binaryPath = writeLegacyRuntime(root, "gsd-cloud.js");
    const child = spawn(process.execPath, [
      binaryPath,
      ...runtimeArgs,
      "--config",
      configPath,
    ]);
    t.after(() => {
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    });

    assert.ok(child.pid);
    await waitForCondition(() => processIsRunning(child.pid!));
    writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

    const status = backgroundRuntimeStatus(configPath);

    assert.equal(status.running, true);
    assert.equal(status.pid, child.pid);
    assert.equal(existsSync(runtimeStatePath(configPath)), true);
    assert.equal(existsSync(legacyStatePath), false);
  });
}

test("legacy runtime state for another config is not migrated or signalled", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-foreign-legacy-state-"));
  const requestedConfig = join(root, "requested.yaml");
  const actualConfig = join(root, "actual.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(()=>{},1000)",
    "_run",
    "--config",
    actualConfig,
  ]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

  assert.equal(await stopBackgroundRuntime(requestedConfig), false);
  assert.equal(processIsRunning(child.pid), true);
  assert.equal(existsSync(legacyStatePath), true);
});

test("default config preserves shared legacy state owned by a custom config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-shared-legacy-state-"));
  const requestedConfig = join(root, "daemon.yaml");
  const actualConfig = join(root, "custom.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const binaryPath = writeLegacyRuntime(root, "gsd-cloud.js");
  const child = spawn(process.execPath, [binaryPath, "connect", "--config", actualConfig]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

  assert.equal(await stopBackgroundRuntime(requestedConfig), false);
  assert.equal(processIsRunning(child.pid), true);
  assert.equal(existsSync(legacyStatePath), true);
});

test("legacy migration rejects unrelated executables", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-unrelated-legacy-state-"));
  const configPath = join(root, "daemon.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const binaryPath = writeLegacyRuntime(root, "other-tool.js");
  const child = spawn(process.execPath, [binaryPath, "connect", "--config", configPath]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

  assert.equal(await stopBackgroundRuntime(configPath), false);
  assert.equal(processIsRunning(child.pid), true);
  assert.equal(existsSync(legacyStatePath), true);
});

test("legacy migration preserves config paths with spaces before short options", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-argv-legacy-"));
  const configPath = join(root, "custom runtime.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const binaryPath = writeLegacyRuntime(root, "gsd-cloud.js");
  const child = spawn(process.execPath, [
    binaryPath,
    "connect",
    "--config",
    configPath,
    "-v",
    "--foreground",
  ]);
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(child.pid);
  await waitForCondition(() => processIsRunning(child.pid!));
  writeFileSync(legacyStatePath, `${JSON.stringify({ pid: child.pid, projects: [root] })}\n`);

  const status = backgroundRuntimeStatus(configPath);

  assert.equal(status.running, true);
  assert.equal(status.pid, child.pid);
  assert.equal(existsSync(runtimeStatePath(configPath)), true);
  assert.equal(existsSync(legacyStatePath), false);
});

test("Windows command matching accepts quoted gsd-cloud.js paths", () => {
  const configPath = "/work/runtime/daemon.yaml";
  const command = [
    '"C:\\Program Files\\nodejs\\node.exe"',
    '"C:\\Program Files\\gsd-cloud\\gsd-cloud.js"',
    "connect",
    "--config",
    `"${configPath}"`,
  ].join(" ");

  assert.equal(commandLineMatchesRuntimeConfig(command, configPath, "win32"), true);
});

test("command matching rejects gsd-cloud decoys before another launcher", () => {
  const configPath = "/work/runtime/daemon.yaml";

  assert.equal(commandLineMatchesRuntimeConfig(
    `other-tool /tmp/gsd-cloud.js connect --config ${configPath}`,
    configPath,
    "linux",
  ), false);
  assert.equal(commandLineMatchesRuntimeConfig(
    `"C:\\Tools\\other-tool.exe" "C:\\tmp\\gsd-cloud.js" connect --config "${configPath}"`,
    configPath,
    "win32",
  ), false);
  assert.equal(commandLineMatchesRuntimeConfig(
    `/usr/bin/node /tmp/gsd-cloud.js --config ${configPath} connect --config /other.yaml`,
    configPath,
    "linux",
  ), false);
  assert.equal(commandLineMatchesRuntimeConfig(
    `/usr/bin/other /tmp/gsd-cloud.js connect --config ${configPath}`,
    configPath,
    "darwin",
  ), false);
  assert.equal(commandLineMatchesRuntimeConfig(
    `/usr/bin/node /usr/bin/other /tmp/gsd-cloud.js connect --config ${configPath}`,
    configPath,
    "darwin",
  ), false);
});

test("command matching accepts a directly launched bare gsd-cloud executable", () => {
  const configPath = "/work/runtime/daemon.yaml";

  assert.equal(commandLineMatchesRuntimeConfig(
    `gsd-cloud connect --config ${configPath}`,
    configPath,
    "darwin",
  ), true);
  assert.equal(commandLineMatchesRuntimeConfig(
    `"/Applications/GSD Cloud/gsd-cloud" connect --config ${configPath}`,
    configPath,
    "darwin",
  ), true);
});

test("start lock atomically records PID and process identity", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-lock-owner-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root, 500);
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  t.after(async () => {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const starting = startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] });
  await waitForCondition(() => existsSync(lockPath));

  const owner = JSON.parse(readFileSync(lockPath, "utf8")) as {
    pid?: number;
    process_start_identity?: string;
  };
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.process_start_identity, "string");
  assert.ok(owner.process_start_identity);

  await starting;
});

test("start lock recovers immediately when its PID identity is stale", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stale-lock-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    process_start_identity: "reused-process",
  })}\n`);
  t.after(async () => {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const starting = startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] });
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
  const owner = JSON.parse(readFileSync(lockPath, "utf8")) as {
    process_start_identity?: string;
  };

  assert.notEqual(owner.process_start_identity, "reused-process");
  await starting;
});

test("start lock recovery never removes a replacement owner", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-replaced-lock-"));
  const ownerConfigPath = join(root, "owner.yaml");
  const configPath = join(root, "daemon.yaml");
  const ownerLockPath = runtimeArtifactPath(ownerConfigPath, "start.lock");
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  const releaseOwner = await acquireRuntimeStartLock(ownerConfigPath);
  const replacementOwner = readFileSync(ownerLockPath, "utf8");
  releaseOwner();
  writeFileSync(lockPath, "stale");
  const old = new Date(0);
  utimesSync(lockPath, old, old);
  let release: (() => void) | undefined;
  t.after(async () => {
    rmSync(lockPath, { force: true });
    release ??= await acquiring.catch(() => undefined);
    release?.();
    rmSync(root, { recursive: true, force: true });
  });

  let replacementInstalled!: () => void;
  let replacementInode: bigint | undefined;
  const installed = new Promise<void>((resolve) => {
    replacementInstalled = resolve;
  });
  const acquiring = acquireRuntimeStartLock(configPath, () => {
    rmSync(lockPath);
    writeFileSync(lockPath, replacementOwner);
    replacementInode = statSync(lockPath, { bigint: true }).ino;
    replacementInstalled();
  });

  await installed;
  assert.equal(readFileSync(lockPath, "utf8"), replacementOwner);
  assert.equal(statSync(lockPath, { bigint: true }).ino, replacementInode);
  rmSync(lockPath);
  release = await acquiring;
  release();
});

test("start lock recovery ignores an abandoned recovery claim", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-abandoned-recovery-"));
  const configPath = join(root, "daemon.yaml");
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  const recoveryPath = `${lockPath}.recovery`;
  writeFileSync(lockPath, "stale");
  writeFileSync(recoveryPath, "abandoned");
  const old = new Date(0);
  utimesSync(lockPath, old, old);
  utimesSync(recoveryPath, old, old);
  let release: (() => void) | undefined;
  const acquiring = acquireRuntimeStartLock(configPath);
  t.after(async () => {
    rmSync(lockPath, { force: true });
    rmSync(recoveryPath, { force: true });
    release ??= await acquiring.catch(() => undefined);
    release?.();
    rmSync(root, { recursive: true, force: true });
  });

  release = await Promise.race([
    acquiring,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("abandoned recovery claim blocked start")), 500);
    }),
  ]);
  release();

  assert.equal(existsSync(lockPath), false);
  assert.equal(readFileSync(recoveryPath, "utf8"), "abandoned");
});

test("start lock does not reclaim a live legacy owner by age", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-live-legacy-lock-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  writeFileSync(lockPath, `${process.pid}\n`);
  t.after(async () => {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const starting = startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));

  assert.equal(readFileSync(lockPath, "utf8"), `${process.pid}\n`);
  rmSync(lockPath);
  await starting;
});

test("start lock preserves an aged legacy owner running the same config", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-live-runtime-lock-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);
  const legacyBinaryPath = writeLegacyRuntime(root, "gsd-cloud");
  const lockPath = runtimeArtifactPath(configPath, "start.lock");
  const owner = spawn(process.execPath, [legacyBinaryPath, "connect", "--config", configPath]);
  t.after(async () => {
    owner.kill("SIGKILL");
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  assert.ok(owner.pid);
  await waitForCondition(() => processIsRunning(owner.pid!));
  writeFileSync(lockPath, `${owner.pid}\n`);
  const old = new Date(0);
  utimesSync(lockPath, old, old);

  const starting = startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

  assert.equal(readFileSync(lockPath, "utf8"), `${owner.pid}\n`);
  rmSync(lockPath);
  await starting;
});

for (const staleOwner of ["", "not-json", `${process.pid}\n`]) {
  test(`start lock recovers stale legacy owner ${JSON.stringify(staleOwner)}`, { timeout: 2_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stale-legacy-lock-"));
    const configPath = join(root, "daemon.yaml");
    const lockPath = runtimeArtifactPath(configPath, "start.lock");
    writeFileSync(lockPath, staleOwner);
    const old = new Date(0);
    utimesSync(lockPath, old, old);
    let release: (() => void) | undefined;
    const acquiring = acquireRuntimeStartLock(configPath);
    t.after(async () => {
      if (!release) {
        rmSync(lockPath, { force: true });
        release = await acquiring.catch(() => undefined);
      }
      release?.();
      rmSync(root, { recursive: true, force: true });
    });

    release = await Promise.race([
      acquiring,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("stale start lock was not recovered promptly")), 500);
      }),
    ]);
    release();

    assert.equal(existsSync(lockPath), false);
  });
}

test("stop waits for the detached runtime to exit before removing its state", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stop-"));
  const configPath = join(root, "daemon.yaml");
  const statePath = join(root, "cloud-runtime.json");
  const binaryPath = join(root, "gsd-cloud.js");
  writeFileSync(binaryPath, [
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));",
    "process.send?.('ready');",
    "setInterval(()=>{},1000);",
  ].join("\n"));
  const child = spawn(process.execPath, [
    binaryPath,
    "_run",
    "--config",
    configPath,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", () => resolve());
  });
  assert.ok(child.pid);
  writeRuntimeState(configPath, child.pid, [root]);

  const startedAt = Date.now();
  assert.equal(await stopBackgroundRuntime(configPath), true);

  assert.ok(Date.now() - startedAt >= 150);
  assert.equal(existsSync(statePath), false);
});

test("background startup terminates its child when state registration fails", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-registration-failure-"));
  const configPath = join(root, "daemon.yaml");
  const pidPath = join(root, "runtime-pid.txt");
  const binaryPath = join(root, "runtime.mjs");
  writeFileSync(binaryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'process.on("SIGTERM", () => process.exit(0));',
    'setInterval(() => undefined, 1_000);',
  ].join("\n"));
  mkdirSync(runtimeStatePath(configPath));
  t.after(() => {
    if (existsSync(pidPath)) {
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] }),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    await waitForCondition(() => !processIsRunning(pid));
    assert.equal(processIsRunning(pid), false);
  }
});

test("background startup force-stops its child when identity registration fails", { timeout: 8_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-registration-force-stop-"));
  const configPath = join(root, "daemon.yaml");
  const pidPath = join(root, "runtime-pid.txt");
  const binaryPath = join(root, "runtime.mjs");
  writeFileSync(binaryPath, [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => undefined);',
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'setInterval(() => undefined, 1_000);',
  ].join("\n"));
  mkdirSync(runtimeStatePath(configPath));
  t.after(() => {
    if (existsSync(pidPath)) {
      const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      if (processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    startBackgroundRuntime({
      binaryPath,
      configPath,
      projectDirs: [root],
      processIdentityReader: () => {
        const deadline = Date.now() + 1_000;
        while (!existsSync(pidPath) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return null;
      },
    }),
  );
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    await waitForCondition(() => !processIsRunning(pid), 7_000);
    assert.equal(processIsRunning(pid), false);
  }
});

test("concurrent starts serialize and leave only the newest runtime running", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-concurrent-start-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);
  t.after(async () => {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] }),
    startBackgroundRuntime({ binaryPath, configPath, projectDirs: [root] }),
  ]);

  assert.notEqual(first.pid, second.pid);
  assert.ok(first.pid);
  assert.equal(processIsRunning(first.pid), false);
  assert.equal(backgroundRuntimeStatus(configPath).pid, second.pid);
});

test("verbose background starts forward the flag to the runtime child", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-verbose-start-"));
  const configPath = join(root, "daemon.yaml");
  const binaryPath = writeReadyRuntime(root);
  t.after(async () => {
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  await startBackgroundRuntime({
    binaryPath,
    configPath,
    projectDirs: [root],
    verbose: true,
  });

  const args = JSON.parse(readFileSync(join(root, "runtime-args.json"), "utf8")) as string[];
  assert.ok(args.includes("--verbose"));
});

function writeReadyRuntime(root: string, readyDelayMs = 0): string {
  const binaryPath = join(root, "gsd-cloud.js");
  writeFileSync(binaryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(root, "runtime-args.json"))}, JSON.stringify(process.argv.slice(2)));`,
    'process.on("SIGTERM", () => process.exit(0));',
    `setTimeout(() => process.send?.({ type: "ready" }), ${readyDelayMs});`,
    'setInterval(() => undefined, 1_000);',
  ].join("\n"));
  return binaryPath;
}

function writeLegacyRuntime(root: string, name: string): string {
  const binaryPath = join(root, name);
  writeFileSync(binaryPath, [
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1_000);",
  ].join("\n"));
  return binaryPath;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
