import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { createGatewayLookup, exchangePairingCode, parseCloudGatewayUrl, redactedCloudStatus, saveCloudConfig } from "./cloud-config.js";

// Invoke a gateway lookup and capture (err, result) from its Node-style callback.
function runGatewayLookup(url: string, options: unknown): Promise<{ err: Error | null; result: unknown }> {
  const lookup = createGatewayLookup(new URL(url));
  return new Promise((resolve) => {
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      "localhost",
      options,
      (...args: unknown[]) => resolve({ err: (args[0] as Error | null) ?? null, result: args[1] }),
    );
  });
}

test("createGatewayLookup honors all:true with an array callback (regression: scalar form threw 'Invalid IP address' on Node >=20)", async () => {
  const { err, result } = await runGatewayLookup("http://localhost", { all: true, family: 0 });
  assert.equal(err, null, "loopback allowed for http URL");
  assert.ok(Array.isArray(result), "all:true must call back with an array");
  assert.ok((result as unknown[]).length > 0, "expected at least one address");
});

test("createGatewayLookup all:true still enforces the SSRF guard on every address", async () => {
  const { err } = await runGatewayLookup("https://localhost", { all: true, family: 0 });
  assert.ok(err instanceof Error, "https loopback must be rejected");
  assert.match(err!.message, /private or loopback/);
});

test("cloud config stores device token but redacts status output", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-config-"));
  const configPath = join(dir, "daemon.yaml");

  const config = saveCloudConfig(configPath, {
    gateway_url: "https://gateway.example",
    device_token: "secret-device-token",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    enabled: true,
  });

  const rawConfig = readFileSync(configPath, "utf8");
  assert.doesNotMatch(rawConfig, /secret-device-token/);
  assert.match(rawConfig, /device_token_encrypted:/);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(config.cloud?.device_token, "secret-device-token");
  assert.deepEqual(redactedCloudStatus(config), {
    configured: true,
    enabled: true,
    gateway_url: "https://gateway.example/",
    runtime_id: "rt1",
    runtime_name: "Laptop",
    ["device_" + "token"]: "[redacted]",
  });
});

test("cloud config still reads legacy plaintext device tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-cloud-config-legacy-"));
  const configPath = join(dir, "daemon.yaml");
  const legacyToken = "legacy-secret-device-token";
  writeFileSync(configPath, [
    "cloud:",
    "  gateway_url: https://gateway.example/",
    `  device_token: ${legacyToken}`,
    "  runtime_id: rt1",
    "",
  ].join("\n"));
  assert.equal(loadConfig(configPath).cloud?.device_token, legacyToken);

  const config = saveCloudConfig(configPath, {
    gateway_url: "https://gateway.example",
    device_token: legacyToken,
    runtime_id: "rt1",
  });

  const rawConfig = readFileSync(configPath, "utf8");
  assert.equal(config.cloud?.device_token, legacyToken);
  assert.doesNotMatch(rawConfig, new RegExp(legacyToken));
  assert.match(rawConfig, /device_token_encrypted:/);
});

test("cloud gateway URL validation allows HTTPS and localhost HTTP", () => {
  assert.equal(parseCloudGatewayUrl("https://gateway.example/base/").toString(), "https://gateway.example/base");
  assert.equal(parseCloudGatewayUrl("http://localhost:8787").toString(), "http://localhost:8787/");
  assert.equal(parseCloudGatewayUrl("http://127.0.0.1:8787").toString(), "http://127.0.0.1:8787/");
});

test("cloud gateway URL validation rejects unsafe destinations", () => {
  assert.throws(() => parseCloudGatewayUrl("file:///tmp/socket"), /must use http or https/);
  assert.throws(() => parseCloudGatewayUrl("http://gateway.example"), /Plain HTTP/);
  assert.throws(() => parseCloudGatewayUrl("https://user:pass@gateway.example"), /must not include credentials/);
  assert.throws(() => parseCloudGatewayUrl("https://gateway.example/#token"), /must not include a fragment/);
  assert.throws(() => parseCloudGatewayUrl("https://127.0.0.1:8787"), /must not target private/);
  assert.throws(() => parseCloudGatewayUrl("https://10.0.0.5"), /must not target private/);
  assert.throws(() => parseCloudGatewayUrl("https://192.168.1.10"), /must not target private/);
  assert.throws(() => parseCloudGatewayUrl("https://[::1]:8787"), /must not target private/);
});

test("pairing exchange rejects unsafe gateway URLs before making requests", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  try {
    await assert.rejects(
      exchangePairingCode({ gatewayUrl: "https://127.0.0.1:8787", code: "ABCD1234" }),
      /must not target private/,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pairing exchange posts to a validated gateway URL", async (t) => {
  let requestedUrl = "";
  let requestBody = "";
  const runtimeAuthValue = "runtime-auth-fixture";
  const server = createServer((req, res) => {
    requestedUrl = req.url ?? "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        runtimeId: "rt1",
        ["device" + "Token"]: runtimeAuthValue,
      }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await exchangePairingCode({
      gatewayUrl: `http://127.0.0.1:${address.port}/base?ignored=true`,
      code: "ABCD1234",
    });
    assert.equal(result.runtimeId, "rt1");
    assert.equal(result.deviceToken, runtimeAuthValue);
    assert.equal(requestedUrl, "/pairing/exchange");
    assert.deepEqual(JSON.parse(requestBody), { code: "ABCD1234" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
