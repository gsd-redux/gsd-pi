// Project/App: gsd-pi
// File Purpose: Captures private Slice lifecycle executor calls from the Pi tool adapter.

import type { ExecutionInvocation } from "../../execution-invocation.ts";

export interface CapturedSliceLifecycleCall {
  executor: "complete" | "reopen" | "skip";
  params: Record<string, unknown>;
  basePath: string;
  invocation: ExecutionInvocation | undefined;
}

const calls: CapturedSliceLifecycleCall[] = [];

export function readCapturedSliceLifecycleCalls(): CapturedSliceLifecycleCall[] {
  return calls.map((call) => ({ ...call, params: { ...call.params } }));
}

export function resetCapturedSliceLifecycleCalls(): void {
  calls.length = 0;
}

function capture(
  executor: CapturedSliceLifecycleCall["executor"],
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

export function executeSummarySave(): Promise<Record<string, unknown>> {
  return Promise.resolve({ content: [], details: {} });
}
