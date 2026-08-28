import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateContent } from "../safety/content-validator.ts";

function makeTempFile(content: string): { base: string; path: string } {
  const base = mkdtempSync(join(tmpdir(), "gsd-content-validator-"));
  mkdirSync(base, { recursive: true });
  const path = join(base, "artifact.md");
  writeFileSync(path, content, "utf-8");
  return { base, path };
}

test("validateContent marks empty milestone roadmaps as blocking", () => {
  const { base, path } = makeTempFile([
    "# M004: Empty roadmap",
    "",
    "## Slices",
    "",
    "_TBD_",
    "",
  ].join("\n"));

  try {
    const violations = validateContent("plan-milestone", path);
    assert.deepEqual(violations, [{
      severity: "error",
      reason: "Milestone roadmap has 0 slice(s) — expected at least 1",
    }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateContent accepts checkbox milestone roadmap slices", () => {
  const { base, path } = makeTempFile([
    "# M004: Roadmap",
    "",
    "## Slices",
    "",
    "- [ ] **S01: Browser due dates** `risk:low` `depends:[]`",
    "  > After this: due dates are visible.",
    "",
  ].join("\n"));

  try {
    const violations = validateContent("plan-milestone", path);
    assert.deepEqual(violations, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateContent marks empty slice plans as blocking", () => {
  const { base, path } = makeTempFile([
    "# S01: Empty slice",
    "",
    "## Tasks",
    "",
    "_TBD_",
    "",
  ].join("\n"));

  try {
    const violations = validateContent("plan-slice", path);
    assert.equal(violations[0]?.severity, "error");
    assert.equal(violations[0]?.reason, "Slice plan has 0 task(s) — expected at least 1");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validateContent accepts slice-qualified task IDs", (t) => {
  for (const taskId of ["S07-T01", "S07.T01"]) {
    const { base, path } = makeTempFile([
      "# S07: Qualified tasks",
      "",
      "## Tasks",
      "",
      `- [ ] **${taskId}**: Implement the fix`,
      "",
      "## Files",
      "",
      "- `src/example.ts`",
      "",
      "Verify: pnpm test",
      "",
    ].join("\n"));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    assert.deepEqual(validateContent("plan-slice", path), [], taskId);
  }
});
