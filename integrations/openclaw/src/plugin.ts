/**
 * Plugin registration, kept free of the OpenClaw runtime import so it can be
 * unit-tested with a stub `api`. `index.ts` is the only module that imports
 * the SDK.
 *
 * Every registration (command, service, tool, lifecycle) happens in every
 * registration mode: tool discovery calls `register` too, and the host alone
 * decides when the service starts.
 */

import { join } from "node:path";
import { BindStore } from "./binding.js";
import { createGsdCommand, type ServiceState } from "./commands.js";
import { GsdCli } from "./gsd-cli.js";
import { Notifier } from "./notify.js";
import { Supervisor, formatEvent } from "./supervisor.js";
import { TOOL_NAME, createGsdStatusTool } from "./tool.js";
import { readPluginConfig, type OpenClawPluginApi } from "./types.js";

export const PLUGIN_ID = "open-gsd-openclaw";
export const PLUGIN_NAME = "Open GSD";
export const PLUGIN_DESCRIPTION =
  "GSD Pi structured delivery engine: /gsd commands, supervised headless runs, and chat notifications";

export const BINDINGS_FILE = "bindings.json";

export function register(api: OpenClawPluginApi): void {
  const config = readPluginConfig(api.pluginConfig);
  let service: ServiceState | null = null;
  const getService = () => service;

  api.registerCommand(createGsdCommand({ config, logger: api.logger, getService }));
  api.registerTool?.(createGsdStatusTool({ config, getService }), { name: TOOL_NAME });
  api.lifecycle?.registerRuntimeLifecycle?.({
    id: PLUGIN_ID,
    description: "Stop supervised gsd runs",
    // The host runs this per session on /reset, /new and delete (with a
    // sessionKey) and plugin-wide on disable/restart (without one).
    cleanup: (ctx) => {
      const supervisor = service?.supervisor;
      if (!supervisor) return;
      if (!ctx?.sessionKey) {
        supervisor.stopAll();
        return;
      }
      for (const run of supervisor.list()) {
        if (run.sessionKey === ctx.sessionKey) supervisor.cancel(run.projectDir);
      }
    },
  });

  api.registerService({
    id: PLUGIN_ID,
    start(ctx) {
      // ctx.stateDir is the OpenClaw state root; plugin-owned files live under
      // plugin-state/<id>, the same layout the reference plugins use.
      const stateDir = join(ctx.stateDir, "plugin-state", PLUGIN_ID);
      const notifier = new Notifier(api, ctx.logger);
      const supervisor = new Supervisor({
        cliPath: config.cliPath,
        logger: ctx.logger,
        onEvent: (event) => notifier.send({ route: event.run.route, sessionKey: event.run.sessionKey, runId: event.run.runId }, formatEvent(event)),
      });
      service = {
        bindStore: new BindStore(join(stateDir, BINDINGS_FILE)),
        cli: new GsdCli(config.cliPath),
        supervisor,
        notifier,
      };
      ctx.logger.info(`open-gsd-openclaw ready (gsd: ${config.cliPath}, state: ${stateDir})`);
    },
    stop() {
      service?.supervisor.stopAll();
      service = null;
    },
  });
}
