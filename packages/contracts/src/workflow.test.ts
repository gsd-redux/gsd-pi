import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_TOOL_CONTRACTS, WORKFLOW_TOOL_NAMES } from "./workflow.js";

test("workflow contracts have unique canonical names", () => {
  const names = WORKFLOW_TOOL_CONTRACTS.map((tool) => tool.canonicalName);
  assert.equal(new Set(names).size, names.length);
});

test("workflow aliases map back to known canonical tools", () => {
  for (const tool of WORKFLOW_TOOL_CONTRACTS) {
    for (const alias of tool.aliases) {
      assert.ok(WORKFLOW_TOOL_NAMES.includes(alias), `missing alias ${alias}`);
    }
    assert.match(tool.schemaId, /^workflow\./);
    assert.match(tool.auditEvent, /^workflow\./);
  }
});

test("read-only workflow tools are classified correctly", () => {
  const readOnly = WORKFLOW_TOOL_CONTRACTS.filter((tool) => tool.writePolicy === "read");
  assert.ok(readOnly.some((tool) => tool.canonicalName === "gsd_milestone_status"));
  assert.ok(readOnly.some((tool) => tool.canonicalName === "gsd_checkpoint_db"));
  assert.ok(readOnly.some((tool) => tool.canonicalName === "gsd_project_snapshot"));
  assert.ok(readOnly.every((tool) => tool.writePolicy === "read"));
});
