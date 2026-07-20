import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateWebProxyAuth, type WebProxyAuthRequest } from "../proxy-auth.ts";
import { mintCloudSessionCookie } from "../cloud-auth.ts";
import { CLOUD_SESSION_COOKIE } from "../cloud-mode.ts";

const CLOUD_ENV: NodeJS.ProcessEnv = {
  GSD_CLOUD_MODE: "1",
  GATEWAY_INTERNAL_URL: "https://gateway.example.com",
  GATEWAY_INTERNAL_TOKEN: "internal-token",
  APP_BRIDGE_SECRET: "app-bridge-secret",
};

function makeRequest(overrides: Partial<WebProxyAuthRequest> = {}): WebProxyAuthRequest {
  const headerMap = new Map<string, string>(overrides.headers ? undefined : []);
  const request: WebProxyAuthRequest = {
    pathname: "/api/boot",
    searchParams: new URLSearchParams(),
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    ...overrides,
  };
  return request;
}

function withCookie(cookieValue: string | null): WebProxyAuthRequest["headers"] {
  return {
    get: (name: string) =>
      name.toLowerCase() === "cookie" && cookieValue ? `${CLOUD_SESSION_COOKIE}=${cookieValue}` : null,
  };
}

function validCookie(overrides: { projects?: string[]; role?: "owner" | "member" | "viewer" } = {}): string {
  return mintCloudSessionCookie(
    {
      sub: "user-1",
      deviceId: "device-1",
      role: overrides.role ?? "owner",
      projects: overrides.projects ?? ["alpha", "beta"],
    },
    CLOUD_ENV.APP_BRIDGE_SECRET!,
  );
}

describe("evaluateWebProxyAuth — cloud mode", () => {
  test("allows /api/cloud/bootstrap without a cookie", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({ pathname: "/api/cloud/bootstrap", searchParams: new URLSearchParams("token=abc") }),
      CLOUD_ENV,
    );
    assert.deepEqual(decision, { kind: "next" });
  });

  test("rejects API requests without a cookie (401)", () => {
    const decision = evaluateWebProxyAuth(makeRequest(), CLOUD_ENV);
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("rejects an invalid cookie (401)", () => {
    const decision = evaluateWebProxyAuth(makeRequest({ headers: withCookie("garbage") }), CLOUD_ENV);
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("rejects a cookie signed with the wrong secret (401)", () => {
    const cookie = mintCloudSessionCookie(
      { sub: "user-1", deviceId: "device-1", role: "owner", projects: ["alpha"] },
      "wrong-secret",
    );
    const decision = evaluateWebProxyAuth(makeRequest({ headers: withCookie(cookie) }), CLOUD_ENV);
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("accepts a valid cookie", () => {
    const decision = evaluateWebProxyAuth(makeRequest({ headers: withCookie(validCookie()) }), CLOUD_ENV);
    assert.deepEqual(decision, { kind: "next" });
  });

  test("accepts a granted ?project= alias", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({
        headers: withCookie(validCookie()),
        searchParams: new URLSearchParams("project=alpha"),
      }),
      CLOUD_ENV,
    );
    assert.deepEqual(decision, { kind: "next" });
  });

  test("rejects an ungranted ?project= alias (403)", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({
        headers: withCookie(validCookie()),
        searchParams: new URLSearchParams("project=evil"),
      }),
      CLOUD_ENV,
    );
    assert.deepEqual(decision, { kind: "json", status: 403, body: { error: "Forbidden: project not granted" } });
  });

  test("fails closed when cloud env config is incomplete", () => {
    const decision = evaluateWebProxyAuth(makeRequest({ headers: withCookie(validCookie()) }), {
      GSD_CLOUD_MODE: "1",
    });
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("ignores the local bearer token in cloud mode", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({
        headers: {
          get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer local-token" : null),
        },
      }),
      { ...CLOUD_ENV, GSD_WEB_AUTH_TOKEN: "local-token" },
    );
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("does not touch non-API paths", () => {
    const decision = evaluateWebProxyAuth(makeRequest({ pathname: "/favicon.ico" }), CLOUD_ENV);
    assert.deepEqual(decision, { kind: "next" });
  });
});

describe("evaluateWebProxyAuth — local mode regression", () => {
  test("passes requests through when no token is configured", () => {
    const decision = evaluateWebProxyAuth(makeRequest(), {});
    assert.deepEqual(decision, { kind: "next" });
  });

  test("accepts the configured bearer token", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({
        headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer tok" : null) },
      }),
      { GSD_WEB_AUTH_TOKEN: "tok" },
    );
    assert.deepEqual(decision, { kind: "next" });
  });

  test("rejects a wrong bearer token (401)", () => {
    const decision = evaluateWebProxyAuth(makeRequest(), { GSD_WEB_AUTH_TOKEN: "tok" });
    assert.deepEqual(decision, { kind: "json", status: 401, body: { error: "Unauthorized" } });
  });

  test("rejects an origin mismatch (403)", () => {
    const decision = evaluateWebProxyAuth(
      makeRequest({
        headers: {
          get: (name: string) => {
            const lower = name.toLowerCase();
            if (lower === "authorization") return "Bearer tok";
            if (lower === "origin") return "https://evil.example.com";
            return null;
          },
        },
      }),
      { GSD_WEB_AUTH_TOKEN: "tok" },
    );
    assert.deepEqual(decision, { kind: "json", status: 403, body: { error: "Forbidden: origin mismatch" } });
  });
});
