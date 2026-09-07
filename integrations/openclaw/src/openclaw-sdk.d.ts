/**
 * Ambient declaration for the OpenClaw plugin SDK subset this plugin uses.
 *
 * OpenClaw resolves `openclaw/plugin-sdk/*` at runtime: for npm installs the
 * installer links the host package into the plugin's module graph, and for a
 * linked source checkout the host loads the TypeScript entry with its own SDK
 * alias map. The host is therefore never a build-time dependency of gsd-pi.
 * This file mirrors only the members the plugin touches; the shapes follow
 * `src/plugins/plugin-command.types.ts`, `plugin-registration.types.ts`,
 * `plugin-api.types.ts`, `tool-types.ts`, `host-hooks.ts`, and the outbound and
 * system-event runtime types in openclaw/openclaw. Behaviour is verified against the real host by the
 * `openclaw plugins inspect --runtime` check documented in the README.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    senderIsOwner?: boolean;
    gatewayClientScopes?: string[];
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    args?: string;
    commandBody: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
    threadParentId?: string;
  }

  export interface PluginCommandResult {
    text?: string;
    continueAgent?: boolean;
    suppressReply?: boolean;
  }

  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    requiredScopes?: string[];
    agentPromptGuidance?: string[];
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }

  export interface OpenClawPluginServiceContext {
    config: unknown;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
  }

  export interface OpenClawPluginService {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  }

  /** `src/utils/delivery-context.types.ts` */
  export interface DeliveryContext {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number | null;
  }

  /** `src/plugins/tool-types.ts` (subset) */
  export interface OpenClawPluginToolContext {
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
    messageChannel?: string;
    deliveryContext?: DeliveryContext;
  }

  /** `packages/pi-agent-core/src/types.ts` `AgentToolResult` */
  export interface AgentToolResult {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }

  /** `src/agents/tools/common.ts` `AnyAgentTool`; `parameters` is consumed as JSON Schema. */
  export interface AnyAgentTool {
    label: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown): Promise<AgentToolResult>;
  }

  export type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  export interface OpenClawPluginToolOptions {
    name?: string;
    names?: string[];
    optional?: boolean;
  }

  /** `src/infra/outbound/deliver-types.ts` (subset); `outcome: "not_sent"` means the provider declined. */
  export interface OutboundDeliveryResult {
    outcome?: string;
    messageId?: string;
  }

  /** `src/channels/plugins/outbound.types.ts` `ChannelOutboundContext` (subset) */
  export interface ChannelOutboundContext {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string | null;
    threadId?: string | number | null;
  }

  export interface ChannelOutboundAdapter {
    sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  }

  /** `src/plugins/host-hooks.ts` `PluginRuntimeLifecycleRegistration` */
  export interface PluginRuntimeLifecycleRegistration {
    id: string;
    description?: string;
    cleanup?: (ctx: { reason: "disable" | "reset" | "delete" | "restart"; sessionKey?: string; runId?: string }) => void | Promise<void>;
  }

  /** `src/plugins/runtime/types.ts` `PluginRuntime` (subset); every member is optional here because the PR1 test stub omits them. */
  export interface PluginRuntime {
    config?: { current?: () => unknown };
    channel?: { outbound?: { loadAdapter?: (channelId: string) => Promise<ChannelOutboundAdapter | undefined> } };
    system?: {
      enqueueSystemEvent?: (
        text: string,
        opts: { sessionKey: string; contextKey?: string | null; deliveryContext?: DeliveryContext },
      ) => boolean;
      requestHeartbeat?: (request: { source: string; intent: string; reason?: string; sessionKey?: string; agentId?: string }) => unknown;
    };
  }

  export interface OpenClawPluginApi {
    id: string;
    name: string;
    pluginConfig?: Record<string, unknown>;
    /** Registration-time config snapshot; prefer `runtime.config.current()` for live values. */
    config?: unknown;
    logger: PluginLogger;
    registrationMode?: string;
    runtime?: PluginRuntime;
    lifecycle?: { registerRuntimeLifecycle?: (registration: PluginRuntimeLifecycleRegistration) => void };
    registerCommand(definition: OpenClawPluginCommandDefinition): void;
    registerService(service: OpenClawPluginService): void;
    registerTool?: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?: OpenClawPluginToolOptions) => void;
  }

  export interface OpenClawPluginEntry {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry(entry: OpenClawPluginEntry): OpenClawPluginEntry;
}
