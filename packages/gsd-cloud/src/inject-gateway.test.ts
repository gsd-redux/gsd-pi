// Project/App: Open GSD
// File Purpose: Unit tests locking the default-gateway injection contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectDefaultGateway, DEFAULT_GATEWAY } from "./inject-gateway.js";

test("Test 1: login without --gateway injects the default gateway", () => {
  const out = injectDefaultGateway(["login"]);
  assert.ok(out.includes("--gateway"), "expected --gateway flag");
  assert.ok(out.includes(DEFAULT_GATEWAY), "expected default gateway value");
  assert.equal(DEFAULT_GATEWAY, "https://cloud.opengsd.net");
  const idx = out.indexOf("--gateway");
  assert.equal(out[idx + 1], DEFAULT_GATEWAY, "value must follow the flag");
});

test("Test 2: login with explicit --gateway is returned unchanged", () => {
  const argv = ["login", "--gateway", "https://other.example"];
  const out = injectDefaultGateway(argv);
  assert.deepEqual(out, argv);
  assert.equal(out.filter((a) => a === "--gateway").length, 1, "no double gateway");
});

test("Test 3: pair without --gateway injects the default gateway", () => {
  const out = injectDefaultGateway(["pair", "--code", "X"]);
  assert.ok(out.includes("--gateway"), "expected --gateway flag");
  assert.ok(out.includes(DEFAULT_GATEWAY), "expected default gateway value");
});

test("Test 4: status/connect/disconnect are returned unchanged", () => {
  for (const cmd of ["status", "connect", "disconnect"]) {
    const out = injectDefaultGateway([cmd]);
    assert.deepEqual(out, [cmd], `${cmd} must not inject a gateway`);
  }
});

test("Test 5: empty argv (no command) is returned unchanged", () => {
  assert.deepEqual(injectDefaultGateway([]), []);
});

test("Test 6: login with equals-form --gateway=... is returned unchanged", () => {
  const argv = ["login", "--gateway=https://other.example"];
  const out = injectDefaultGateway(argv);
  assert.deepEqual(out, argv);
  assert.ok(!out.includes(DEFAULT_GATEWAY), "default gateway must not be appended");
  assert.equal(
    out.filter((a) => a === "--gateway" || a.startsWith("--gateway=")).length,
    1,
    "no double gateway",
  );
});
