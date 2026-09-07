/**
 * Delivery of supervisor events to the chat that started the run.
 *
 * Direct channel send through the host's outbound adapter; when the channel
 * has none (WebChat, the CLI) or declines, the text is queued as a
 * session-scoped system event and the session's heartbeat is woken so the
 * agent relays it. Sends are serialized per route so progress stays ordered.
 */

import { routeKey, type Route } from "./binding.js";
import { errorMessage } from "./redact.js";
import type { DeliveryContext, OpenClawPluginApi, PluginLogger } from "./types.js";

const MAX_TEXT_CHARS = 4000;

export interface NotifyTarget {
  route: Route;
  sessionKey?: string;
  runId: string;
}

export class Notifier {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly logger: PluginLogger,
  ) {}

  send(target: NotifyTarget, text: string): void {
    const key = routeKey(target.route);
    const capped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.deliver(target, capped))
      .catch((error: unknown) => this.logger.warn(`notification to ${key} failed: ${errorMessage(error)}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async deliver(target: NotifyTarget, text: string): Promise<void> {
    const { route, sessionKey, runId } = target;
    const key = routeKey(route);
    try {
      const adapter = await this.api.runtime?.channel?.outbound?.loadAdapter?.(route.channel);
      if (adapter?.sendText) {
        const cfg = this.api.runtime?.config?.current?.() ?? this.api.config;
        const result = await adapter.sendText({
          cfg,
          to: route.conversationId,
          text,
          accountId: route.accountId ?? null,
          threadId: route.threadId ?? null,
        });
        if (result?.outcome !== "not_sent") return;
        this.logger.debug(`channel ${route.channel} declined a notification for ${key}; falling back to a session event`);
      }
    } catch (error) {
      this.logger.warn(`direct send to ${key} failed: ${errorMessage(error)}; falling back to a session event`);
    }
    const system = this.api.runtime?.system;
    if (sessionKey && system?.enqueueSystemEvent) {
      const deliveryContext: DeliveryContext = {
        channel: route.channel,
        to: route.conversationId,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(route.threadId ? { threadId: route.threadId } : {}),
      };
      system.enqueueSystemEvent(text, { sessionKey, contextKey: `open-gsd-openclaw:${runId}`, deliveryContext });
      // A wake without sessionKey targets the global heartbeat, not this session.
      system.requestHeartbeat?.({ source: "other", intent: "event", reason: "open-gsd-openclaw", sessionKey });
      return;
    }
    this.logger.warn(`GSD notification for ${key} (run ${runId}) undelivered: no outbound adapter and no session; text: ${text.slice(0, 200)}`);
  }
}
