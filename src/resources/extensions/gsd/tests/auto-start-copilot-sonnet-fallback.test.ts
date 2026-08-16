// Regression guard: avoid noisy startup warning when Copilot temporarily
// omits claude-sonnet-5 from the live model catalog.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTO_START_PATH = join(import.meta.dirname, "..", "auto-start.ts");

function source(): string {
  return readFileSync(AUTO_START_PATH, "utf-8");
}

test("auto-start includes Copilot Sonnet fallback guard for preferred claude-sonnet-5", () => {
  const text = source();

  assert.match(
    text,
    /isCopilotProvider\s*&&\s*preferredIdLower\s*===\s*"claude-sonnet-5"/,
    "startup should special-case Copilot Sonnet-5 catalog lag",
  );

  assert.match(
    text,
    /\["claude-sonnet-4\.6",\s*"claude-sonnet-4\.5",\s*"claude-sonnet-4"\]/,
    "fallback chain should prefer nearest Copilot Sonnet variants",
  );

  assert.match(
    text,
    /is not currently exposed by Copilot; using .* for this session\./,
    "fallback path should emit an informational, explicit replacement notice",
  );
});
