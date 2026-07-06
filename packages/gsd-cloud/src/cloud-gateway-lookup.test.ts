// Project/App: Open GSD
// File Purpose: Regression tests for createGatewayLookup — the custom DNS lookup
// must honor Node's `all: true` (autoSelectFamily/Happy Eyeballs) array form and
// still enforce the SSRF guard on every resolved address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayLookup } from "./cloud-config.js";

// Invoke the lookup and capture (err, result) from its Node-style callback.
function run(url: string, options: unknown): Promise<{ err: Error | null; result: unknown }> {
  const lookup = createGatewayLookup(new URL(url));
  return new Promise((resolve) => {
    (lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
      "localhost",
      options,
      (...args: unknown[]) => resolve({ err: (args[0] as Error | null) ?? null, result: args[1] }),
    );
  });
}

test("all:true resolves to an ARRAY for a http loopback URL (regression: was scalar → 'Invalid IP address')", async () => {
  const { err, result } = await run("http://localhost", { all: true, family: 0 });
  assert.equal(err, null, "loopback allowed for http URL");
  assert.ok(Array.isArray(result), "all:true must call back with an array");
  assert.ok((result as unknown[]).length > 0, "expected at least one address");
  for (const entry of result as Array<{ address: string; family: number }>) {
    assert.equal(typeof entry.address, "string");
    assert.ok(entry.family === 4 || entry.family === 6);
  }
});

test("all:true REJECTS when a resolved address is private/loopback (SSRF guard, https URL)", async () => {
  const { err } = await run("https://localhost", { all: true, family: 0 });
  assert.ok(err instanceof Error, "expected rejection");
  assert.match(err!.message, /private or loopback/);
});

test("scalar (all:false) path still guards: https loopback rejected, http loopback allowed", async () => {
  const rejected = await run("https://localhost", { all: false, family: 0 });
  assert.ok(rejected.err instanceof Error, "https loopback rejected in scalar path");
  const allowed = await run("http://localhost", { all: false, family: 0 });
  assert.equal(allowed.err, null, "http loopback allowed in scalar path");
  assert.equal(typeof allowed.result, "string", "scalar path returns a single address");
});
