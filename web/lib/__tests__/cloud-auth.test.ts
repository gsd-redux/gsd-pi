import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mintCloudSessionCookie,
  parseCookieHeader,
  serializeCloudSessionCookie,
  signCloudPayload,
  validateAppBridgeToken,
  verifyCloudSessionCookie,
  verifyCloudToken,
} from "../cloud-auth.ts";
import { CLOUD_SESSION_COOKIE } from "../cloud-mode.ts";

const SECRET = "test-app-bridge-secret";

const NOW = 1_800_000_000;

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sub: "user-123",
    deviceId: "device-abc",
    role: "owner",
    projects: ["alpha", "beta"],
    exp: NOW + 600,
    ...overrides,
  };
}

function makeToken(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  return signCloudPayload(makePayload(overrides), secret);
}

describe("validateAppBridgeToken", () => {
  test("accepts a valid token and returns the session claims", () => {
    const session = validateAppBridgeToken(makeToken(), SECRET, NOW);
    assert.deepEqual(session, {
      sub: "user-123",
      deviceId: "device-abc",
      role: "owner",
      projects: ["alpha", "beta"],
      exp: NOW + 600,
    });
  });

  test("rejects a token signed with a different secret", () => {
    const token = makeToken({}, "wrong-secret");
    assert.equal(validateAppBridgeToken(token, SECRET, NOW), null);
  });

  test("rejects a tampered payload", () => {
    const token = makeToken();
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.role = "owner";
    payload.projects = ["alpha", "beta", "evil"];
    const tamperedBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    assert.equal(validateAppBridgeToken(`${tamperedBody}.${sig}`, SECRET, NOW), null);
  });

  test("rejects an expired token", () => {
    const token = makeToken({ exp: NOW - 1 });
    assert.equal(validateAppBridgeToken(token, SECRET, NOW), null);
  });

  test("rejects a token expiring exactly now", () => {
    const token = makeToken({ exp: NOW });
    assert.equal(validateAppBridgeToken(token, SECRET, NOW), null);
  });

  test("rejects wrong version", () => {
    assert.equal(validateAppBridgeToken(makeToken({ v: 2 }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ v: 0 }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ v: "1" }), SECRET, NOW), null);
  });

  test("rejects an unknown role", () => {
    assert.equal(validateAppBridgeToken(makeToken({ role: "admin" }), SECRET, NOW), null);
  });

  test("rejects malformed payloads", () => {
    assert.equal(validateAppBridgeToken(makeToken({ sub: "" }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ deviceId: 42 }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ projects: "alpha" }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ projects: ["alpha", 7] }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ exp: "soon" }), SECRET, NOW), null);
  });

  test("accepts member and viewer roles", () => {
    for (const role of ["member", "viewer"] as const) {
      const session = validateAppBridgeToken(makeToken({ role }), SECRET, NOW);
      assert.equal(session?.role, role);
    }
  });

  test("carries the device owner claim when present", () => {
    const session = validateAppBridgeToken(makeToken({ owner: "user-owner-9" }), SECRET, NOW);
    assert.equal(session?.sub, "user-123");
    assert.equal(session?.owner, "user-owner-9");
  });

  test("omits owner when the token has no owner claim", () => {
    const session = validateAppBridgeToken(makeToken(), SECRET, NOW);
    assert.equal(session?.owner, undefined);
  });

  test("rejects a malformed owner claim", () => {
    assert.equal(validateAppBridgeToken(makeToken({ owner: 42 }), SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(makeToken({ owner: "" }), SECRET, NOW), null);
  });

  test("rejects structurally invalid tokens", () => {
    assert.equal(validateAppBridgeToken("", SECRET, NOW), null);
    assert.equal(validateAppBridgeToken("no-signature", SECRET, NOW), null);
    assert.equal(validateAppBridgeToken(".sig", SECRET, NOW), null);
    assert.equal(validateAppBridgeToken("body.", SECRET, NOW), null);
    assert.equal(validateAppBridgeToken("a.b.c", SECRET, NOW), null);
  });

  test("rejects a correctly-signed non-JSON body", () => {
    const body = Buffer.from("not json", "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    assert.equal(validateAppBridgeToken(`${body}.${sig}`, SECRET, NOW), null);
  });

  test("verifyCloudToken rejects non-object JSON payloads", () => {
    const body = Buffer.from("[1,2,3]", "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    assert.equal(verifyCloudToken(`${body}.${sig}`, SECRET), null);
  });
});

describe("cloud session cookie", () => {
  test("round-trips through mint and verify", () => {
    const value = mintCloudSessionCookie(
      { sub: "user-1", deviceId: "dev-1", role: "viewer", projects: ["only"] },
      SECRET,
      NOW,
    );
    const session = verifyCloudSessionCookie(value, SECRET, NOW + 60);
    assert.deepEqual(session, {
      sub: "user-1",
      deviceId: "dev-1",
      role: "viewer",
      projects: ["only"],
      exp: NOW + 8 * 60 * 60,
    });
  });

  test("round-trips the owner claim through mint and verify", () => {
    const value = mintCloudSessionCookie(
      { sub: "user-2", owner: "user-owner-9", deviceId: "dev-1", role: "member", projects: ["alpha"] },
      SECRET,
      NOW,
    );
    const session = verifyCloudSessionCookie(value, SECRET, NOW + 60);
    assert.equal(session?.sub, "user-2");
    assert.equal(session?.owner, "user-owner-9");
  });

  test("expires after the max age", () => {
    const value = mintCloudSessionCookie(
      { sub: "user-1", deviceId: "dev-1", role: "owner", projects: [] },
      SECRET,
      NOW,
    );
    assert.equal(verifyCloudSessionCookie(value, SECRET, NOW + 8 * 60 * 60), null);
  });

  test("rejects a cookie signed with a different secret", () => {
    const value = mintCloudSessionCookie(
      { sub: "user-1", deviceId: "dev-1", role: "owner", projects: [] },
      "other-secret",
      NOW,
    );
    assert.equal(verifyCloudSessionCookie(value, SECRET, NOW), null);
  });
});

describe("parseCookieHeader", () => {
  test("extracts a named cookie", () => {
    assert.equal(parseCookieHeader("a=1; gsd_cloud_session=xyz; b=2", CLOUD_SESSION_COOKIE), "xyz");
  });

  test("decodes URI-encoded values", () => {
    assert.equal(parseCookieHeader("gsd_cloud_session=a%3Db", CLOUD_SESSION_COOKIE), "a=b");
  });

  test("returns null when missing or empty", () => {
    assert.equal(parseCookieHeader(null, CLOUD_SESSION_COOKIE), null);
    assert.equal(parseCookieHeader("other=1", CLOUD_SESSION_COOKIE), null);
    assert.equal(parseCookieHeader("gsd_cloud_session=", CLOUD_SESSION_COOKIE), null);
  });
});

describe("serializeCloudSessionCookie", () => {
  test("includes httpOnly, lax same-site, path and max-age", () => {
    const serialized = serializeCloudSessionCookie("value", { secure: false });
    assert.match(serialized, /^gsd_cloud_session=value/);
    assert.match(serialized, /Path=\//);
    assert.match(serialized, /HttpOnly/);
    assert.match(serialized, /SameSite=Lax/);
    assert.match(serialized, /Max-Age=28800/);
    assert.doesNotMatch(serialized, /Secure/);
  });

  test("adds Secure when requested", () => {
    const serialized = serializeCloudSessionCookie("value", { secure: true });
    assert.match(serialized, /; Secure$/);
  });
});
