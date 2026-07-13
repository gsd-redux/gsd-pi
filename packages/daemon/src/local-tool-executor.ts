import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  readCaptures,
  readHistory,
  readKnowledge,
  readProgress,
  readRoadmap,
  buildGraph,
  graphDiff,
  graphQuery,
  graphStatus,
  registerWorkflowTools,
  resolveGsdRoot,
  runDoctorLite,
  writeGraph,
  writeSnapshot,
  WORKFLOW_TOOL_NAMES,
} from "@opengsd/mcp-server";
import type { SessionManager } from "./session-manager.js";
import type { ProjectInfo } from "./types.js";

type ToolHandler = (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>;
const workflowRequestId = Symbol("workflowRequestId");
const WORKFLOW_TOOL_NAME_SET = new Set<string>(WORKFLOW_TOOL_NAMES);
const QUERY_FIELDS = {
  all: ["state", "project", "requirements", "milestones"],
  state: ["state"],
  status: ["state"],
  project: ["project"],
  requirements: ["requirements"],
  milestones: ["milestones"],
} as const;

type QueryCategory = keyof typeof QUERY_FIELDS;
type ProjectStateField = (typeof QUERY_FIELDS)[QueryCategory][number];

export class LocalToolExecutor {
  private readonly workflowHandlers = new Map<string, ToolHandler>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly scanProjects: () => Promise<ProjectInfo[]>,
  ) {
    registerWorkflowTools({
      tool: (name: string, _description: string, _params: Record<string, unknown>, handler: ToolHandler) => {
        if (!WORKFLOW_TOOL_NAME_SET.has(name)) return;
        this.workflowHandlers.set(name, handler);
      },
    });
  }

  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    projectAlias?: string,
    requestId?: string,
  ): Promise<unknown> {
    const args = { ...rawArgs };
    if (requestId) Object.defineProperty(args, workflowRequestId, { value: requestId });
    if (projectAlias) {
      args.projectDir = await this.resolveProjectPath(projectAlias);
    }

    const workflowResult = this.executeWorkflowTool(toolName, args);
    if (workflowResult) return workflowResult;

    switch (toolName) {
      case "gsd_execute": {
        const projectDir = await this.requiredProjectDir(args);
        const sessionId = await this.sessionManager.startSession({
          projectDir,
          command: typeof args.command === "string" ? args.command : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          bare: typeof args.bare === "boolean" ? args.bare : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify({ sessionId, status: "started" }, null, 2) }] };
      }
      case "gsd_status": {
        const session = this.sessionManager.getSession(String(args.sessionId ?? ""));
        if (!session) throw new Error(`Session not found: ${String(args.sessionId ?? "")}`);
        const toolCallCount = session.events.filter((event) => {
          const type = (event as Record<string, unknown>).type;
          return type === "tool_use" || type === "tool_execution_start";
        }).length;
        return { content: [{ type: "text", text: JSON.stringify({
          status: session.status,
          progress: {
            eventCount: session.events.length,
            toolCalls: toolCallCount,
          },
          recentEvents: session.events.slice(-10),
          pendingBlocker: session.pendingBlocker
            ? {
                id: session.pendingBlocker.id,
                method: session.pendingBlocker.method,
                message: session.pendingBlocker.message,
              }
            : null,
          cost: session.cost,
          durationMs: Date.now() - session.startTime,
        }, null, 2) }] };
      }
      case "gsd_result":
        return { content: [{ type: "text", text: JSON.stringify(this.sessionManager.getResult(String(args.sessionId ?? "")), null, 2) }] };
      case "gsd_cancel":
        if (typeof args.sessionId === "string") await this.sessionManager.cancelSession(args.sessionId);
        else await this.sessionManager.cancelSessionByDir(await this.requiredProjectDir(args));
        return { content: [{ type: "text", text: JSON.stringify({ cancelled: true }, null, 2) }] };
      case "gsd_resolve_blocker": {
        const sessionId = String(args.sessionId ?? "");
        const response = String(args.response ?? "");
        await this.sessionManager.resolveBlocker(sessionId, response);
        return { content: [{ type: "text", text: JSON.stringify({ resolved: true }, null, 2) }] };
      }
      case "gsd_query": {
        const projectDir = await this.requiredProjectDir(args);
        const query = typeof args.query === "string" ? args.query : undefined;
        return { content: [{ type: "text", text: JSON.stringify(await readProjectState(projectDir, query), null, 2) }] };
      }
      case "gsd_progress":
        return { content: [{ type: "text", text: JSON.stringify(await readProgress(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_roadmap":
        return { content: [{ type: "text", text: JSON.stringify(await readRoadmap(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_history":
        return { content: [{ type: "text", text: JSON.stringify(await readHistory(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_doctor":
        return { content: [{ type: "text", text: JSON.stringify(await runDoctorLite(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_captures":
        return { content: [{ type: "text", text: JSON.stringify(await readCaptures(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_knowledge":
        return { content: [{ type: "text", text: JSON.stringify(await readKnowledge(await this.requiredProjectDir(args)), null, 2) }] };
      case "gsd_graph":
        return { content: [{ type: "text", text: JSON.stringify(await this.executeGraph(args), null, 2) }] };
      default:
        throw new Error(`Unsupported forwarded GSD MCP tool: ${toolName}`);
    }
  }

  async advertisedProjects(): Promise<Array<{
    alias: string;
    path: string;
    repoIdentity: string;
    remoteLabel?: string;
    markers: string[];
  }>> {
    const projects = await this.scanProjects();
    return projects.map((project) => {
      const remoteLabel = gitRemote(project.path);
      return {
        alias: project.name,
        path: project.path,
        repoIdentity: identityFor(project.path, remoteLabel),
        ...(remoteLabel ? { remoteLabel } : {}),
        markers: project.markers,
      };
    });
  }

  private async requiredProjectDir(args: Record<string, unknown>): Promise<string> {
    const value = args.projectDir;
    if (typeof value === "string" && value.trim()) return this.resolveProjectPath(value);
    throw new Error("projectDir or projectAlias is required");
  }

  private async resolveProjectPath(aliasOrPath: string): Promise<string> {
    const projects = await this.scanProjects();
    const match = projects.find((project) => project.name === aliasOrPath || project.path === aliasOrPath);
    if (!match) throw new Error(`Project is not advertised by the Local GSD Runtime: ${aliasOrPath}`);
    return match.path;
  }

  private executeWorkflowTool(toolName: string, args: Record<string, unknown>): Promise<unknown> | undefined {
    switch (toolName) {
      case "gsd_decision_save": return this.invokeRegisteredWorkflowTool("gsd_decision_save", args);
      case "gsd_save_decision": return this.invokeRegisteredWorkflowTool("gsd_save_decision", args);
      case "gsd_requirement_update": return this.invokeRegisteredWorkflowTool("gsd_requirement_update", args);
      case "gsd_update_requirement": return this.invokeRegisteredWorkflowTool("gsd_update_requirement", args);
      case "gsd_requirement_save": return this.invokeRegisteredWorkflowTool("gsd_requirement_save", args);
      case "gsd_save_requirement": return this.invokeRegisteredWorkflowTool("gsd_save_requirement", args);
      case "gsd_milestone_generate_id": return this.invokeRegisteredWorkflowTool("gsd_milestone_generate_id", args);
      case "gsd_generate_milestone_id": return this.invokeRegisteredWorkflowTool("gsd_generate_milestone_id", args);
      case "gsd_plan_milestone": return this.invokeRegisteredWorkflowTool("gsd_plan_milestone", args);
      case "gsd_plan_slice": return this.invokeRegisteredWorkflowTool("gsd_plan_slice", args);
      case "gsd_plan_task": return this.invokeRegisteredWorkflowTool("gsd_plan_task", args);
      case "gsd_task_plan": return this.invokeRegisteredWorkflowTool("gsd_task_plan", args);
      case "gsd_replan_slice": return this.invokeRegisteredWorkflowTool("gsd_replan_slice", args);
      case "gsd_slice_replan": return this.invokeRegisteredWorkflowTool("gsd_slice_replan", args);
      case "gsd_replan_task": return this.invokeRegisteredWorkflowTool("gsd_replan_task", args);
      case "gsd_rework_brief_save": return this.invokeRegisteredWorkflowTool("gsd_rework_brief_save", args);
      case "gsd_slice_complete": return this.invokeRegisteredWorkflowTool("gsd_slice_complete", args);
      case "gsd_complete_slice": return this.invokeRegisteredWorkflowTool("gsd_complete_slice", args);
      case "gsd_skip_slice": return this.invokeRegisteredWorkflowTool("gsd_skip_slice", args);
      case "gsd_complete_milestone": return this.invokeRegisteredWorkflowTool("gsd_complete_milestone", args);
      case "gsd_milestone_complete": return this.invokeRegisteredWorkflowTool("gsd_milestone_complete", args);
      case "gsd_validate_milestone": return this.invokeRegisteredWorkflowTool("gsd_validate_milestone", args);
      case "gsd_milestone_validate": return this.invokeRegisteredWorkflowTool("gsd_milestone_validate", args);
      case "gsd_reassess_roadmap": return this.invokeRegisteredWorkflowTool("gsd_reassess_roadmap", args);
      case "gsd_roadmap_reassess": return this.invokeRegisteredWorkflowTool("gsd_roadmap_reassess", args);
      case "gsd_save_gate_result": return this.invokeRegisteredWorkflowTool("gsd_save_gate_result", args);
      case "gsd_summary_save": return this.invokeRegisteredWorkflowTool("gsd_summary_save", args);
      case "gsd_task_complete": return this.invokeRegisteredWorkflowTool("gsd_task_complete", args);
      case "gsd_complete_task": return this.invokeRegisteredWorkflowTool("gsd_complete_task", args);
      case "gsd_task_reopen": return this.invokeRegisteredWorkflowTool("gsd_task_reopen", args);
      case "gsd_reopen_task": return this.invokeRegisteredWorkflowTool("gsd_reopen_task", args);
      case "gsd_task_recovery_resume": return this.invokeRegisteredWorkflowTool("gsd_task_recovery_resume", args);
      case "gsd_slice_reopen": return this.invokeRegisteredWorkflowTool("gsd_slice_reopen", args);
      case "gsd_reopen_slice": return this.invokeRegisteredWorkflowTool("gsd_reopen_slice", args);
      case "gsd_milestone_reopen": return this.invokeRegisteredWorkflowTool("gsd_milestone_reopen", args);
      case "gsd_reopen_milestone": return this.invokeRegisteredWorkflowTool("gsd_reopen_milestone", args);
      case "gsd_milestone_status": return this.invokeRegisteredWorkflowTool("gsd_milestone_status", args);
      case "gsd_journal_query": return this.invokeRegisteredWorkflowTool("gsd_journal_query", args);
      case "gsd_exec": return this.invokeRegisteredWorkflowTool("gsd_exec", args);
      case "gsd_exec_search": return this.invokeRegisteredWorkflowTool("gsd_exec_search", args);
      case "gsd_resume": return this.invokeRegisteredWorkflowTool("gsd_resume", args);
      case "gsd_capture_thought": return this.invokeRegisteredWorkflowTool("gsd_capture_thought", args);
      case "gsd_memory_query": return this.invokeRegisteredWorkflowTool("gsd_memory_query", args);
      case "gsd_memory_graph": return this.invokeRegisteredWorkflowTool("gsd_memory_graph", args);
      default:
        if (WORKFLOW_TOOL_NAME_SET.has(toolName)) {
          throw new Error(`Unsupported forwarded GSD MCP tool: ${toolName}`);
        }
        return undefined;
    }
  }

  private invokeRegisteredWorkflowTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const workflow = this.workflowHandlers.get(toolName);
    if (!workflow) throw new Error(`Unsupported forwarded GSD MCP tool: ${toolName}`);
    const requestId = (args as Record<PropertyKey, unknown>)[workflowRequestId];
    const extra = typeof requestId === "string"
      ? { _meta: { "io.opengsd/idempotency-key": requestId } }
      : undefined;
    return workflow(args, extra);
  }

  private async executeGraph(args: Record<string, unknown>): Promise<unknown> {
    const projectDir = await this.requiredProjectDir(args);
    const mode = args.mode;
    switch (mode) {
      case "build": {
        const gsdRoot = resolveGsdRoot(projectDir);
        if (args.snapshot === true) {
          await writeSnapshot(gsdRoot).catch(() => { /* best-effort */ });
        }
        const graph = await buildGraph(projectDir);
        await writeGraph(gsdRoot, graph);
        return {
          built: true,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          builtAt: graph.builtAt,
        };
      }
      case "query":
        return graphQuery(
          projectDir,
          typeof args.term === "string" ? args.term : "",
          typeof args.budget === "number" ? args.budget : undefined,
        );
      case "status":
        return graphStatus(projectDir);
      case "diff":
        return graphDiff(projectDir);
      default:
        throw new Error("gsd_graph mode must be one of: build, query, status, diff");
    }
  }
}

async function readProjectState(projectDir: string, query: string | undefined): Promise<Record<string, unknown>> {
  const resolvedProjectDir = resolve(projectDir);
  const gsdDir = join(resolvedProjectDir, ".gsd");
  const category = normalizeQuery(query);
  const wanted = new Set<ProjectStateField>(QUERY_FIELDS[category]);

  const result: Record<string, unknown> = {
    projectDir: resolvedProjectDir,
    query: category,
  };

  if (wanted.has("state")) {
    result.state = await readTextOrNull(join(gsdDir, "STATE.md"));
  }
  if (wanted.has("project")) {
    result.project = await readTextOrNull(join(gsdDir, "PROJECT.md"));
  }
  if (wanted.has("requirements")) {
    result.requirements = await readTextOrNull(join(gsdDir, "REQUIREMENTS.md"));
  }
  if (wanted.has("milestones")) {
    result.milestones = await readMilestones(gsdDir);
  }

  return result;
}

function normalizeQuery(query: string | undefined): QueryCategory {
  const key = (query ?? "all").trim().toLowerCase();
  return Object.hasOwn(QUERY_FIELDS, key) ? key as QueryCategory : "all";
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readMilestones(gsdDir: string): Promise<Array<{ id: string; hasRoadmap: boolean; hasSummary: boolean }>> {
  try {
    const entries = await readdir(join(gsdDir, "milestones"), { withFileTypes: true });
    const milestones: Array<{ id: string; hasRoadmap: boolean; hasSummary: boolean }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      milestones.push({
        id: entry.name,
        hasRoadmap: await milestoneFileExists(gsdDir, entry.name, "ROADMAP"),
        hasSummary: await milestoneFileExists(gsdDir, entry.name, "SUMMARY"),
      });
    }
    return milestones;
  } catch {
    return [];
  }
}

async function milestoneFileExists(gsdDir: string, milestoneId: string, suffix: string): Promise<boolean> {
  const milestoneDir = join(gsdDir, "milestones", milestoneId);
  return fileExists(join(milestoneDir, `${milestoneId}-${suffix}.md`))
    || fileExists(join(milestoneDir, `${basename(milestoneDir)}-${suffix}.md`))
    || fileExists(join(milestoneDir, `${suffix}.md`));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
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
