// Project/App: gsd-pi
// File Purpose: Captures private lifecycle executor calls from the Pi tool adapter.

import type { ExecutionInvocation } from "../../execution-invocation.ts";

export interface CapturedLifecycleCall {
  executor:
    | "complete"
    | "reopen"
    | "skip"
    | "validate"
    | "milestone-complete"
    | "milestone-reopen";
  params: Record<string, unknown>;
  basePath: string;
  invocation: ExecutionInvocation | undefined;
}

const calls: CapturedLifecycleCall[] = [];

export function readCapturedLifecycleCalls(): CapturedLifecycleCall[] {
  return calls.map((call) => ({ ...call, params: { ...call.params } }));
}

export function resetCapturedLifecycleCalls(): void {
  calls.length = 0;
}

function capture(
  executor: CapturedLifecycleCall["executor"],
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  calls.push({ executor, params, basePath, invocation });
  return Promise.resolve({
    content: [{ type: "text", text: `captured ${executor}` }],
    details: { operation: executor },
  });
}

export function executeSliceComplete(
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  return capture("complete", params, basePath, invocation);
}

export function executeSliceReopen(
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  return capture("reopen", params, basePath, invocation);
}

export function executeSkipSlice(
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  return capture("skip", params, basePath, invocation);
}

export function executeValidateMilestone(
  params: Record<string, unknown>,
  basePath: string,
  options?: { invocation?: ExecutionInvocation },
): Promise<Record<string, unknown>> {
  return capture("validate", params, basePath, options?.invocation);
}

export function executeCompleteMilestone(
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  return capture("milestone-complete", params, basePath, invocation);
}

export function executeMilestoneReopen(
  params: Record<string, unknown>,
  basePath: string,
  invocation?: ExecutionInvocation,
): Promise<Record<string, unknown>> {
  return capture("milestone-reopen", params, basePath, invocation);
}

export function executeSummarySave(): Promise<Record<string, unknown>> {
  return Promise.resolve({ content: [], details: {} });
}
