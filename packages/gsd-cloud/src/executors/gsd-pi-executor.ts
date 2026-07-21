// Project/App: Open GSD
// File Purpose: Executor adapter that drives the installed `gsd` CLI headlessly.
//
// MECHANISM
// ---------
// The workflow tool surface (gsd_execute, gsd_status, gsd_graph, gsd_cancel,
// gsd_query, …) is owned by the workflow MCP server (@opengsd/mcp-server,
// shipped inside the gsd-pi package at packages/mcp-server/dist/cli.js). This
// adapter spawns ONE long-lived workflow-server child per project and issues
// `tools/call` requests for each `execute()` — the same gsd_* tool names the
// cloud gateway forwards. No GSD package is linked; the only contract is the
// MCP wire protocol.
//
// NOTE: as of gsd-pi 1.11.0, `gsd --mode mcp` is NOT a valid child for this
// executor — its session registry does not include the workflow adapter tools,
// so every call fails with "Unknown tool" (issue #1513). This is a current
// behavioral limitation, not a permanent contract: if `--mode mcp` is fixed to
// register the workflow surface, it may become a viable child. Discovery of the
// correct server lives in workflow-server-launch.ts.
//
// DOCUMENTED GAPS (see report):
//  1. Project discovery. The daemon's LocalToolExecutor scanned filesystem roots
//     via a dedicated ProjectScanner. This standalone package has no scanner, so
//     it advertises an EXPLICIT project list from `GSD_CLOUD_PROJECTS` (a
//     path-list separated by the OS path delimiter) or, if unset, the current
//     working directory. Each advertised project's `repoIdentity` is computed
//     exactly as the daemon did (sha256 of the git origin remote, else
//     basename:path), so gateway-side identity matching is preserved.
//  2. One MCP server per project. The workflow server is project-scoped via
//     cwd + GSD_WORKFLOW_PROJECT_ROOT, and every `tools/call` also carries the
//     resolved `projectDir`. A `tool_call` carrying a `projectAlias` is routed
//     to that project's dedicated child. Tool args are forwarded verbatim
//     otherwise.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import type { Logger } from "../logger.js";
import type { AdvertisedProject, Executor } from "./executor.js";
import { McpStdioClient } from "./mcp-stdio-client.js";
import { resolveWorkflowServerLaunch, type WorkflowServerLaunch } from "./workflow-server-launch.js";

export interface GsdPiExecutorOptions {
  /**
   * Path to the `gsd` binary, used as the discovery anchor for the workflow
   * MCP server (see workflow-server-launch.ts). Defaults to GSD_CLI_PATH env,
   * else `gsd` on PATH.
   */
  gsdBinary?: string;
  /**
   * Explicit list of project directories to advertise. Defaults to
   * GSD_CLOUD_PROJECTS (path-delimiter separated), else [cwd].
   */
  projectDirs?: string[];
}

interface ProjectEntry {
  alias: string;
  path: string;
  client: McpStdioClient;
}

export class GsdPiExecutor implements Executor {
  private readonly gsdBinary: string;
  private readonly projectDirs: string[];
  /** Lazily-created MCP clients, keyed by resolved absolute project path. */
  private readonly projects = new Map<string, ProjectEntry>();
  /** In-flight project client creation, keyed by resolved absolute project path. */
  private readonly projectInit = new Map<string, Promise<ProjectEntry>>();
  /**
   * Cached workflow-server launch config. Discovery is host-level (anchored on
   * gsdBinary, not the project), so it is resolved once per executor rather than
   * per advertised project. `undefined` = not yet resolved; `null` = resolved to
   * "no server found". The synchronous which/where lookup runs at most once.
   */
  private workflowLaunch: WorkflowServerLaunch | null | undefined;

  constructor(private readonly logger: Logger, opts: GsdPiExecutorOptions = {}) {
    this.gsdBinary = opts.gsdBinary
      ?? process.env["GSD_CLI_PATH"]
      ?? "gsd";
    this.projectDirs = (opts.projectDirs ?? defaultProjectDirs()).map((p) => resolve(p));
    this.warnDuplicateAliases();
  }

  /**
   * Advertised aliases are directory basenames, so two projects that share a
   * folder name collide. Warn up front — such an alias can only be routed by an
   * absolute `projectDir` (see resolveProjectPath).
   */
  private warnDuplicateAliases(): void {
    const counts = new Map<string, number>();
    for (const p of this.projectDirs) {
      const alias = basename(p);
      counts.set(alias, (counts.get(alias) ?? 0) + 1);
    }
    for (const [alias, count] of counts) {
      if (count > 1) {
        this.logger.warn("duplicate project alias advertised; route by absolute projectDir", {
          alias,
          count,
        });
      }
    }
  }

  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    projectAlias?: string,
    requestId?: string,
  ): Promise<unknown> {
    const routingKey = projectAlias
      ?? (typeof rawArgs.projectDir === "string" ? rawArgs.projectDir : undefined)
      ?? (typeof rawArgs.projectAlias === "string" ? rawArgs.projectAlias : undefined);
    const entry = await this.resolveProject(routingKey);
    const { projectAlias: _pa, ...args } = rawArgs;
    void _pa;
    return entry.client.callTool(
      toolName,
      { ...args, projectDir: entry.path },
      requestId ? { "io.opengsd/idempotency-key": requestId } : undefined,
    );
  }

  async advertisedProjects(): Promise<AdvertisedProject[]> {
    return this.projectDirs.map((path) => {
      const remoteLabel = gitRemote(path);
      return {
        alias: basename(path),
        path,
        repoIdentity: identityFor(path, remoteLabel),
        ...(remoteLabel ? { remoteLabel } : {}),
        markers: detectMarkers(path),
      };
    });
  }

  async close(): Promise<void> {
    for (const entry of this.projects.values()) entry.client.close();
    this.projects.clear();
  }

  private async resolveProject(aliasOrPath?: string): Promise<ProjectEntry> {
    const path = this.resolveProjectPath(aliasOrPath);
    const existing = this.projects.get(path);
    if (existing) return existing;

    let init = this.projectInit.get(path);
    if (!init) {
      init = this.createProjectEntry(path);
      this.projectInit.set(path, init);
      void init.finally(() => this.projectInit.delete(path));
    }
    return init;
  }

  private async createProjectEntry(path: string): Promise<ProjectEntry> {
    const existing = this.projects.get(path);
    if (existing) return existing;
    // The child must be the workflow MCP server — `gsd --mode mcp` does not
    // register the workflow adapter surface (gsd_status, gsd_roadmap, …), so
    // every call against it fails with "Unknown tool" (issue #1513). Spawn in
    // the project directory and pin the workflow root explicitly.
    const launch = this.resolveWorkflowLaunch();
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GSD_PROJECT_ROOT: path,
      GSD_WORKFLOW_PROJECT_ROOT: path,
    };
    // The workflow server resolves the GSD CLI via GSD_CLI_PATH (else `gsd` on
    // PATH). When this executor was configured with a concrete binary path,
    // propagate it so tool execution still works on hosts where `gsd` is not on
    // PATH. A bare name (e.g. "gsd") is left to normal PATH resolution.
    if (this.gsdBinary.includes("/") || this.gsdBinary.includes("\\")) {
      childEnv.GSD_CLI_PATH = this.gsdBinary;
    }
    const client = new McpStdioClient(
      launch.command,
      launch.args,
      this.logger,
      { env: childEnv, cwd: path },
    );
    const entry: ProjectEntry = { alias: basename(path), path, client };
    this.projects.set(path, entry);
    return entry;
  }

  /**
   * Resolve (and memoize) the workflow-server launch config. Discovery is
   * host-level, so the synchronous which/where lookup runs once per executor
   * instead of once per advertised project.
   */
  private resolveWorkflowLaunch(): WorkflowServerLaunch {
    if (this.workflowLaunch === undefined) {
      this.workflowLaunch = resolveWorkflowServerLaunch({ gsdBinary: this.gsdBinary });
    }
    if (!this.workflowLaunch) {
      throw new Error(
        "Cannot locate the GSD workflow MCP server. Set GSD_WORKFLOW_MCP_COMMAND, " +
          "install @opengsd/gsd-pi (ships packages/mcp-server/dist/cli.js), " +
          "or put gsd-mcp-server on PATH.",
      );
    }
    return this.workflowLaunch;
  }

  private resolveProjectPath(aliasOrPath?: string): string {
    if (!aliasOrPath) {
      if (this.projectDirs.length === 0) {
        throw new Error("No project advertised by the standalone GSD runtime");
      }
      if (this.projectDirs.length > 1) {
        throw new Error(
          "Project routing is ambiguous: multiple projects are advertised — projectDir or projectAlias is required",
        );
      }
      return this.projectDirs[0]!;
    }
    const resolved = resolve(aliasOrPath);
    // Prefer an exact absolute-path match — always unambiguous.
    const exact = this.projectDirs.find((p) => p === resolved);
    if (exact) return exact;
    // Otherwise match by advertised alias (basename). If more than one advertised
    // directory shares that basename the alias is ambiguous, so fail loudly rather
    // than silently routing work to whichever entry happens to come first.
    const byBasename = this.projectDirs.filter((p) => basename(p) === aliasOrPath);
    if (byBasename.length > 1) {
      throw new Error(`Project alias is ambiguous: ${aliasOrPath}`);
    }
    if (byBasename.length === 1) return byBasename[0]!;
    throw new Error(`Project is not advertised by the standalone GSD runtime: ${aliasOrPath}`);
  }
}

function defaultProjectDirs(): string[] {
  const env = process.env["GSD_CLOUD_PROJECTS"];
  if (env && env.trim()) {
    return env.split(delimiter).map((p) => p.trim()).filter(Boolean);
  }
  return [process.cwd()];
}

function detectMarkers(path: string): string[] {
  const markers: string[] = [];
  if (existsSync(resolve(path, ".git"))) markers.push("git");
  if (existsSync(resolve(path, "package.json"))) markers.push("node");
  if (existsSync(resolve(path, ".gsd"))) markers.push("gsd");
  return markers;
}

function gitRemote(projectPath: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function identityFor(projectPath: string, remote?: string): string {
  return createHash("sha256").update(remote || `${basename(projectPath)}:${projectPath}`).digest("hex").slice(0, 12);
}
