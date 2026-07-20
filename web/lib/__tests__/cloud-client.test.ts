import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { canCloudMutate, getCloudClientSession, isCloudModeClient } from "../cloud-client.ts";

describe("cloud-client", () => {
  let hadWindow = false;
  let savedWindow: unknown;

  beforeEach(() => {
    hadWindow = "window" in globalThis;
    savedWindow = (globalThis as Record<string, unknown>).window;
  });

  afterEach(() => {
    if (hadWindow) {
      (globalThis as Record<string, unknown>).window = savedWindow;
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  function setCloudSession(value: unknown) {
    (globalThis as Record<string, unknown>).window = { __GSD_CLOUD__: value };
  }

  test("returns null when window is undefined (server)", () => {
    delete (globalThis as Record<string, unknown>).window;
    assert.equal(getCloudClientSession(), null);
    assert.equal(isCloudModeClient(), false);
    assert.equal(canCloudMutate(), true);
  });

  test("returns null when no session is injected (local mode)", () => {
    (globalThis as Record<string, unknown>).window = {};
    assert.equal(getCloudClientSession(), null);
    assert.equal(isCloudModeClient(), false);
    assert.equal(canCloudMutate(), true);
  });

  test("returns the injected session in cloud mode", () => {
    setCloudSession({ sub: "u1", deviceId: "d1", role: "owner", projects: ["alpha"] });
    assert.deepEqual(getCloudClientSession(), {
      sub: "u1",
      deviceId: "d1",
      role: "owner",
      projects: ["alpha"],
    });
    assert.equal(isCloudModeClient(), true);
  });

  test("rejects malformed sessions", () => {
    setCloudSession({ role: "owner" });
    assert.equal(getCloudClientSession(), null);
    setCloudSession("nope");
    assert.equal(getCloudClientSession(), null);
  });

  test("owner and member roles may mutate", () => {
    setCloudSession({ sub: "u", deviceId: "d", role: "owner", projects: [] });
    assert.equal(canCloudMutate(), true);
    setCloudSession({ sub: "u", deviceId: "d", role: "member", projects: [] });
    assert.equal(canCloudMutate(), true);
  });

  test("viewer role may not mutate", () => {
    setCloudSession({ sub: "u", deviceId: "d", role: "viewer", projects: [] });
    assert.equal(canCloudMutate(), false);
    assert.equal(isCloudModeClient(), true);
  });

  test("explicit session argument overrides the window value", () => {
    setCloudSession({ sub: "u", deviceId: "d", role: "viewer", projects: [] });
    assert.equal(canCloudMutate({ sub: "u", deviceId: "d", role: "owner", projects: [] }), true);
    assert.equal(canCloudMutate(null), true);
  });
});
