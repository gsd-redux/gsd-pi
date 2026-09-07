import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindStore, NO_PROJECT_MESSAGE, canonicalConversationId, resolveProject, routeFromCommandContext, routeFromDeliveryContext, routeKey, validateProjectPath } from "./binding.js";

function withTempDir<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "open-gsd-openclaw-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("routeFromCommandContext", () => {
  it("keys on channel, account, conversation and thread", () => {
    const route = routeFromCommandContext({ channel: "telegram", accountId: "bot1", to: "-100123", from: "42", messageThreadId: 7 });
    assert.deepEqual(route, { channel: "telegram", accountId: "bot1", conversationId: "-100123", threadId: "7" });
    assert.equal(routeKey(route!), "telegram|bot1|-100123|7");
  });

  it("falls back from `to` to `from` to the session key", () => {
    assert.equal(routeFromCommandContext({ channel: "discord", from: "user9" })?.conversationId, "user9");
    assert.equal(routeFromCommandContext({ channel: "webchat", sessionKey: "agent:main:main" })?.conversationId, "agent:main:main");
    assert.equal(routeFromCommandContext({ channel: "webchat" }), null);
  });

  it("canonicalizes Telegram topic targets so command and delivery routes agree", () => {
    assert.equal(canonicalConversationId("telegram:-100123:topic:7"), "telegram:-100123");
    assert.equal(canonicalConversationId("telegram:42:direct-topic:9"), "telegram:42:direct-topic:9", "a DM topic is only addressable in-band, and both paths carry it");
    assert.equal(canonicalConversationId(" telegram:-100123 "), "telegram:-100123");
    assert.equal(canonicalConversationId("telegram:-100123:topic:x"), "telegram:-100123:topic:x", "only numeric topic ids are stripped");
    assert.equal(canonicalConversationId("discord:chan:topic:7:extra"), "discord:chan:topic:7:extra", "only a trailing suffix is stripped");
    const command = routeFromCommandContext({ channel: "telegram", accountId: "bot1", to: "telegram:-100123", messageThreadId: 7 });
    const delivery = routeFromDeliveryContext({ channel: "telegram", accountId: "bot1", to: "telegram:-100123:topic:7", threadId: 7 });
    assert.deepEqual(delivery, { channel: "telegram", accountId: "bot1", conversationId: "telegram:-100123", threadId: "7" });
    assert.equal(routeKey(command!), routeKey(delivery!));
    assert.equal(routeFromDeliveryContext(undefined), null);
    assert.equal(routeFromDeliveryContext({ channel: "telegram" }), null);
    assert.equal(routeFromDeliveryContext({ to: "x" }), null);
    assert.deepEqual(routeFromDeliveryContext({ channel: "discord", to: "c1", threadId: null }), { channel: "discord", conversationId: "c1" });
  });

  it("produces the same key for native and text invocations of one chat", () => {
    const text = routeFromCommandContext({ channel: "discord", to: "chan-1", sessionKey: "agent:main:discord:channel:chan-1" });
    const native = routeFromCommandContext({ channel: "discord", to: "chan-1", sessionKey: "agent:main:discord:slash:user-1" });
    assert.equal(routeKey(text!), routeKey(native!));
  });
});

describe("BindStore", () => {
  it("persists bindings across instances and removes them", () => {
    withTempDir((root) => {
      const file = join(root, "state", "bindings.json");
      const store = new BindStore(file);
      assert.equal(store.get("k"), undefined);
      store.set("k", "/proj");
      assert.equal(new BindStore(file).get("k"), "/proj");
      assert.equal(new BindStore(file).delete("k"), true);
      assert.equal(new BindStore(file).get("k"), undefined);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    });
  });

  it("treats a corrupt file as empty", () => {
    withTempDir((root) => {
      const file = join(root, "bindings.json");
      writeFileSync(file, "{not json");
      const store = new BindStore(file);
      assert.equal(store.get("k"), undefined);
      store.set("k", "/proj");
      assert.equal(new BindStore(file).get("k"), "/proj");
    });
  });
});

describe("resolveProject", () => {
  it("resolves explicit → bind → default and fails closed", () => {
    withTempDir((root) => {
      const explicit = join(root, "explicit");
      const bound = join(root, "bound");
      const fallback = join(root, "fallback");
      for (const dir of [explicit, bound, fallback]) mkdirSync(join(dir, ".gsd"), { recursive: true });

      assert.deepEqual(resolveProject({ explicit, bound, defaultProject: fallback }), { ok: true, dir: explicit, source: "explicit" });
      assert.deepEqual(resolveProject({ bound, defaultProject: fallback }), { ok: true, dir: bound, source: "bind" });
      assert.deepEqual(resolveProject({ defaultProject: fallback }), { ok: true, dir: fallback, source: "default" });
      assert.deepEqual(resolveProject({}), { ok: false, error: NO_PROJECT_MESSAGE });
    });
  });

  it("rejects relative paths and non-projects, naming the source", () => {
    withTempDir((root) => {
      assert.match((validateProjectPath("relative/path") as { error: string }).error, /must be absolute/);
      assert.match((validateProjectPath(root) as { error: string }).error, /not a GSD project/);
      const viaBind = resolveProject({ bound: root });
      assert.equal(viaBind.ok, false);
      assert.match((viaBind as { error: string }).error, /from \/gsd bind/);
      const viaDefault = resolveProject({ defaultProject: root });
      assert.match((viaDefault as { error: string }).error, /from defaultProject/);
    });
  });
});
