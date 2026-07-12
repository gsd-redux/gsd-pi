// Project/App: gsd-pi
// File Purpose: Private transport identity carried into planning Domain Operations.

import { randomUUID } from "node:crypto";

export interface PlanningInvocation {
  idempotencyKey: string;
  sourceTransport: "direct" | "pi-extension" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

export function directPlanningInvocation(): PlanningInvocation {
  return {
    idempotencyKey: `direct:${randomUUID()}`,
    sourceTransport: "direct",
    actorType: "agent",
  };
}

export function piPlanningInvocation(toolCallId: string): PlanningInvocation {
  return {
    idempotencyKey: `pi:${toolCallId}`,
    sourceTransport: "pi-extension",
    actorType: "agent",
    traceId: toolCallId,
  };
}
