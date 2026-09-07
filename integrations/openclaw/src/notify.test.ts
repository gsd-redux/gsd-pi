import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "./notify.js";
import type { ChannelOutboundAdapter, ChannelOutboundContext, OpenClawPluginApi, OutboundDeliveryResult } from "./types.js";

const target = { route: { channel: "telegram", accountId: "bot1", conversationId: "telegram:1", threadId: "7" }, sessionKey: "agent:main:telegram:1", runId: "gsd-9" };

function stubApi(adapter: ChannelOutboundAdapter | undefined) {
  const sends: ChannelOutboundContext[] = [];
  const events: Array<{ text: string; opts: unknown }> = [];
  const wakes: unknown[] = [];
  const warns: string[] = [];
  const api: OpenClawPluginApi = {
    id: "open-gsd-openclaw",
    name: "Open GSD",
    logger: { debug() {}, info() {}, warn: (m) => void warns.push(m), error() {} },
    config: { snapshot: true },
    runtime: {
      config: { current: () => ({ live: true }) },
      channel: { outbound: { loadAdapter: async () => adapter } },
      system: {
        enqueueSystemEvent: (text, opts) => {
          events.push({ text, opts });
          return true;
        },
        requestHeartbeat: (request) => void wakes.push(request),
      },
    },
    registerCommand() {},
    registerService() {},
  };
  return { api, sends, events, wakes, warns };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function recordingAdapter(sends: ChannelOutboundContext[], result: OutboundDeliveryResult | Error = { messageId: "m1" }): ChannelOutboundAdapter {
  return {
    async sendText(ctx) {
      sends.push(ctx);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("Notifier", () => {
  it("sends through the channel adapter with the live config and route fields", async () => {
    const stub = stubApi(undefined);
    stub.api.runtime!.channel!.outbound!.loadAdapter = async () => recordingAdapter(stub.sends);
    new Notifier(stub.api, stub.api.logger).send(target, "hello");
    await flush();
    assert.deepEqual(stub.sends, [{ cfg: { live: true }, to: "telegram:1", text: "hello", accountId: "bot1", threadId: "7" }]);
    assert.deepEqual(stub.events, []);
    assert.deepEqual(stub.warns, []);
  });

  it("falls back to a session event when the provider declines or throws", async () => {
    for (const result of [{ outcome: "not_sent" } as OutboundDeliveryResult, new Error("rate limited")]) {
      const stub = stubApi(undefined);
      stub.api.runtime!.channel!.outbound!.loadAdapter = async () => recordingAdapter(stub.sends, result);
      new Notifier(stub.api, stub.api.logger).send(target, "hello");
      await flush();
      assert.equal(stub.sends.length, 1);
      assert.deepEqual(stub.events, [
        {
          text: "hello",
          opts: {
            sessionKey: "agent:main:telegram:1",
            contextKey: "open-gsd-openclaw:gsd-9",
            deliveryContext: { channel: "telegram", to: "telegram:1", accountId: "bot1", threadId: "7" },
          },
        },
      ]);
      assert.deepEqual(stub.wakes, [{ source: "other", intent: "event", reason: "open-gsd-openclaw", sessionKey: "agent:main:telegram:1" }]);
    }
  });

  it("uses the session event and a session-scoped wake when the channel has no adapter", async () => {
    const stub = stubApi(undefined);
    new Notifier(stub.api, stub.api.logger).send({ ...target, route: { channel: "webchat", conversationId: "agent:main:main" } }, "hello");
    await flush();
    assert.equal(stub.events.length, 1);
    assert.deepEqual((stub.events[0].opts as { deliveryContext: unknown }).deliveryContext, { channel: "webchat", to: "agent:main:main" });
    assert.equal((stub.wakes[0] as { sessionKey: string }).sessionKey, "agent:main:telegram:1");
  });

  it("only warns when there is neither an adapter nor a session key", async () => {
    const stub = stubApi(undefined);
    new Notifier(stub.api, stub.api.logger).send({ ...target, sessionKey: undefined }, "hello");
    await flush();
    assert.deepEqual(stub.events, []);
    assert.deepEqual(stub.wakes, []);
    assert.equal(stub.warns.length, 1);
    assert.match(stub.warns[0], /telegram\|bot1\|telegram:1\|7 \(run gsd-9\) undelivered/);
  });

  it("copes with a stub api that has no runtime at all", async () => {
    const stub = stubApi(undefined);
    delete stub.api.runtime;
    delete stub.api.config;
    new Notifier(stub.api, stub.api.logger).send(target, "hello");
    await flush();
    assert.equal(stub.warns.length, 1);
  });

  it("serializes sends per route and caps the text", async () => {
    const stub = stubApi(undefined);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    stub.api.runtime!.channel!.outbound!.loadAdapter = async () => ({
      async sendText(ctx) {
        stub.sends.push(ctx);
        if (stub.sends.length === 1) await gate;
        return { messageId: String(stub.sends.length) };
      },
    });
    const notifier = new Notifier(stub.api, stub.api.logger);
    notifier.send(target, "x".repeat(5000));
    notifier.send(target, "second");
    notifier.send({ ...target, route: { channel: "discord", conversationId: "c" } }, "other route");
    await flush();
    assert.deepEqual(stub.sends.map((s) => s.text.length), [4000, 11], "the second telegram send waits; the discord send does not");
    release();
    await flush();
    assert.deepEqual(stub.sends.map((s) => s.text), ["x".repeat(3999) + "…", "other route", "second"]);
  });
});
