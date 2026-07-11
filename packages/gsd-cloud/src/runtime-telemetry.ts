// Project/App: Open GSD
// File Purpose: Persist token-free cloud runtime status and traffic counters for local monitors.
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AdvertisedProject } from "./executors/executor.js";
import { runtimeArtifactPath } from "./runtime-artifacts.js";

export type RuntimeConnectionState = "connecting" | "connected" | "reconnecting" | "error" | "stopped";
export type RuntimeProjectState = "idle" | "active" | "error";
export type RuntimeRequestOutcome = "success" | "error" | "cancelled";

export interface RuntimeProjectTelemetry {
  alias: string;
  path: string;
  repo_identity: string;
  remote_label?: string;
  state: RuntimeProjectState;
  active_requests: number;
  active_tools: string[];
  request_count: number;
  error_count: number;
  received_bytes: number;
  sent_bytes: number;
  last_tool: string | null;
  last_activity_at: string | null;
}

export interface RuntimeActivityTelemetry {
  request_id: string;
  project_alias?: string;
  project_path?: string;
  tool_name: string;
  outcome: RuntimeRequestOutcome;
  duration_ms: number;
  at: string;
  error?: string;
}

export interface RuntimeTelemetryStatus {
  version: 1;
  pid: number;
  state: RuntimeConnectionState;
  gateway_url: string;
  runtime_id?: string;
  runtime_name?: string;
  started_at: string;
  connected_at: string | null;
  updated_at: string;
  last_error: string | null;
  connection_attempts: number;
  reconnects: number;
  received_messages: number;
  sent_messages: number;
  received_bytes: number;
  sent_bytes: number;
  active_requests: number;
  projects: RuntimeProjectTelemetry[];
  recent_activity: RuntimeActivityTelemetry[];
}

export interface RuntimeRequestStarted {
  requestId: string;
  projectAlias?: string;
  projectPath?: string;
  toolName: string;
  receivedBytes: number;
}

export interface RuntimeRequestFinished {
  requestId: string;
  projectAlias?: string;
  projectPath?: string;
  toolName: string;
  durationMs: number;
  outcome: RuntimeRequestOutcome;
  error?: string;
}

export interface RuntimeTelemetryReporter {
  connecting(): void;
  connected(): void;
  disconnected(error?: string): void;
  socketError(error: string): void;
  received(text: string): void;
  sent(text: string, projectPath?: string): void;
  projectsAdvertised(projects: AdvertisedProject[]): void;
  requestStarted(request: RuntimeRequestStarted): void;
  requestFinished(request: RuntimeRequestFinished): void;
  stopped(): void;
  failed?(): void;
  flush?(): Promise<void>;
}

interface RuntimeTelemetryMetadata {
  gatewayUrl: string;
  runtimeId?: string;
  runtimeName?: string;
}

export const noopRuntimeTelemetry: RuntimeTelemetryReporter = {
  connecting(): void {},
  connected(): void {},
  disconnected(): void {},
  socketError(): void {},
  received(): void {},
  sent(): void {},
  projectsAdvertised(): void {},
  requestStarted(): void {},
  requestFinished(): void {},
  stopped(): void {},
  failed(): void {},
};

export class RuntimeTelemetryStore implements RuntimeTelemetryReporter {
  private readonly path: string;
  private readonly activeRequests = new Map<string, { projectPath: string; toolName: string }>();
  private status: RuntimeTelemetryStatus;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistPromise = Promise.resolve();

  constructor(configPath: string, metadata: RuntimeTelemetryMetadata) {
    const now = new Date().toISOString();
    this.path = runtimeTelemetryPath(configPath);
    this.status = {
      version: 1,
      pid: process.pid,
      state: "connecting",
      gateway_url: credentialFreeGatewayLabel(metadata.gatewayUrl),
      ...(metadata.runtimeId ? { runtime_id: metadata.runtimeId } : {}),
      ...(metadata.runtimeName ? { runtime_name: metadata.runtimeName } : {}),
      started_at: now,
      connected_at: null,
      updated_at: now,
      last_error: null,
      connection_attempts: 0,
      reconnects: 0,
      received_messages: 0,
      sent_messages: 0,
      received_bytes: 0,
      sent_bytes: 0,
      active_requests: 0,
      projects: [],
      recent_activity: [],
    };
  }

  connecting(): void {
    if (!this.livenessTimer) {
      this.livenessTimer = setInterval(() => this.persist(), 1_000);
      this.livenessTimer.unref();
    }
    this.status.state = this.status.connection_attempts === 0 ? "connecting" : "reconnecting";
    this.status.connection_attempts += 1;
    this.persist();
  }

  connected(): void {
    this.status.state = "connected";
    this.status.connected_at = new Date().toISOString();
    this.status.last_error = null;
    this.persist();
  }

  disconnected(error?: string): void {
    if (this.status.connected_at && this.status.state !== "reconnecting") {
      this.status.reconnects += 1;
    }
    this.status.state = "reconnecting";
    this.status.last_error = error ?? this.status.last_error ?? "connection closed";
    this.persist();
  }

  socketError(error: string): void {
    this.status.state = "error";
    this.status.last_error = error;
    this.persist();
  }

  received(text: string): void {
    this.status.received_messages += 1;
    this.status.received_bytes += Buffer.byteLength(text);
    this.persist();
  }

  sent(text: string, projectPath?: string): void {
    this.status.sent_messages += 1;
    const bytes = Buffer.byteLength(text);
    this.status.sent_bytes += bytes;
    const project = projectPath ? this.findProject(projectPath) : undefined;
    if (project) project.sent_bytes += bytes;
    this.persist();
  }

  projectsAdvertised(projects: AdvertisedProject[]): void {
    const existingProjects = new Map(
      this.status.projects.map((project) => [project.path, project]),
    );
    this.status.projects = projects.map((project) => {
      const existing = existingProjects.get(project.path);
      const remoteLabel = project.remoteLabel
        ? credentialFreeRemoteLabel(project.remoteLabel)
        : undefined;
      return {
        alias: project.alias,
        path: project.path,
        repo_identity: project.repoIdentity,
        ...(remoteLabel ? { remote_label: remoteLabel } : {}),
        state: existing?.state ?? "idle",
        active_requests: existing?.active_requests ?? 0,
        active_tools: existing?.active_tools ?? [],
        request_count: existing?.request_count ?? 0,
        error_count: existing?.error_count ?? 0,
        received_bytes: existing?.received_bytes ?? 0,
        sent_bytes: existing?.sent_bytes ?? 0,
        last_tool: existing?.last_tool ?? null,
        last_activity_at: existing?.last_activity_at ?? null,
      };
    });
    this.persist();
  }

  requestStarted(request: RuntimeRequestStarted): void {
    this.status.active_requests += 1;
    const project = this.findProject(request.projectPath, request.projectAlias);
    if (project) {
      this.activeRequests.set(request.requestId, {
        projectPath: project.path,
        toolName: request.toolName,
      });
      project.state = "active";
      project.active_requests += 1;
      project.active_tools = this.activeToolsForProject(project.path);
      project.received_bytes += request.receivedBytes;
      project.last_tool = request.toolName;
      project.last_activity_at = new Date().toISOString();
    }
    this.persist();
  }

  requestFinished(request: RuntimeRequestFinished): void {
    this.status.active_requests = Math.max(0, this.status.active_requests - 1);
    const now = new Date().toISOString();
    const project = this.findProject(request.projectPath, request.projectAlias);
    this.activeRequests.delete(request.requestId);
    if (project) {
      project.active_requests = Math.max(0, project.active_requests - 1);
      project.active_tools = this.activeToolsForProject(project.path);
      project.request_count += 1;
      project.last_tool = request.toolName;
      project.last_activity_at = now;
      if (request.outcome === "error") project.error_count += 1;
      if (request.outcome === "error") {
        project.state = "error";
      } else if (project.active_requests > 0) {
        project.state = "active";
      } else {
        project.state = "idle";
      }
    }
    this.status.recent_activity.push({
      request_id: request.requestId,
      ...(request.projectAlias ? { project_alias: request.projectAlias } : {}),
      ...(request.projectPath ? { project_path: request.projectPath } : {}),
      tool_name: request.toolName,
      outcome: request.outcome,
      duration_ms: request.durationMs,
      at: now,
      ...(request.error ? { error: request.error } : {}),
    });
    if (this.status.recent_activity.length > 50) {
      this.status.recent_activity.splice(0, this.status.recent_activity.length - 50);
    }
    this.persist();
  }

  stopped(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
    this.status.state = "stopped";
    this.status.active_requests = 0;
    this.activeRequests.clear();
    for (const project of this.status.projects) {
      project.active_requests = 0;
      project.active_tools = [];
      project.state = "idle";
    }
    void this.flush();
  }

  failed(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.enqueuePersist();
    await this.persistPromise;
  }

  private findProject(path?: string, alias?: string): RuntimeProjectTelemetry | undefined {
    if (path) return this.status.projects.find((project) => project.path === path);
    if (alias) return this.status.projects.find((project) => project.alias === alias);
    if (this.status.projects.length === 1) return this.status.projects[0];
    return undefined;
  }

  private activeToolsForProject(projectPath: string): string[] {
    return [...this.activeRequests.values()]
      .filter((request) => request.projectPath === projectPath)
      .map((request) => request.toolName);
  }

  private persist(): void {
    this.status.updated_at = new Date().toISOString();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.enqueuePersist();
    }, 25);
    this.persistTimer.unref();
  }

  private enqueuePersist(): void {
    this.status.updated_at = new Date().toISOString();
    const snapshot = `${JSON.stringify(this.status, null, 2)}\n`;
    this.persistPromise = this.persistPromise.then(() => this.writeSnapshot(snapshot));
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function readRuntimeTelemetry(configPath: string): RuntimeTelemetryStatus | null {
  try {
    const value = JSON.parse(readFileSync(runtimeTelemetryPath(configPath), "utf8")) as RuntimeTelemetryStatus;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

export function runtimeTelemetryPath(configPath: string): string {
  return runtimeArtifactPath(configPath, "status");
}

export function clearRuntimeTelemetry(configPath: string): void {
  try {
    unlinkSync(runtimeTelemetryPath(configPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function credentialFreeRemoteLabel(remoteLabel: string): string {
  try {
    const url = new URL(remoteLabel);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return remoteLabel
      .replace(/^[^/@]+@([^:]+):/, "$1:")
      .replace(/[?#].*$/, "");
  }
}

function credentialFreeGatewayLabel(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid gateway";
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "invalid gateway";
  }
}
