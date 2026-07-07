// Project/App: Open GSD
// File Purpose: Drive runDeviceFlow against a loopback HTTP server to cover the RFC 8628
// poll state machine (pending→approved), the missing-token guard, and re-validation of the
// UNTRUSTED server-supplied gateway_url (valid wins / invalid falls back without crashing).
//
// The denied and expired paths are intentionally NOT tested here: runDeviceFlow calls
// process.exit(1) on both (D-11/D-12), which an in-process node:test cannot survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { runDeviceFlow } from "./device-flow.js";
import { parseCloudGatewayUrl } from "./cloud-config.js";

// runDeviceFlow requires a configPath but never reads it (saving is the caller's job),
// so a constant avoids pointless per-test tmp-dir I/O.
const CONFIG_PATH = "unused-by-runDeviceFlow.yaml";

/** Returns the JSON body /api/device/token should answer with on POST number `callCount` (1-based). */
type TokenResponder = (callCount: number) => Record<string, unknown>;

/**
 * Stand up a loopback HTTP server implementing both device-flow endpoints. Counts token
 * POSTs so the poll loop's progression can be asserted; `tokenResponder` shapes each reply.
 */
function startDeviceServer(tokenResponder: TokenResponder): Promise<{ server: Server; baseUrl: string; tokenCalls: () => number }> {
  let tokenCalls = 0;
  const server = createServer((req, res) => {
    req.setEncoding("utf8");
    req.on("data", () => { /* body drained; contents are not asserted */ });
    req.on("end", () => {
      if (req.url === "/api/device/code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          userCode: "ABCD-1234",
          deviceCode: "device-code-fixture",
          verificationUriComplete: "https://example.test/verify",
          // Short-lived so the timeout path is bounded if a test ever fails to approve.
          expiresIn: 30,
        }));
        return;
      }
      if (req.url === "/api/device/token") {
        tokenCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(tokenResponder(tokenCalls)));
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
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, tokenCalls: () => tokenCalls });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Silence spinner stdout noise and capture stderr so the invalid-URL warning can be asserted. */
function silenceOutput(): { restore: () => void; stderr: () => string } {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let capturedErr = "";
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = (() => true) as typeof process.stdout.write;
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((chunk: unknown) => {
    capturedErr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalOut;
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalErr;
    },
    stderr: () => capturedErr,
  };
}

/** Run the flow against a server, always silencing output and closing the server. */
async function drive(
  tokenResponder: TokenResponder,
  assertResult: (result: Awaited<ReturnType<typeof runDeviceFlow>>, ctx: { baseUrl: string; tokenCalls: () => number; stderr: string }) => void,
  t: { skip: (msg: string) => void },
): Promise<void> {
  let started: { server: Server; baseUrl: string; tokenCalls: () => number };
  try {
    started = await startDeviceServer(tokenResponder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  const out = silenceOutput();
  try {
    const result = await runDeviceFlow({
      gatewayUrl: started.baseUrl,
      configPath: CONFIG_PATH,
      binaryName: "gsd",
    });
    out.restore();
    assertResult(result, { baseUrl: started.baseUrl, tokenCalls: started.tokenCalls, stderr: out.stderr() });
  } finally {
    out.restore();
    await closeServer(started.server);
  }
}

test("immediate approval resolves with token, runtimeId, and the passed --gateway", async (t) => {
  await drive(
    () => ({ status: "approved", token: "tok", runtimeId: "rt" }),
    (result, ctx) => {
      assert.equal(result.deviceToken, "tok");
      assert.equal(result.runtimeId, "rt");
      assert.equal(result.gatewayUrl, ctx.baseUrl);
    },
    t,
  );
});

test("pending then approved keeps polling until approval", async (t) => {
  await drive(
    (call) => (call < 2 ? { status: "pending" } : { status: "approved", token: "tok", runtimeId: "rt" }),
    (result, ctx) => {
      assert.equal(result.deviceToken, "tok");
      assert.ok(ctx.tokenCalls() >= 2, `expected >=2 token polls, saw ${ctx.tokenCalls()}`);
    },
    t,
  );
});

test("a VALID server-supplied gateway_url wins over the passed --gateway", async (t) => {
  const serverGateway = "https://relay.opengsd.net";
  await drive(
    () => ({ status: "approved", token: "tok", runtimeId: "rt", gateway_url: serverGateway }),
    (result) => {
      // Mirror the code's own resolution: parse + toString normalization.
      assert.equal(result.gatewayUrl, parseCloudGatewayUrl(serverGateway).toString());
    },
    t,
  );
});

test("an INVALID server-supplied gateway_url falls back to --gateway without throwing", async (t) => {
  await drive(
    () => ({ status: "approved", token: "tok", runtimeId: "rt", gateway_url: "https://169.254.169.254" }),
    (result, ctx) => {
      assert.equal(result.gatewayUrl, ctx.baseUrl);
      assert.match(ctx.stderr, /ignoring invalid server-supplied relay URL/);
    },
    t,
  );
});

test("approval missing token/runtimeId rejects", async (t) => {
  let started: { server: Server; baseUrl: string; tokenCalls: () => number };
  try {
    started = await startDeviceServer(() => ({ status: "approved", runtimeId: "rt" }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("loopback listen is blocked in this sandbox");
      return;
    }
    throw err;
  }
  const out = silenceOutput();
  try {
    await assert.rejects(
      runDeviceFlow({ gatewayUrl: started.baseUrl, configPath: CONFIG_PATH, binaryName: "gsd" }),
      /missing token or runtimeId/,
    );
  } finally {
    out.restore();
    await closeServer(started.server);
  }
});
