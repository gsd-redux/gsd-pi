/**
 * Regression tests for memory pressure monitoring (#3331) in auto/loop.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { decideMemoryPressure } from "../auto/workflow-kernel.ts";
import { measureMemoryPressure } from "../auto/workflow-memory-pressure.ts";

describe("memory pressure monitoring (#3331)", () => {
  test("measureMemoryPressure reports pressure above threshold", () => {
    const snapshot = measureMemoryPressure({
      threshold: 0.5,
      deps: {
        memoryUsage: () => ({ heapUsed: 768 * 1024 * 1024 }),
        heapLimitBytes: () => 1024 * 1024 * 1024,
      },
    });

    assert.equal(snapshot.pressured, true);
    assert.equal(snapshot.heapMB, 768);
    assert.equal(snapshot.limitMB, 1024);
  });

  test("measureMemoryPressure defaults to a sub-100-percent threshold", () => {
    const snapshot = measureMemoryPressure({
      deps: {
        memoryUsage: () => ({ heapUsed: 3584 * 1024 * 1024 }),
        heapLimitBytes: () => 4096 * 1024 * 1024,
      },
    });

    assert.equal(snapshot.pressured, true);
  });

  test("memory pressure triggers graceful stopAuto", () => {
    const decision = decideMemoryPressure({
      pressured: true,
      heapMB: 3900,
      limitMB: 4096,
      pct: 0.95,
      iteration: 10,
    });

    assert.equal(decision.action, "stop");
    assert.match(decision.stopMessage, /Stopping gracefully to prevent OOM/);
  });
});
