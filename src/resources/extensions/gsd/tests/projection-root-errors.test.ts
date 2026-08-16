// Project/App: gsd-pi
// File Purpose: Regression coverage for Windows projection-root sharing violation classification.

import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientProjectionLockError,
  ProjectionLockTransientError,
  throwIfTransientProjectionLockError,
} from "../projection-root-errors.ts";
import { classifyFailure } from "../recovery-classification.ts";

test("Windows sharing violations become typed transient recovery failures", () => {
  const nativeError = new Error(
    "projection root operation failed: C:\\repo\\.gsd\\worktrees\\M001: The process cannot access the file because it is being used by another process. (os error 32)",
  );

  assert.equal(isTransientProjectionLockError(nativeError), true);
  assert.throws(
    () => throwIfTransientProjectionLockError(nativeError),
    ProjectionLockTransientError,
  );
  const classified = classifyFailure({ error: new ProjectionLockTransientError(nativeError) });
  assert.equal(classified.failureKind, "projection-lock-transient");
  assert.equal(classified.action, "retry");
});

test("other projection-root failures remain non-transient", () => {
  const error = new Error("projection root operation failed: access denied (os error 5)");

  assert.equal(isTransientProjectionLockError(error), false);
  assert.doesNotThrow(() => throwIfTransientProjectionLockError(error));
});
