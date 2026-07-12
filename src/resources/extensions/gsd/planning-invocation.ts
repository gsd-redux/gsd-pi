// Project/App: gsd-pi
// File Purpose: Private transport identity carried into planning Domain Operations.

import { randomUUID } from "node:crypto";

export interface PlanningInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}

export function internalPlanningInvocation(): PlanningInvocation {
  return {
    idempotencyKey: `internal:${randomUUID()}`,
    sourceTransport: "internal",
    actorType: "agent",
  };
}

export function piPlanningInvocation(canonicalToolName: string, toolCallId: string): PlanningInvocation {
  return {
    idempotencyKey: `pi:${canonicalToolName}:${toolCallId}`,
    sourceTransport: "pi-tool",
    actorType: "agent",
    traceId: toolCallId,
  };
}
