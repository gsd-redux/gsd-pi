/**
 * `/gsd` command router.
 *
 * Authorization is delegated to the host: `requiredScopes: ["operator.write"]`
 * is satisfied by Gateway clients holding that scope and, on chat surfaces, by
 * command owners (`commands.ownerAllowFrom` / channel owner rules). The plugin
 * adds no allowlist of its own.
 *
 * Free text is never split into argv: the headless parser consumes any
 * recognized `--flag` wherever it appears (src/headless.ts), so chat text is
 * passed as ONE argument and user tokens starting with `-` are rejected.
 */

import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { BindStore, NO_PROJECT_MESSAGE, resolveProject, routeFromCommandContext, routeKey, validateProjectPath, type Route } from "./binding.js";
import { GsdCli } from "./gsd-cli.js";
import type { Notifier } from "./notify.js";
import { errorMessage } from "./redact.js";
import { formatSnapshot } from "./snapshot.js";
import { describeRun, type GsdRun, type Supervisor } from "./supervisor.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext, PluginCommandResult, PluginConfig, PluginLogger } from "./types.js";

export interface ServiceState {
  bindStore: BindStore;
  cli: GsdCli;
  supervisor: Supervisor;
  /** ponytail: held for the service's lifetime only; the supervisor's onEvent closure owns the reference. */
  notifier: Notifier;
}

export interface CommandDeps {
  config: PluginConfig;
  logger: PluginLogger;
  getService: () => ServiceState | null;
}

export const HELP_TEXT = [
  "**GSD commands**",
  "- `/gsd status [path]` — project snapshot and run state",
  "- `/gsd auto [path] [--model <id>]` — start a supervised `gsd auto` run",
  "- `/gsd new-milestone <brief...> | --file <absolute path> [--auto]` — create a milestone from a brief",
  "- `/gsd quick <task...>` — run a quick task",
  "- `/gsd reply <number or text>` — answer the run's pending question (`cancel` skips it)",
  "- `/gsd cancel [path]` — stop the active run",
  "- `/gsd bind <absolute path>` — bind this conversation to a GSD project",
  "- `/gsd unbind` — remove the binding",
  "- `/gsd help` — this list",
].join("\n");

const SERVICE_NOT_READY = "The Open GSD plugin service has not started yet. Retry after the Gateway finishes starting.";
const MODEL_ID = /^[\w.:/-]+$/;

/** Split command arguments on whitespace, honouring double and single quotes. */
export function tokenize(raw: string | undefined): string[] {
  if (!raw) return [];
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of raw.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/** Everything after the subcommand word, verbatim. */
function remainder(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^\S+\s*/, "");
}

type Flags = { words: string[]; model?: string; file?: string; auto?: boolean };

/** Separate the plugin's own flags from free text; any other `-token` is a usage error. */
function splitFlags(tokens: string[], allowed: Array<"model" | "file" | "auto">): Flags | { error: string } {
  const out: Flags = { words: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-")) {
      out.words.push(token);
      continue;
    }
    if (token === "--auto" && allowed.includes("auto")) {
      out.auto = true;
    } else if (token === "--model" && allowed.includes("model")) {
      const value = tokens[++i];
      if (!value || !MODEL_ID.test(value)) return { error: "`--model` needs a model id (letters, digits, `.`, `:`, `/`, `-`, `_`)." };
      out.model = value;
    } else if (token === "--file" && allowed.includes("file")) {
      const value = tokens[++i];
      if (!value || !isAbsolute(value)) return { error: "`--file` needs an absolute path." };
      const file = resolve(value);
      try {
        if (!statSync(file).isFile()) return { error: `\`${file}\` is not a regular file.` };
      } catch {
        return { error: `\`${file}\` does not exist or is not readable.` };
      }
      out.file = file;
    } else {
      return { error: `Option \`${token}\` is not allowed here${allowed.length ? ` (allowed: ${allowed.map((f) => `--${f}`).join(", ")})` : ""}.` };
    }
  }
  return out;
}

export function createGsdCommand(deps: CommandDeps): OpenClawPluginCommandDefinition {
  return {
    name: "gsd",
    description: "GSD Pi: status, supervised auto/new-milestone/quick runs, reply, cancel, bind. Usage: /gsd help",
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: ["operator.write"],
    agentPromptGuidance: [
      "Use the gsd_status tool (or /gsd status) to read the bound GSD project's milestone, slice, task, blockers, and run state before advising on delivery work.",
      "Supervised runs are started by the operator with /gsd auto, /gsd new-milestone, or /gsd quick; their progress and questions are posted to the chat.",
    ],
    handler: (ctx) => handleGsdCommand(deps, ctx),
  };
}

export async function handleGsdCommand(deps: CommandDeps, ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const [sub = "help", ...rest] = tokenize(ctx.args);
  switch (sub.toLowerCase()) {
    case "status":
      return status(deps, ctx, rest[0]);
    case "auto":
      return startRun(deps, ctx, "auto", rest);
    case "new-milestone":
      return startRun(deps, ctx, "new-milestone", rest);
    case "quick":
      return startRun(deps, ctx, "quick", rest);
    case "reply":
      return reply(deps, ctx, remainder(ctx.args));
    case "cancel":
      return cancel(deps, ctx, rest[0]);
    case "bind":
      return bind(deps, ctx, rest[0]);
    case "unbind":
      return unbind(deps, ctx);
    case "help":
      return { text: HELP_TEXT };
    default:
      return { text: `Unknown subcommand \`${sub}\`.\n${HELP_TEXT}` };
  }
}

function boundProject(deps: CommandDeps, ctx: PluginCommandContext): string | undefined {
  const service = deps.getService();
  const route = routeFromCommandContext(ctx);
  if (!service || !route) return undefined;
  return service.bindStore.get(routeKey(route));
}

/** Service, route and project for a run-scoped subcommand, or the message to send back. */
function runTarget(deps: CommandDeps, ctx: PluginCommandContext, explicit: string | undefined): { service: ServiceState; route: Route; dir: string } | { text: string } {
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const route = routeFromCommandContext(ctx);
  if (!route) return { text: "This conversation has no stable route to post run progress to; use `/gsd bind` from a chat channel." };
  const resolved = resolveProject({ explicit, bound: service.bindStore.get(routeKey(route)), defaultProject: deps.config.defaultProject });
  if (!resolved.ok) return { text: resolved.error };
  return { service, route, dir: resolved.dir };
}

async function status(deps: CommandDeps, ctx: PluginCommandContext, explicit: string | undefined): Promise<PluginCommandResult> {
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const resolved = resolveProject({ explicit, bound: boundProject(deps, ctx), defaultProject: deps.config.defaultProject });
  if (!resolved.ok) return { text: resolved.error };
  const run = service.supervisor.get(resolved.dir) ?? service.supervisor.lastFinished(resolved.dir);
  try {
    const progress = await service.cli.readProgress(resolved.dir);
    return { text: `${formatSnapshot(progress, [`Project: \`${resolved.dir}\``])}\n${describeRun(run)}` };
  } catch (error) {
    deps.logger.warn(`/gsd status failed for ${resolved.dir}: ${errorMessage(error)}`);
    return { text: `GSD status unavailable: ${errorMessage(error)}\n${describeRun(run)}` };
  }
}

async function startRun(deps: CommandDeps, ctx: PluginCommandContext, command: GsdRun["command"], tokens: string[]): Promise<PluginCommandResult> {
  const flags = splitFlags(tokens, command === "auto" ? ["model"] : command === "new-milestone" ? ["file", "auto"] : []);
  if ("error" in flags) return { text: `${flags.error}\n${HELP_TEXT}` };
  let explicit: string | undefined;
  const commandArgs: string[] = [];
  const extraFlags: string[] = [];
  if (command === "auto") {
    if (flags.words.length > 1) return { text: "Usage: `/gsd auto [path] [--model <id>]`" };
    explicit = flags.words[0];
    if (flags.model) extraFlags.push("--model", flags.model);
  } else if (command === "new-milestone") {
    const text = flags.words.join(" ").trim();
    if (flags.file && text) return { text: "Give either a brief or `--file`, not both." };
    if (flags.file) extraFlags.push("--context", flags.file);
    else if (text) extraFlags.push("--context-text", text);
    else return { text: "Usage: `/gsd new-milestone <brief...>` or `/gsd new-milestone --file <absolute path>` (add `--auto` to start execution)." };
    if (flags.auto) extraFlags.push("--auto");
  } else {
    // ponytail: the task is the raw remainder (quotes preserved), one argv element.
    const task = remainder(ctx.args).trim();
    if (!task) return { text: "Usage: `/gsd quick <task description>`" };
    commandArgs.push(task);
  }
  const target = runTarget(deps, ctx, explicit);
  if ("text" in target) return target;
  const started = target.service.supervisor.start({
    projectDir: target.dir,
    command,
    commandArgs,
    extraFlags,
    route: target.route,
    sessionKey: ctx.sessionKey,
  });
  if (!started.ok) return { text: started.error };
  return { text: `Started gsd ${command} in \`${target.dir}\` (run ${started.run.runId}). Progress will be posted here.` };
}

async function reply(deps: CommandDeps, ctx: PluginCommandContext, text: string): Promise<PluginCommandResult> {
  if (!text.trim()) return { text: "Usage: `/gsd reply <number or text>` (or `/gsd reply cancel`)" };
  // The run this conversation started wins (it may have been given an explicit path); binding/default is the fallback.
  const service = deps.getService();
  const route = service ? routeFromCommandContext(ctx) : null;
  const own = route ? service!.supervisor.list().find((run) => routeKey(run.route) === routeKey(route)) : undefined;
  const target = runTarget(deps, ctx, own?.projectDir);
  if ("text" in target) return target;
  const result = target.service.supervisor.reply(target.dir, text);
  return { text: result.ok ? result.text : result.error };
}

async function cancel(deps: CommandDeps, ctx: PluginCommandContext, explicit: string | undefined): Promise<PluginCommandResult> {
  const target = runTarget(deps, ctx, explicit);
  if ("text" in target) return target;
  const result = target.service.supervisor.cancel(target.dir);
  return { text: result.ok ? `Cancelling run ${result.runId} in \`${target.dir}\`.` : result.error };
}

async function bind(deps: CommandDeps, ctx: PluginCommandContext, rawPath: string | undefined): Promise<PluginCommandResult> {
  if (!rawPath) return { text: "Usage: `/gsd bind <absolute path>`" };
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const route = routeFromCommandContext(ctx);
  if (!route) return { text: "This conversation has no stable route to bind; use `defaultProject` in the plugin config instead." };
  const checked = validateProjectPath(rawPath);
  if (!checked.ok) return { text: checked.error };
  service.bindStore.set(routeKey(route), checked.dir);
  return { text: `Bound this conversation to \`${checked.dir}\`` };
}

async function unbind(deps: CommandDeps, ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const service = deps.getService();
  if (!service) return { text: SERVICE_NOT_READY };
  const route = routeFromCommandContext(ctx);
  if (!route) return { text: "This conversation has no binding." };
  const removed = service.bindStore.delete(routeKey(route));
  return { text: removed ? "Binding removed." : `This conversation has no binding. ${NO_PROJECT_MESSAGE}` };
}
