// Project/App: Open GSD
// File Purpose: Acceptance coverage for the detached gsd-cloud runtime lifecycle.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { saveCloudConfig } from "./cloud-config.js";
import { runtimeArtifactPath } from "./runtime-artifacts.js";
import { startBackgroundRuntime, stopBackgroundRuntime } from "./runtime-process.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(packageRoot, "bin", "gsd-cloud.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface TestGateway {
  baseUrl: string;
  hello: Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

function runCli(
  args: string[],
  cwd: string,
  timeoutMs = 12_000,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, GSD_CLOUD_PROJECTS: undefined, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gsd-cloud did not return within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr });
    });
  });
}

interface ForegroundCli {
  child: ChildProcess;
  exited: Promise<number | null>;
}

// Spawn a long-lived CLI process (e.g. `--foreground`) without waiting for exit,
// so the test can inspect its state and then stop it.
function spawnForegroundCli(args: string[], cwd: string): ForegroundCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, GSD_CLOUD_PROJECTS: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
  return { child, exited };
}

async function createTestGateway(deviceFlow = false): Promise<TestGateway> {
  let baseUrl = "";
  const server = createServer((req, res) => {
    if (!deviceFlow) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/device/code") {
      res.end(JSON.stringify({
        userCode: "TEST-CODE",
        deviceCode: "test-device",
        verificationUriComplete: `${baseUrl}/approve-device?code=TEST-CODE`,
        expiresIn: 30,
      }));
      return;
    }
    if (req.url === "/api/device/token") {
      res.end(JSON.stringify({
        status: "approved",
        token: "test",
        runtimeId: "fixture-runtime",
        gateway_url: baseUrl,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  let helloTimeout: ReturnType<typeof setTimeout>;
  const hello = new Promise<Record<string, unknown>>((resolveHello, reject) => {
    helloTimeout = setTimeout(() => reject(new Error("background runtime did not advertise its project")), 8_000);
    wss.once("connection", (socket) => {
      socket.once("message", (data) => {
        clearTimeout(helloTimeout);
        resolveHello(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      });
    });
  });

  return {
    baseUrl,
    hello,
    close: async () => {
      clearTimeout(helloTimeout);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => wss.close(() => server.close(() => resolveClose())));
    },
  };
}

test("connect returns while a background runtime advertises the selected project", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-background-"));
  const projectDir = join(root, "project");
  const expectedProjectDir = join(realpathSync(root), "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });

  const gateway = await createTestGateway();
  t.after(async () => {
    await runCli(["disconnect", "--config", configPath], projectDir).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  const connect = await runCli(["connect", "--config", configPath], projectDir);
    assert.equal(connect.code, 0, connect.stderr);
    assert.match(connect.stdout, /connected in the background/i);

    const message = await gateway.hello;
    assert.equal(message.type, "hello");
    const projects = message.projects as Array<{ path: string }>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.path, expectedProjectDir);

    const status = await runCli(["status", "--config", configPath], projectDir);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      background?: { running?: boolean; pid?: number | null };
      projects?: string[];
    };
    assert.equal(statusBody.background?.running, true);
    assert.equal(typeof statusBody.background?.pid, "number");
  assert.deepEqual(statusBody.projects, [expectedProjectDir]);
});

test("stop terminates the background runtime without removing pairing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-stop-command-"));
  const projectDir = join(root, "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  const gateway = await createTestGateway();
  t.after(async () => {
    await runCli(["disconnect", "--config", configPath], projectDir).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  const connect = await runCli(["connect", "--config", configPath], projectDir);
    assert.equal(connect.code, 0, connect.stderr);
    await gateway.hello;

    const stop = await runCli(["stop", "--config", configPath], projectDir);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /background runtime stopped/i);

    const status = await runCli(["status", "--config", configPath], projectDir);
    const body = JSON.parse(status.stdout) as {
      configured?: boolean;
      runtime_id?: string;
      background?: { running?: boolean };
      telemetry?: unknown;
    };
    assert.equal(body.configured, true);
    assert.equal(body.runtime_id, "fixture-runtime");
    assert.equal(body.background?.running, false);
  assert.notEqual(body.telemetry, null);
});

test("login returns after approval and keeps the selected project connected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-login-background-"));
  const projectDir = join(root, "project");
  const expectedProjectDir = join(realpathSync(root), "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  const gateway = await createTestGateway(true);
  t.after(async () => {
    await runCli(["disconnect", "--config", configPath], projectDir).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  const login = await runCli([
      "login",
      "--gateway", gateway.baseUrl,
      "--config", configPath,
    ], projectDir, 12_000);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Authorization approved!/);
    assert.match(login.stdout, /connected in the background/i);

    const message = await gateway.hello;
    const projects = message.projects as Array<{ path: string }>;
    assert.deepEqual(projects.map((project) => project.path), [expectedProjectDir]);

    const disconnect = await runCli(["disconnect", "--config", configPath], projectDir);
    assert.equal(disconnect.code, 0, disconnect.stderr);
    const status = await runCli(["status", "--config", configPath], projectDir);
    const statusBody = JSON.parse(status.stdout) as {
      configured?: boolean;
      background?: { running?: boolean };
      telemetry?: unknown;
    };
    assert.equal(statusBody.configured, false);
    assert.equal(statusBody.background?.running, false);
  assert.equal(statusBody.telemetry, null);
});

test("advertised project paths are canonicalized through symlinks", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-cloud-symlink-")));
  const realProject = join(root, "real-project");
  mkdirSync(join(realProject, ".gsd"), { recursive: true });
  const linkProject = join(root, "link-project");
  symlinkSync(realProject, linkProject);
  const configPath = join(root, "daemon.yaml");
  const gateway = await createTestGateway();
  t.after(async () => {
    await runCli(["disconnect", "--config", configPath], realProject).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  // Point the runtime at the symlink; the advertised path must be the real dir.
    const connect = await runCli(
      ["connect", "--config", configPath],
      realProject,
      5_000,
      { GSD_CLOUD_PROJECTS: linkProject },
    );
    assert.equal(connect.code, 0, connect.stderr);

    const message = await gateway.hello;
    const projects = message.projects as Array<{ path: string }>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.path, realProject);

    const status = await runCli(["status", "--config", configPath], realProject);
    const statusBody = JSON.parse(status.stdout) as { projects?: string[] };
  assert.deepEqual(statusBody.projects, [realProject]);
});

test("a foreground runtime registers its PID so disconnect can stop it", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-cloud-foreground-")));
  const projectDir = join(root, "project");
  const configPath = join(root, "daemon.yaml");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  const gateway = await createTestGateway();

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  const foreground = spawnForegroundCli(["connect", "--foreground", "--config", configPath], projectDir);
  t.after(async () => {
    foreground.child.kill("SIGKILL");
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Once the foreground runtime advertises its project it is fully connected.
    await gateway.hello;

    // The foreground session must record its own PID in the shared runtime state
    // so status can see it and a later disconnect can find and stop it.
    const status = await runCli(["status", "--config", configPath], projectDir);
    const statusBody = JSON.parse(status.stdout) as {
      background?: { running?: boolean; pid?: number | null };
    };
    assert.equal(statusBody.background?.running, true);
    assert.equal(statusBody.background?.pid, foreground.child.pid);

    const disconnect = await runCli(["disconnect", "--config", configPath], projectDir);
    assert.equal(disconnect.code, 0, disconnect.stderr);

    // disconnect must have terminated the foreground process.
    const exitCode = await foreground.exited;
    assert.equal(exitCode, 0);

    const afterStatus = await runCli(["status", "--config", configPath], projectDir);
    const afterBody = JSON.parse(afterStatus.stdout) as { background?: { running?: boolean } };
  assert.equal(afterBody.background?.running, false);
});

test("foreground connect waits for an in-progress background start", { timeout: 10_000 }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-cloud-foreground-lock-")));
  const projectDir = join(root, "project");
  const configPath = join(root, "daemon.yaml");
  const delayedRuntimePath = join(root, "delayed-runtime.mjs");
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(delayedRuntimePath, [
    'process.on("SIGTERM", () => process.exit(0));',
    'setTimeout(() => process.send?.({ type: "ready" }), 3_000);',
    'setInterval(() => undefined, 1_000);',
  ].join("\n"));
  const gateway = await createTestGateway();

  saveCloudConfig(configPath, {
    gateway_url: gateway.baseUrl,
    device_token: "test",
    runtime_id: "fixture-runtime",
    enabled: true,
  });

  const backgroundStart = startBackgroundRuntime({
    binaryPath: delayedRuntimePath,
    configPath,
    projectDirs: [projectDir],
  });
  await waitForCondition(() => existsSync(runtimeArtifactPath(configPath, "start.lock")));
  await waitForCondition(() => existsSync(runtimeArtifactPath(configPath, "state")));
  const foreground = spawnForegroundCli(["connect", "--foreground", "--config", configPath], projectDir);
  t.after(async () => {
    foreground.child.kill("SIGKILL");
    await stopBackgroundRuntime(configPath).catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });

  const connectedBeforeBackgroundStartFinished = await Promise.race([
    gateway.hello.then(() => true),
    new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 500)),
  ]);
  assert.equal(connectedBeforeBackgroundStartFinished, false);
  const background = await backgroundStart;
  assert.equal(background.running, true);
  await gateway.hello;

  const disconnect = await runCli(["disconnect", "--config", configPath], projectDir);
  assert.equal(disconnect.code, 0, disconnect.stderr);
  assert.equal(await foreground.exited, 0);
});

async function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
