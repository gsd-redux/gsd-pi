// Project/App: Open GSD
// File Purpose: Regression coverage for detached cloud runtime process timing and shutdown.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_RUNTIME_INITIAL_CONNECT_WINDOW_MS } from "./cloud-runtime.js";
import {
  BACKGROUND_RUNTIME_READY_TIMEOUT_MS,
  backgroundRuntimeStatus,
  runtimeLogPath,
  runtimeStatePath,
  startBackgroundRuntime,
  stopBackgroundRuntime,
  writeRuntimeState,
} from "./runtime-process.js";
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
  assert.equal(existsSync(statePath), false);
});

test("custom configs migrate matching live legacy runtime state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-legacy-state-"));
  const configPath = join(root, "custom.yaml");
  const legacyStatePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
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
  test(`custom configs migrate legacy ${runtimeArgs.join(" ")} runtime state`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "gsd cloud foreground legacy "));
    const configPath = join(root, "custom runtime.yaml");
    const legacyStatePath = join(root, "cloud-runtime.json");
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
      ...runtimeArgs,
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

test("stop waits for the detached runtime to exit before removing its state", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stop-"));
  const configPath = join(root, "daemon.yaml");
  const statePath = join(root, "cloud-runtime.json");
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));process.send?.('ready');setInterval(()=>{},1000)",
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
  } else {
    assert.equal(processCommandIsRunning(binaryPath), false);
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
  } else {
    assert.equal(processCommandIsRunning(binaryPath), false);
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

function writeReadyRuntime(root: string): string {
  const binaryPath = join(root, "runtime.mjs");
  writeFileSync(binaryPath, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(root, "runtime-args.json"))}, JSON.stringify(process.argv.slice(2)));`,
    'process.on("SIGTERM", () => process.exit(0));',
    'process.send?.({ type: "ready" });',
    'setInterval(() => undefined, 1_000);',
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

function processCommandIsRunning(fragment: string): boolean {
  const output = spawnSync("/bin/ps", ["-ax", "-o", "command="], { encoding: "utf8" }).stdout;
  return output.split("\n").some((command) => command.includes(fragment));
}
