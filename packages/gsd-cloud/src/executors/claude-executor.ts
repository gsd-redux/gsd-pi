// Project/App: Open GSD
// File Purpose: Placeholder Executor adapter for the Claude CLI (`claude -p`).
//
// TODO: Implement by driving `claude -p` headlessly. The behaviour is
// intentionally NOT invented here — how claude exposes GSD workflow tools, the
// print-mode invocation shape, and result mapping must be designed first.

import type { AdvertisedProject, Executor } from "./executor.js";

export class ClaudeExecutor implements Executor {
  execute(): Promise<unknown> {
    throw new Error("claude executor not yet implemented");
  }

  advertisedProjects(): Promise<AdvertisedProject[]> {
    throw new Error("claude executor not yet implemented");
  }
}
