import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  CloudProjectRecord,
  GatewayToRuntimeMessage,
  RuntimeProject,
  RuntimeToGatewayMessage,
} from "./protocol.js";
import { isRecord } from "./protocol.js";

interface RuntimeConnection {
  runtimeId: string;
  userId: string;
  runtimeName?: string;
  socket: WebSocket;
  projects: RuntimeProject[];
  lastSeenAt: number;
}

interface PendingCall {
  runtimeId: string;
  toolName: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Detaches the abort listener from the caller's signal on resolution. */
  removeAbortListener: () => void;
}

export interface GatewayToolCall {
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeConnection>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly projectQueues = new Map<string, Promise<unknown>>();

  attachRuntime(params: {
    userId: string;
    runtimeId: string;
    runtimeName?: string;
    socket: WebSocket;
  }): void {
    const existing = this.runtimes.get(params.runtimeId);
    if (existing && existing.socket !== params.socket) {
      this.failPendingForRuntime(params.runtimeId, `Local GSD Runtime disconnected: ${params.runtimeId}`);
      existing.socket.close(4000, "replaced");
    }

    const runtime: RuntimeConnection = {
      userId: params.userId,
      runtimeId: params.runtimeId,
      runtimeName: params.runtimeName,
      socket: params.socket,
      projects: [],
      lastSeenAt: Date.now(),
    };
    this.runtimes.set(params.runtimeId, runtime);

    params.socket.on("message", (data) => {
      this.handleMessage(params.runtimeId, data.toString("utf8"));
    });
    params.socket.on("close", () => {
      if (this.runtimes.get(params.runtimeId)?.socket === params.socket) {
        this.runtimes.delete(params.runtimeId);
        this.failPendingForRuntime(params.runtimeId, `Local GSD Runtime disconnected: ${params.runtimeId}`);
      }
    });
  }

  listProjects(userId: string): CloudProjectRecord[] {
    const rows: CloudProjectRecord[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.userId !== userId) continue;
      for (const project of runtime.projects) {
        rows.push({
          ...project,
          runtimeId: runtime.runtimeId,
          runtimeName: runtime.runtimeName,
          online: true,
          lastSeenAt: runtime.lastSeenAt,
        });
      }
    }
    return rows.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async callTool(call: GatewayToolCall): Promise<unknown> {
    const target = this.resolveTarget(call.userId, call.args);
    const projectKey = `${target.runtime.runtimeId}:${target.projectAlias ?? "__runtime__"}`;
    const prior = this.projectQueues.get(projectKey) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.forwardToolCall(target.runtime, {
      ...call,
      args: target.args,
    }, target.projectAlias));
    const cleanup = run.catch(() => undefined).finally(() => {
      if (this.projectQueues.get(projectKey) === run) this.projectQueues.delete(projectKey);
      if (this.projectQueues.get(projectKey) === cleanup) this.projectQueues.delete(projectKey);
    });
    this.projectQueues.set(projectKey, cleanup);
    return run;
  }

  private resolveTarget(userId: string, rawArgs: Record<string, unknown>): {
    runtime: RuntimeConnection;
    projectAlias?: string;
    args: Record<string, unknown>;
  } {
    const args = { ...rawArgs };
    const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : undefined;
    const projectAlias = typeof args.projectAlias === "string"
      ? args.projectAlias
      : typeof args.projectDir === "string"
        ? args.projectDir
        : undefined;
    delete args.runtimeId;
    delete args.projectAlias;

    const candidates = Array.from(this.runtimes.values()).filter((runtime) => runtime.userId === userId);
    if (runtimeId) {
      const runtime = candidates.find((candidate) => candidate.runtimeId === runtimeId);
      if (!runtime) throw new Error(`Local GSD Runtime is offline: ${runtimeId}`);
      return { runtime, projectAlias, args };
    }

    if (projectAlias) {
      const matches = candidates.filter((runtime) =>
        runtime.projects.some((project) => project.alias === projectAlias || project.path === projectAlias),
      );
      if (matches.length === 1) return { runtime: matches[0]!, projectAlias, args };
      if (matches.length > 1) throw new Error(`Project alias is ambiguous: ${projectAlias}`);
    }

    if (candidates.length === 1) return { runtime: candidates[0]!, projectAlias, args };
    if (candidates.length === 0) throw new Error("No Local GSD Runtime is connected");
    throw new Error("runtimeId or projectAlias is required when multiple Local GSD Runtimes are connected");
  }

  private forwardToolCall(
    runtime: RuntimeConnection,
    call: GatewayToolCall,
    projectAlias?: string,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const payload: GatewayToRuntimeMessage = {
      type: "tool_call",
      requestId,
      toolName: call.toolName,
      args: call.args,
      projectAlias,
    };

    return new Promise((resolve, reject) => {
      // Removes the abort listener so a long-lived signal reused across many
      // calls doesn't retain a listener per resolved call.
      const removeAbortListener = () => {
        call.signal?.removeEventListener("abort", abort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        removeAbortListener();
        reject(new Error(`Timed out waiting for Local GSD Runtime response to ${call.toolName}`));
      }, 10 * 60 * 1000);

      const abort = () => {
        this.send(runtime, { type: "cancel", requestId });
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`${call.toolName} cancelled by client`));
      };
      this.pending.set(requestId, {
        runtimeId: runtime.runtimeId,
        toolName: call.toolName,
        resolve,
        reject,
        timer,
        removeAbortListener,
      });

      if (call.signal?.aborted) return abort();
      call.signal?.addEventListener("abort", abort, { once: true });

      try {
        this.send(runtime, payload);
      } catch (err) {
        removeAbortListener();
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleMessage(runtimeId: string, text: string): void {
    let message: RuntimeToGatewayMessage;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || typeof parsed.type !== "string") return;
      message = parsed as unknown as RuntimeToGatewayMessage;
    } catch {
      return;
    }

    const runtime = this.runtimes.get(runtimeId);
    if (runtime) runtime.lastSeenAt = Date.now();

    if (message.type === "hello" && runtime) {
      runtime.runtimeName = message.runtimeName ?? runtime.runtimeName;
      runtime.projects = message.projects;
      return;
    }
    if (message.type === "projects" && runtime) {
      runtime.projects = message.projects;
      return;
    }
    if (message.type === "tool_result") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }

  private send(runtime: RuntimeConnection, message: GatewayToRuntimeMessage): void {
    if (runtime.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Local GSD Runtime is offline: ${runtime.runtimeId}`);
    }
    runtime.socket.send(JSON.stringify(message));
  }

  private failPendingForRuntime(runtimeId: string, message: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.runtimeId !== runtimeId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(new Error(`${message} while waiting for ${pending.toolName}`));
    }
  }
}
