// Project/App: gsd-pi
// File Purpose: Typed, response-neutral lifecycle-shadow observation payloads for milestone-status reads.

import { createHash } from "node:crypto";

import type {
  LifecycleShadowComparison,
  LifecycleShadowComparisonKind,
} from "./db/lifecycle-shadow-comparison.js";

export type MilestoneStatusRuntimeMode =
  | "auto"
  | "interactive"
  | "guided"
  | "uok"
  | "custom"
  | "legacy";

export type MilestoneStatusTransport = "native_pi" | "workflow_mcp";

export type MilestoneStatusObservationContextError = "unavailable" | "invalid";

export interface MilestoneStatusObservationContext {
  mode: MilestoneStatusRuntimeMode;
  transport: MilestoneStatusTransport;
  sourceRevision: string;
  traceId?: string;
  turnId?: string;
  contextError?: MilestoneStatusObservationContextError;
}

export interface LifecycleShadowObservationItem {
  itemIdentity: {
    itemKind: "milestone" | "slice" | "task";
    milestoneId: string;
    sliceId: string | null;
    taskId: string | null;
    lifecycleId: string | null;
  };
  rawLegacyStatus: string | null;
  rawCanonicalStatus: string | null;
  normalizedLegacyStatus: string | null;
  normalizedCanonicalStatus: string | null;
  classification: LifecycleShadowComparisonKind;
}

export interface LifecycleShadowObservationSnapshot {
  projectRevision: number;
  authorityEpoch: number;
  items: LifecycleShadowObservationItem[];
  queryError?: unknown;
}

export interface LifecycleShadowObservationLossAccounting {
  lossCount: number;
  persistedCount: number;
  reason?: "context_resolution_failed" | "shadow_query_failed" | "primary_sink_failed" | "projection_sink_failed";
  errorHash?: string;
  causes?: Array<{
    reason: "context_resolution_failed" | "shadow_query_failed" | "primary_sink_failed" | "projection_sink_failed";
    errorHash: string;
  }>;
}

export interface LifecycleShadowObservation {
  milestoneId: string;
  items: LifecycleShadowObservationItem[];
  mode: MilestoneStatusRuntimeMode;
  transport: MilestoneStatusTransport;
  sourceRevision: string;
  projectRevision: number;
  authorityEpoch: number;
  traceId: string | null;
  turnId: string | null;
  repairDisposition: "not_attempted";
  reason?: "shadow_query_failed";
  contextError?: MilestoneStatusObservationContextError;
  observationLossAccounting: LifecycleShadowObservationLossAccounting;
}

export function defaultMilestoneStatusObservationContext(): MilestoneStatusObservationContext {
  return {
    mode: "legacy",
    transport: "native_pi",
    sourceRevision: "unavailable",
  };
}

export function lifecycleShadowObservationItem(input: {
  itemKind: "milestone" | "slice" | "task";
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  lifecycleId: string | null;
  comparison: LifecycleShadowComparison;
}): LifecycleShadowObservationItem {
  return {
    itemIdentity: {
      itemKind: input.itemKind,
      milestoneId: input.milestoneId,
      sliceId: input.sliceId,
      taskId: input.taskId,
      lifecycleId: input.lifecycleId,
    },
    rawLegacyStatus: input.comparison.legacyStatus,
    rawCanonicalStatus: input.comparison.canonicalStatus,
    normalizedLegacyStatus: input.comparison.normalizedLegacyStatus,
    normalizedCanonicalStatus: input.comparison.normalizedCanonicalStatus,
    classification: input.comparison.kind,
  };
}

export function lifecycleShadowErrorHash(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `sha256:${createHash("sha256").update(message).digest("hex")}`;
}

export function buildLifecycleShadowObservation(
  milestoneId: string,
  snapshot: LifecycleShadowObservationSnapshot,
  context: MilestoneStatusObservationContext = defaultMilestoneStatusObservationContext(),
): LifecycleShadowObservation {
  const contextCause = context.contextError
    ? {
        reason: "context_resolution_failed" as const,
        errorHash: lifecycleShadowErrorHash(`milestone status observation context ${context.contextError}`),
      }
    : undefined;
  const common = {
    milestoneId,
    mode: context.mode,
    transport: context.transport,
    sourceRevision: context.sourceRevision,
    projectRevision: snapshot.projectRevision,
    authorityEpoch: snapshot.authorityEpoch,
    traceId: context.traceId ?? null,
    turnId: context.turnId ?? null,
    repairDisposition: "not_attempted" as const,
    ...(context.contextError ? { contextError: context.contextError } : {}),
  };

  if (snapshot.queryError !== undefined) {
    const queryCause = {
      reason: "shadow_query_failed" as const,
      errorHash: lifecycleShadowErrorHash(snapshot.queryError),
    };
    return {
      ...common,
      items: [],
      reason: "shadow_query_failed",
      observationLossAccounting: {
        lossCount: contextCause ? 2 : 1,
        persistedCount: 1,
        ...queryCause,
        ...(contextCause
          ? {
              causes: [contextCause, queryCause],
            }
          : {}),
      },
    };
  }

  return {
    ...common,
    items: snapshot.items,
    observationLossAccounting: contextCause
      ? { lossCount: 1, persistedCount: 1, ...contextCause }
      : { lossCount: 0, persistedCount: 1 },
  };
}
