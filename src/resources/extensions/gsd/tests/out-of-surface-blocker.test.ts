import test from "node:test";
import assert from "node:assert/strict";

import {
  extractBlockerCategory,
  OUT_OF_SURFACE_TOOL_BLOCKER,
  outOfSurfaceBlockerGuidance,
  routeBlockerCategory,
} from "../out-of-surface-blocker.ts";

test("extractBlockerCategory finds the named out-of-surface category (#1693)", () => {
  assert.equal(extractBlockerCategory("Need gsd_requirement_update"), undefined);
  assert.equal(
    extractBlockerCategory("blockerCategory: out-of-surface-tool"),
    OUT_OF_SURFACE_TOOL_BLOCKER,
  );
  assert.equal(
    extractBlockerCategory(undefined, "OUT-OF-SURFACE-TOOL required"),
    OUT_OF_SURFACE_TOOL_BLOCKER,
  );
});

test("routeBlockerCategory sends out-of-surface-tool to surface-widen, not replan", () => {
  assert.equal(routeBlockerCategory(undefined), "replan");
  assert.equal(routeBlockerCategory("reject-escalation"), "replan");
  assert.equal(routeBlockerCategory(OUT_OF_SURFACE_TOOL_BLOCKER), "surface-widen");
});

test("out-of-surface guidance names the category and avoids a burned retry", () => {
  const text = outOfSurfaceBlockerGuidance("T01", "S01");
  assert.match(text, /out-of-surface-tool/);
  assert.match(text, /Do not retry the same unit/);
  assert.match(text, /Widen the unit tool contract|replan slice S01/);
  assert.match(text, /\/gsd auto/);
});
