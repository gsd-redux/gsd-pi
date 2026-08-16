import assert from "node:assert/strict";
import test from "node:test";

import { _openManagedProjectionRootWithRetryForTest } from "../managed-projection-history.ts";

test("managed projection root acquisition retries transient lock failures with exponential backoff", () => {
  const waits: number[] = [];
  let attempts = 0;

  const result = _openManagedProjectionRootWithRetryForTest(
    () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("native projection root identity locking failed", {
          cause: new Error("projection root operation failed: sharing violation (os error 32)"),
        });
      }
      return "acquired";
    },
    (delay) => waits.push(delay),
  );

  assert.equal(result, "acquired");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5, 10]);
});

test("managed projection root acquisition stops after the bounded retry budget", () => {
  const waits: number[] = [];
  let attempts = 0;
  const failure = new Error("native projection root identity locking failed", {
    cause: new Error("projection root is busy"),
  });

  assert.throws(
    () => _openManagedProjectionRootWithRetryForTest(
      () => {
        attempts++;
        throw failure;
      },
      (delay) => waits.push(delay),
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [5, 10, 20, 40]);
});

test("managed projection root acquisition does not retry permanent identity failures", () => {
  const waits: number[] = [];
  let attempts = 0;
  const failure = new Error("native projection root identity locking failed", {
    cause: new Error("projection root identity changed"),
  });

  assert.throws(
    () => _openManagedProjectionRootWithRetryForTest(
      () => {
        attempts++;
        throw failure;
      },
      (delay) => waits.push(delay),
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});
