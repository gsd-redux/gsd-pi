// Covers the local workspace navigation registry.

import { test } from "node:test";
import assert from "node:assert/strict";

import { NAV_ITEMS } from "../workspace-nav.ts";

test("keeps the local workspace views in their established order", () => {
  const ids = NAV_ITEMS.map((item) => item.id);
  assert.deepEqual(ids, ["dashboard", "power", "chat", "roadmap", "files", "activity", "visualize"]);
  assert.equal(new Set(ids).size, ids.length);
});
