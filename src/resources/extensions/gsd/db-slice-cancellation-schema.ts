// Project/App: gsd-pi
// File Purpose: v40 authorization for settling an active Attempt during Slice cancellation.

import {
  createAttemptSettlementShapeTrigger,
  createAttemptTransitionFencingTrigger,
} from "./db-attempt-recovery-schema.js";
import type { DbAdapter } from "./db-adapter.js";

export function createSliceCancellationSchemaV40(db: DbAdapter): void {
  const cancellationOperations = ["task.cancel", "slice.cancel"] as const;
  createAttemptTransitionFencingTrigger(db, cancellationOperations);
  createAttemptSettlementShapeTrigger(db, cancellationOperations);
}
