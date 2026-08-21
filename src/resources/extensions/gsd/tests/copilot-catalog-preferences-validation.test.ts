// Validation tests for GSD-W018's `copilot_catalog` preference block
// (refresh_on_session_start / notify_on_changes / stale_after_ms).

import test from "node:test";
import assert from "node:assert/strict";

import { validatePreferences } from "../preferences.js";

test("copilot_catalog: valid config passes through with no errors", () => {
  const { errors, preferences } = validatePreferences({
    copilot_catalog: {
      refresh_on_session_start: "if_stale",
      notify_on_changes: false,
      stale_after_ms: 3_600_000,
    },
  } as any);

  assert.deepEqual(errors, []);
  assert.deepEqual(preferences.copilot_catalog, {
    refresh_on_session_start: "if_stale",
    notify_on_changes: false,
    stale_after_ms: 3_600_000,
  });
});

test("copilot_catalog: omitted config produces no errors and no default injection", () => {
  const { errors, preferences } = validatePreferences({} as any);
  assert.deepEqual(errors, []);
  assert.equal(preferences.copilot_catalog, undefined);
});

test("copilot_catalog: rejects an invalid refresh_on_session_start value", () => {
  const { errors } = validatePreferences({
    copilot_catalog: { refresh_on_session_start: "sometimes" },
  } as any);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /refresh_on_session_start must be one of: off, if_stale, always/);
});

test("copilot_catalog: rejects a non-boolean notify_on_changes", () => {
  const { errors } = validatePreferences({
    copilot_catalog: { notify_on_changes: "yes" },
  } as any);
  assert.match(errors[0]!, /notify_on_changes must be a boolean/);
});

test("copilot_catalog: rejects an out-of-range stale_after_ms", () => {
  const tooLow = validatePreferences({ copilot_catalog: { stale_after_ms: 1000 } } as any);
  assert.match(tooLow.errors[0]!, /stale_after_ms must be a number between 60000 and 604800000/);

  const tooHigh = validatePreferences({ copilot_catalog: { stale_after_ms: 1e12 } } as any);
  assert.match(tooHigh.errors[0]!, /stale_after_ms must be a number between 60000 and 604800000/);
});

test("copilot_catalog: warns on unknown sub-keys without rejecting known ones", () => {
  const { errors, warnings, preferences } = validatePreferences({
    copilot_catalog: { refresh_on_session_start: "always", made_up_key: true },
  } as any);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('unknown copilot_catalog key "made_up_key"')));
  assert.equal(preferences.copilot_catalog?.refresh_on_session_start, "always");
});

test("copilot_catalog: rejects a non-object value", () => {
  const { errors } = validatePreferences({ copilot_catalog: "always" } as any);
  assert.match(errors[0]!, /copilot_catalog must be an object/);
});
