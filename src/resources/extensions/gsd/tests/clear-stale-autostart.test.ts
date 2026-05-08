/**
 * clear-stale-autostart.test.ts — #3667
 *
 * Pending auto-start entries carry a createdAt timestamp so later /gsd
 * invocations can distinguish an in-flight discussion from a stale one.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _getPendingAutoStart,
  clearPendingAutoStart,
  setPendingAutoStart,
} from "../guided-flow.ts";

afterEach(() => {
  clearPendingAutoStart();
});

describe("clear stale pending auto-start (#3667)", () => {
  test("setPendingAutoStart defaults createdAt to Date.now()", (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pending-autostart-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const before = Date.now();

    setPendingAutoStart(base, { basePath: base, milestoneId: "M001" });

    const entry = _getPendingAutoStart(base);
    assert.ok(entry);
    assert.equal(typeof entry!.createdAt, "number");
    assert.ok(entry!.createdAt >= before);
  });

  test("setPendingAutoStart preserves explicit createdAt for stale-entry checks", (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pending-autostart-old-")));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(base, ".gsd"), { recursive: true });

    setPendingAutoStart(base, { basePath: base, milestoneId: "M001", createdAt: 123 });

    assert.equal(_getPendingAutoStart(base)?.createdAt, 123);
  });
});
