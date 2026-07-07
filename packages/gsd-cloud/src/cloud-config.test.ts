// Project/App: Open GSD
// File Purpose: SSRF-guard matrix for the cloud gateway URL parser. Loosening any
// branch in parseCloudGatewayUrl / validateGatewayNetworkTarget (plain-HTTP carve-out,
// private/loopback IP rejection, protocol/credential/fragment checks) turns a case red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCloudGatewayUrl, validateGatewayNetworkTarget } from "./cloud-config.js";

// Each rejected case pairs an untrusted input with the substring the guard must
// report — so a message change is deliberate, not accidental.
const REJECTED: Array<{ input: string; message: RegExp }> = [
  // Plain HTTP is only allowed for loopback hosts.
  { input: "http://evil.example", message: /only allowed for localhost/ },
  // RFC1918 private ranges over HTTPS.
  { input: "https://10.0.0.1", message: /private or loopback/ },
  { input: "https://192.168.1.1", message: /private or loopback/ },
  { input: "https://172.16.0.1", message: /private or loopback/ },
  // Link-local / cloud metadata endpoint.
  { input: "https://169.254.169.254", message: /private or loopback/ },
  // Loopback over HTTPS (IPv4 and IPv6 forms) and the localhost hostname.
  { input: "https://127.0.0.1", message: /private or loopback/ },
  { input: "https://[::1]", message: /private or loopback/ },
  { input: "https://localhost", message: /private or loopback/ },
  // Non-HTTP protocol.
  { input: "ftp://gateway.example", message: /must use http or https/ },
  // Embedded credentials / fragments are rejected outright.
  { input: "https://user:pass@gateway.example", message: /must not include credentials/ },
  { input: "https://gateway.example/#frag", message: /must not include a fragment/ },
  // Unparseable / non-absolute inputs.
  { input: "", message: /absolute HTTP\(S\) URL/ },
  { input: "not a url", message: /absolute HTTP\(S\) URL/ },
];

for (const { input, message } of REJECTED) {
  test(`parseCloudGatewayUrl rejects ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseCloudGatewayUrl(input), message);
  });
}

// Accepted: a public HTTPS host and the documented local-dev plain-HTTP loopback carve-out.
const ACCEPTED: Array<{ input: string; hostname: string; protocol: string }> = [
  { input: "https://cloud-gateway.opengsd.net", hostname: "cloud-gateway.opengsd.net", protocol: "https:" },
  { input: "http://localhost:8787", hostname: "localhost", protocol: "http:" },
  { input: "http://127.0.0.1:8787", hostname: "127.0.0.1", protocol: "http:" },
];

for (const { input, hostname, protocol } of ACCEPTED) {
  test(`parseCloudGatewayUrl accepts ${JSON.stringify(input)}`, () => {
    const url = parseCloudGatewayUrl(input);
    assert.equal(url.hostname, hostname);
    assert.equal(url.protocol, protocol);
    // Round-trips to a usable absolute URL for the same host.
    assert.equal(new URL(url.toString()).hostname, hostname);
  });
}

// validateGatewayNetworkTarget is the request-time defense-in-depth guard applied to
// already-constructed URLs (device code/token endpoints). Cover its branches directly.
test("validateGatewayNetworkTarget rejects private/loopback targets", () => {
  assert.throws(() => validateGatewayNetworkTarget(new URL("https://169.254.169.254")), /private or loopback/);
  assert.throws(() => validateGatewayNetworkTarget(new URL("https://10.0.0.1")), /private or loopback/);
  assert.throws(() => validateGatewayNetworkTarget(new URL("https://[::1]")), /private or loopback/);
});

test("validateGatewayNetworkTarget allows a public HTTPS host and http loopback", () => {
  assert.doesNotThrow(() => validateGatewayNetworkTarget(new URL("https://cloud-gateway.opengsd.net")));
  assert.doesNotThrow(() => validateGatewayNetworkTarget(new URL("http://localhost:8787")));
  assert.doesNotThrow(() => validateGatewayNetworkTarget(new URL("http://127.0.0.1:8787")));
});
