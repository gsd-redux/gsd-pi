// Project/App: gsd-pi
// File Purpose: Hard tests for AutoAdvanceResult skip-code matching.

import assert from "node:assert/strict";
import test from "node:test";

import { isUnitAlreadyActiveSkip } from "../auto/contracts.ts";

test("isUnitAlreadyActiveSkip matches the skip code, not the reason text", () => {
  assert.equal(
    isUnitAlreadyActiveSkip({
      kind: "skipped",
      code: "unit-already-active",
      reason: "idempotent advance: unit already active",
    }),
    true,
  );
  assert.equal(
    isUnitAlreadyActiveSkip({
      kind: "skipped",
      reason: "idempotent advance: unit already active",
    }),
    false,
  );
  assert.equal(
    isUnitAlreadyActiveSkip({
      kind: "skipped",
      code: "completed-no-advance",
      reason: "idempotent advance: unit already active",
    }),
    false,
  );
});
