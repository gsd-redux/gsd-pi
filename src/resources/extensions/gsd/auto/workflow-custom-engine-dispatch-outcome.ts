// Project/App: gsd-pi
// File Purpose: Applies custom-engine dispatch decisions to auto-mode loop side effects.

import type { EngineDispatchDecision } from "./workflow-kernel.js";

export interface HandleCustomEngineDispatchOutcomeDeps {
  stopAuto: (reason: string) => Promise<void>;
}

export type CustomEngineDispatchFlow =
  | { action: "break"; inputPayload: string }
  | { action: "continue" }
  | { action: "dispatch" };

export async function handleCustomEngineDispatchOutcome(input: {
  decision: EngineDispatchDecision;
  deps: HandleCustomEngineDispatchOutcomeDeps;
}): Promise<CustomEngineDispatchFlow> {
  if (input.decision.action === "stop") {
    await input.deps.stopAuto(input.decision.reason);
    return { action: "break", inputPayload: input.decision.reason };
  }
  if (input.decision.action === "skip") {
    return { action: "continue" };
  }

  return { action: "dispatch" };
}
