/**
 * rate-limit-model-fallback.test.ts — Regression test for #2770.
 *
 * Rate-limit errors enter the model fallback path before falling through
 * to pause. This verifies the structural contract in agent-end-recovery.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECOVERY_PATH = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");

function getRecoverySource(): string {
  return readFileSync(RECOVERY_PATH, "utf-8");
}

// ── Rate-limit errors attempt model fallback (#2770) ─────────────────────────

test("rate-limit errors enter the model fallback branch alongside other transient errors", () => {
  const src = getRecoverySource();

  // The condition that gates model fallback must include rate-limit.
  // Match the if-condition that contains both "rate-limit" and fallback-related kinds.
  const fallbackConditionRe = /if\s*\([^)]*cls\.kind\s*===\s*"rate-limit"[^)]*cls\.kind\s*===\s*"network"/;
  const fallbackConditionReAlt = /if\s*\([^)]*cls\.kind\s*===\s*"network"[^)]*cls\.kind\s*===\s*"rate-limit"/;

  assert.ok(
    fallbackConditionRe.test(src) || fallbackConditionReAlt.test(src),
    'rate-limit must appear in the same if-condition as network/server for model fallback (#2770)',
  );
});

test("rate-limit errors are NOT short-circuited to pause before model fallback", () => {
  const src = getRecoverySource();

  // The old code had a dedicated rate-limit early-return block before the fallback block.
  // Verify it no longer exists.
  const earlyRateLimitPause = /if\s*\(\s*cls\.kind\s*===\s*"rate-limit"\s*\)\s*\{[^}]*pauseTransientWithBackoff/;
  assert.ok(
    !earlyRateLimitPause.test(src),
    'rate-limit must NOT have a dedicated early pause before the model fallback path (#2770)',
  );
});

test("rate-limit errors hand the bounded cooldown to the auto loop if no fallback model is available", () => {
  const src = getRecoverySource();

  assert.ok(
    src.includes('cls.kind === "rate-limit"'),
    'agent-end-recovery.ts must reference cls.kind === "rate-limit" for the fallback path (#2770)',
  );

  // After the fallback block, a rate-limit resolves the unit as a transient
  // cancellation carrying retryAfterMs so the auto loop owns the cooldown
  // (#1908) instead of pausing the session here.
  const cooldownHandoffRe = /if\s*\(\s*cls\.kind\s*===\s*"rate-limit"\s*\)\s*\{[^}]*resolveAgentEndCancelled\([^)]*isTransient:\s*true[^)]*retryAfterMs:\s*cls\.retryAfterMs/;
  const handoff = cooldownHandoffRe.exec(src);
  assert.ok(
    handoff,
    'rate-limit must resolve the unit as a transient cancellation with retryAfterMs before the transient pause (#1908)',
  );
  assert.ok(
    handoff.index > src.indexOf("tryProviderModelFallback("),
    "the rate-limit cooldown handoff must come after the model fallback attempt (#2770)",
  );
});

test("other transient errors (server, connection, stream) still attempt model fallback", () => {
  const src = getRecoverySource();

  // All transient kinds must appear in the fallback condition.
  for (const kind of ["server", "connection", "stream"]) {
    assert.ok(
      src.includes(`cls.kind === "${kind}"`),
      `model fallback condition must include cls.kind === "${kind}"`,
    );
  }
});

test("permanent errors still bypass model fallback and pause indefinitely", () => {
  const src = getRecoverySource();

  // The permanent/unknown error handler must exist and call pauseAutoForProviderError
  // with isTransient: false.
  const permanentPauseRe = /pauseAutoForProviderError[\s\S]{0,300}isTransient:\s*false/;
  assert.ok(
    permanentPauseRe.test(src),
    'permanent errors must pause with isTransient: false (no auto-resume)',
  );
});
