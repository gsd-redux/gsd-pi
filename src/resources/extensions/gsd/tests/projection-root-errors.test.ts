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

test("a wrapped sharing violation classifies as transient through the cause chain (#1762)", () => {
  const bare = new Error(
    "projection root operation failed: C:\\repo: file is being used by another process (os error 32)",
  );
  const wrapped = new Error("managed projection history replay failed", { cause: bare });
  const doubleWrapped = new Error("journal replay aborted", { cause: wrapped });

  assert.equal(isTransientProjectionLockError(wrapped), true);
  assert.equal(isTransientProjectionLockError(doubleWrapped), true);
  const classified = classifyFailure({ error: doubleWrapped });
  assert.equal(classified.failureKind, "projection-lock-transient");
  assert.equal(classified.action, "retry");
});

test("the transient classification carries the bounded backoff schedule (#1690)", () => {
  const classified = classifyFailure({
    error: new Error("projection root operation failed: busy (os error 32)"),
  });
  assert.equal(classified.failureKind, "projection-lock-transient");
  assert.deepEqual(classified.backoffMs, [1000, 2000, 4000, 8000, 16000, 30000]);

  const nonTransient = classifyFailure({ error: new Error("access denied (os error 5)") });
  assert.equal(nonTransient.backoffMs, undefined);
});
