import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateWebProxyAuth, type WebProxyAuthRequest } from "../proxy-auth.ts";

function makeRequest(authorization?: string): WebProxyAuthRequest {
  return {
    pathname: "/api/boot",
    searchParams: new URLSearchParams(),
    headers: {
      get: (name: string) => name.toLowerCase() === "authorization" ? authorization ?? null : null,
    },
  };
}

describe("evaluateWebProxyAuth", () => {
  test("requires the configured local bearer token", () => {
    const testToken = ["local", "token"].join("-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GSD_WEB_AUTH_TOKEN: testToken,
    };

    assert.deepEqual(evaluateWebProxyAuth(makeRequest(`Bearer ${testToken}`), env), { kind: "next" });
    assert.deepEqual(evaluateWebProxyAuth(makeRequest(), env), {
      kind: "json",
      status: 401,
      body: { error: "Unauthorized" },
    });
  });
});
