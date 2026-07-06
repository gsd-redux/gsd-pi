// Device-flow gateway_url resolution tests: server-valid-wins, absent-falls-back,
// invalid-falls-back-no-throw. Drives runDeviceFlow against a local loopback HTTP server.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDeviceFlow } from "./device-flow.js";

/** Server-side gateway_url behaviour for a single test case. */
type GatewayCase =
  | { kind: "value"; value: string }
  | { kind: "absent" };

/**
 * Stand up a loopback HTTP server implementing both device-flow endpoints.
 * `/api/device/code` returns a code payload; `/api/device/token` returns an
 * approved response whose `gateway_url` field is shaped per `gatewayCase`.
 */
function startDeviceServer(gatewayCase: GatewayCase): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/api/device/code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          userCode: "ABCD-1234",
          deviceCode: "device-code-fixture",
          verificationUriComplete: "https://example.test/verify?code=ABCD-1234",
          expiresIn: 600,
        }));
        return;
      }
      if (req.url === "/api/device/token") {
        const approved: Record<string, unknown> = {
          status: "approved",
          token: "device-token-fixture",
          runtimeId: "rt-fixture",
        };
        if (gatewayCase.kind === "value") {
          approved["gateway_url"] = gatewayCase.value;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(approved));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("failed to bind loopback test server"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Capture stderr writes so the invalid-URL warning can be asserted. */
function captureStderr(): { restore: () => void; output: () => string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = original;
    },
    output: () => captured,
  };
}

function configPathFixture(): string {
  return join(mkdtempSync(join(tmpdir(), "gsd-device-flow-")), "daemon.yaml");
}

test("device flow uses a valid server gateway_url over the passed --gateway", async (t) => {
  let started: { server: Server; baseUrl: string };
  try {
    // A different, valid loopback URL than the login base — server value should win.
    const serverGateway = "https://relay.example/gateway";
    started = await startDeviceServer({ kind: "value", value: serverGateway });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  try {
    const result = await runDeviceFlow({
      gatewayUrl: started.baseUrl,
      configPath: configPathFixture(),
      binaryName: "gsd",
    });
    // Server-returned value wins, normalized (trailing slash stripped from path).
    assert.equal(result.gatewayUrl, "https://relay.example/gateway");
    assert.notEqual(result.gatewayUrl, started.baseUrl);
    assert.equal(result.deviceToken, "device-token-fixture");
    assert.equal(result.runtimeId, "rt-fixture");
  } finally {
    await closeServer(started.server);
  }
});

test("device flow falls back to --gateway when server omits gateway_url (backward-compat)", async (t) => {
  let started: { server: Server; baseUrl: string };
  try {
    started = await startDeviceServer({ kind: "absent" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  try {
    const result = await runDeviceFlow({
      gatewayUrl: started.baseUrl,
      configPath: configPathFixture(),
      binaryName: "gsd",
    });
    // Load-bearing invariant: with no server gateway_url, the passed --gateway is preserved.
    assert.equal(result.gatewayUrl, started.baseUrl);
    assert.equal(result.deviceToken, "device-token-fixture");
    assert.equal(result.runtimeId, "rt-fixture");
  } finally {
    await closeServer(started.server);
  }
});

test("device flow falls back to --gateway when server gateway_url is invalid (no throw)", async (t) => {
  let started: { server: Server; baseUrl: string };
  try {
    // A private-IP https URL fails validateGatewayNetworkTarget — must fall back, not crash.
    started = await startDeviceServer({ kind: "value", value: "https://10.0.0.5/gateway" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  const stderr = captureStderr();
  let capturedWarning = "";
  try {
    const result = await runDeviceFlow({
      gatewayUrl: started.baseUrl,
      configPath: configPathFixture(),
      binaryName: "gsd",
    });
    capturedWarning = stderr.output();
    stderr.restore();
    // Invalid server value is ignored; passed --gateway is used; login does not throw.
    assert.equal(result.gatewayUrl, started.baseUrl);
    assert.match(capturedWarning, /ignoring invalid server-supplied relay URL/);
  } finally {
    stderr.restore();
    await closeServer(started.server);
  }
});
