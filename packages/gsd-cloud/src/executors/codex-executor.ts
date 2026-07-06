// Project/App: Open GSD
// File Purpose: Placeholder Executor adapter for OpenAI Codex CLI.
//
// TODO: Implement by driving `codex` headlessly. The behaviour is intentionally
// NOT invented here — the wiring (how codex exposes GSD workflow tools, its
// invocation shape, and result mapping) must be designed before this ships.

import type { AdvertisedProject, Executor } from "./executor.js";

export class CodexExecutor implements Executor {
  execute(): Promise<unknown> {
    throw new Error("codex executor not yet implemented");
  }

  advertisedProjects(): Promise<AdvertisedProject[]> {
    throw new Error("codex executor not yet implemented");
  }
}
