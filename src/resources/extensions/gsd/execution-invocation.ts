// Project/App: gsd-pi
// File Purpose: Private transport identity carried into Task execution Domain Operations.

export interface ExecutionInvocation {
  idempotencyKey: string;
  sourceTransport: "internal" | "pi-tool" | "workflow-mcp";
  actorType: string;
  actorId?: string;
  traceId?: string;
  turnId?: string;
}
