// Project/App: gsd-pi
// File Purpose: v37 authorization for settling an active Attempt during Task cancellation.

import {
  createAttemptSettlementShapeTrigger,
  createAttemptTransitionFencingTrigger,
} from "./db-attempt-recovery-schema.js";
import type { DbAdapter } from "./db-adapter.js";

export function createTaskCancellationSchemaV37(db: DbAdapter): void {
  createAttemptTransitionFencingTrigger(db, true);
  createAttemptSettlementShapeTrigger(db, true);
}
