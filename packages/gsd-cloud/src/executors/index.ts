// Project/App: Open GSD
// File Purpose: Executor selection seam — pick a backend adapter by name.
//
// The gsd-pi shell-out adapter is the only implemented backend today. `codex`
// and `claude` are stubbed so the seam is visible; selecting them throws until
// their behaviour is designed.

import type { Logger } from "../logger.js";
import type { Executor } from "./executor.js";
import { GsdPiExecutor, type GsdPiExecutorOptions } from "./gsd-pi-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { ClaudeExecutor } from "./claude-executor.js";

export type ExecutorKind = "gsd-pi" | "codex" | "claude";

export interface SelectExecutorOptions extends GsdPiExecutorOptions {
  kind?: ExecutorKind;
}

/**
 * Resolve the execution backend. Defaults to the gsd-pi shell-out adapter, which
 * drives the installed `gsd` CLI over MCP. Selection can also be overridden with
 * the GSD_CLOUD_EXECUTOR env var.
 */
export function selectExecutor(logger: Logger, opts: SelectExecutorOptions = {}): Executor {
  const kind = opts.kind ?? (process.env["GSD_CLOUD_EXECUTOR"] as ExecutorKind | undefined) ?? "gsd-pi";
  switch (kind) {
    case "gsd-pi":
      return new GsdPiExecutor(logger, opts);
    case "codex":
      return new CodexExecutor();
    case "claude":
      return new ClaudeExecutor();
    default:
      throw new Error(`Unknown executor kind: ${String(kind)}`);
  }
}

export type { Executor, AdvertisedProject } from "./executor.js";
export { GsdPiExecutor } from "./gsd-pi-executor.js";
export type { GsdPiExecutorOptions } from "./gsd-pi-executor.js";
