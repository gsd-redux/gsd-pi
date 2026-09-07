/**
 * `gsd_status`: read-only agent tool. Same resolution order as `/gsd status`
 * (explicit path → binding for the tool's delivery route → defaultProject),
 * same snapshot text, plus the supervised-run line.
 */

import { resolveProject, routeFromDeliveryContext, routeKey } from "./binding.js";
import type { ServiceState } from "./commands.js";
import { formatSnapshot } from "./snapshot.js";
import { describeRun } from "./supervisor.js";
import type { AgentToolResult, OpenClawPluginToolFactory, PluginConfig } from "./types.js";

export const TOOL_NAME = "gsd_status";

const SERVICE_NOT_READY = "The Open GSD plugin service has not started yet; there is no project state to read.";

function plain(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: { projectDir: null, run: null } };
}

export function createGsdStatusTool(deps: { config: PluginConfig; getService: () => ServiceState | null }): OpenClawPluginToolFactory {
  return (ctx) => ({
    name: TOOL_NAME,
    label: "GSD status",
    description:
      "Read the bound GSD project's delivery state: phase, active milestone, slice and task, counts, blockers, next action, " +
      "and whether a supervised gsd run is active, waiting for input, or finished. Use it before advising on delivery work " +
      "or when asked how a GSD project or run is going. Read-only; it starts nothing.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "absolute project path; optional" },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const raw = (params as { project?: unknown } | undefined)?.project;
      if (raw !== undefined && raw !== null && typeof raw !== "string") throw new Error("project must be an absolute path string");
      const explicit = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
      const service = deps.getService();
      if (!service) return plain(SERVICE_NOT_READY);
      const dc = ctx.deliveryContext;
      const route = routeFromDeliveryContext(dc ? { ...dc, channel: dc.channel ?? ctx.messageChannel } : undefined);
      const bound = route ? service.bindStore.get(routeKey(route)) : undefined;
      const resolved = resolveProject({ explicit, bound, defaultProject: deps.config.defaultProject });
      if (!resolved.ok) {
        if (explicit) throw new Error(resolved.error);
        return plain(resolved.error);
      }
      const progress = await service.cli.readProgress(resolved.dir);
      const run = service.supervisor.get(resolved.dir) ?? service.supervisor.lastFinished(resolved.dir);
      const text = `${formatSnapshot(progress, [`Project: \`${resolved.dir}\``])}\n${describeRun(run)}`;
      return {
        content: [{ type: "text", text }],
        details: {
          projectDir: resolved.dir,
          phase: progress.phase,
          activeMilestone: progress.activeMilestone,
          activeSlice: progress.activeSlice,
          activeTask: progress.activeTask,
          blockers: progress.blockers,
          nextAction: progress.nextAction,
          run: run ? { runId: run.runId, status: run.status, ...(run.blocker ? { blocker: run.blocker } : {}) } : null,
        },
      };
    },
  });
}
