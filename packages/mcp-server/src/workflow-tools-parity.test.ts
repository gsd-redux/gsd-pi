// Project/App: gsd-pi
// File Purpose: Parity tests for GSD workflow task completion over native and MCP transports.
// ADR-008 validation criterion #3 — behavior-parity lock-in for gsd_task_complete.
//
// ADR-008 §1 ("One handler layer, multiple transports") is shipped: both
// native (`db-tools.ts`) and MCP (`workflow-tools.ts`) registrations wrap the
// same `executeTaskComplete` from `workflow-tool-executors.ts`. This test
// guards the equivalence so a future executor refactor cannot silently drift
// the two transports apart.
//
// Strategy: run the same completion against two equivalent fresh basePaths,
// one via the native path (direct call to the shared executor — which is
// faithfully what `db-tools.ts:670-674` does after `resolveCtxCwd`) and one
// via the MCP path (`registerWorkflowTools` + tool.handler). Snapshot DB row,
// summary file content, and journal events for each. Assert equivalence
// modulo expected diffs (timestamps).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  closeDatabase,
  getTask,
  openDatabase,
  _getAdapter,
} from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { registerDbTools } from "../../../src/resources/extensions/gsd/bootstrap/db-tools.ts";
import {
  executeTaskComplete,
  executeSummarySave,
  executeMilestoneStatus,
} from "../../../src/resources/extensions/gsd/tools/workflow-tool-executors.ts";
import { registerWorkflowTools } from "./workflow-tools.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-mcp-parity-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function seedMilestoneAndSlice(base: string): void {
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
    "utf-8",
  );
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    // swallow
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

function makeMockServer() {
  const tools: Array<{
    name: string;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  return {
    tools,
    tool(
      name: string,
      _description: string,
      _params: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      tools.push({ name, handler });
    },
  };
}

function seedMilestoneRow(base: string, milestoneId = "M001"): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, "Parity milestone", "active", new Date().toISOString());
}

async function runNativeDbTool(
  base: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const registrations: Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
  }> = [];
  registerDbTools({
    registerTool(tool: (typeof registrations)[number]) {
      registrations.push(tool);
    },
  } as Parameters<typeof registerDbTools>[0]);
  const tool = registrations.find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`native db tool ${toolName} not registered`);
  return tool.execute("parity-call", args, undefined, undefined, { cwd: base });
}

async function runNativeAndMcpParity(input: {
  toolName: string;
  args: Record<string, unknown>;
  seed: (base: string) => void;
  assertEquivalent: (ctx: {
    nativeBase: string;
    mcpBase: string;
    nativeResult: unknown;
    mcpResult: unknown;
  }) => void;
  nativeRun?: (base: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  let baseNative = "";
  let baseMcp = "";
  try {
    baseNative = makeTmpBase();
    input.seed(baseNative);
    const nativeResult = input.nativeRun
      ? await input.nativeRun(baseNative, input.args)
      : await runNativeDbTool(baseNative, input.toolName, input.args);
    assert.ok(!(nativeResult as { isError?: boolean }).isError, `native ${input.toolName} must succeed`);
    closeDatabase();

    baseMcp = makeTmpBase();
    input.seed(baseMcp);
    const server = makeMockServer();
    registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
    const mcpTool = server.tools.find((entry) => entry.name === input.toolName);
    assert.ok(mcpTool, `${input.toolName} must be registered on MCP`);
    const mcpResult = await mcpTool.handler({ projectDir: baseMcp, ...input.args });
    assert.ok(!(mcpResult as { isError?: boolean }).isError, `mcp ${input.toolName} must succeed`);

    input.assertEquivalent({ nativeBase: baseNative, mcpBase: baseMcp, nativeResult, mcpResult });
  } finally {
    if (baseNative) cleanup(baseNative);
    if (baseMcp) cleanup(baseMcp);
  }
}


interface SnapshotShape {
  /** SUMMARY.md content, trimmed, with ISO timestamps replaced by a sentinel. */
  summary: string;
  /** Task row, with volatile fields (timestamps, derived ids) elided. */
  taskRow: Record<string, unknown>;
  /** Journal events for this completion, with timestamps and ids normalized. */
  journalEvents: Array<{ cmd: string; params: Record<string, unknown>; actor: string }>;
}

const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function normalizeTimestamps(text: string): string {
  return text.replace(ISO_TIMESTAMP_RE, "<NORMALIZED-TS>");
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  // Recursively replace ISO timestamps in any string value so the deep-equal
  // doesn't fail on `ts`/`completed_at` style fields nested in the payload.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      out[k] = normalizeTimestamps(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string"
          ? normalizeTimestamps(item)
          : item && typeof item === "object"
            ? normalizeParams(item as Record<string, unknown>)
            : item,
      );
    } else if (v !== null && typeof v === "object") {
      out[k] = normalizeParams(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function snapshotState(base: string, milestoneId: string, sliceId: string, taskId: string): SnapshotShape {
  const summaryPath = join(base, ".gsd", "milestones", milestoneId, "slices", sliceId, "tasks", `${taskId}-SUMMARY.md`);
  assert.ok(existsSync(summaryPath), `summary file must exist at ${summaryPath}`);
  const summary = normalizeTimestamps(readFileSync(summaryPath, "utf-8").trim());

  const row = getTask(milestoneId, sliceId, taskId);
  assert.ok(row, "task row must exist in DB after completion");
  // Recursively normalize ISO timestamps in the row (the SQLite row uses
  // snake_case `completed_at` and embeds another ISO timestamp inside the
  // string field `full_summary_md`). Recursive normalization is simpler and
  // more robust than maintaining an elision list.
  const taskRow = normalizeParams(row as Record<string, unknown>);
  assert.equal(taskRow.status, "complete", "task status must be 'complete' after completion");

  const journalPath = join(base, ".gsd", "event-log.jsonl");
  const journalEvents: SnapshotShape["journalEvents"] = [];
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as { cmd: string; params: Record<string, unknown>; actor: string };
        if (evt.cmd === "complete-task" || evt.cmd === "complete_task") {
          // Normalize cmd to canonical hyphen form, and elide ISO timestamps
          // in the payload so the wall-clock skew between the two runs doesn't
          // produce a spurious diff.
          journalEvents.push({
            cmd: "complete-task",
            params: normalizeParams(evt.params),
            actor: evt.actor,
          });
        }
      } catch {
        // Skip corrupted lines — non-fatal for parity comparison.
      }
    }
  }

  return { summary, taskRow, journalEvents };
}

const COMPLETION_ARGS = {
  taskId: "T01",
  sliceId: "S01",
  milestoneId: "M001",
  oneLiner: "Completed the demo task",
  narrative: "Did the work described in the plan. Verified by running the test suite.",
  verification: "npm test — all passing",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/demo.ts"],
  keyDecisions: ["Used Option A from the plan."],
};

const workflowBridgeExtension = import.meta.url.includes("/dist-test/") ? "js" : "ts";
process.env.GSD_WORKFLOW_EXECUTORS_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/tools/workflow-tool-executors.${workflowBridgeExtension}`,
  import.meta.url,
));
process.env.GSD_WORKFLOW_WRITE_GATE_MODULE ??= fileURLToPath(new URL(
  `../../../src/resources/extensions/gsd/bootstrap/write-gate.${workflowBridgeExtension}`,
  import.meta.url,
));

describe("ADR-008 parity: gsd_task_complete native vs MCP", () => {
  it("native and MCP produce equivalent DB row, summary, and journal event", async () => {
    let baseNative = "";
    let baseMcp = "";
    try {
      // ─── Native path ─────────────────────────────────────────────────
      // The native wrapper in db-tools.ts:670-674 is:
      //   const taskCompleteExecute = async (_tcid, params, ...) => {
      //     const { executeTaskComplete } = await loadWorkflowExecutors();
      //     return executeTaskComplete(params, resolveCtxCwd(_ctx));
      //   };
      // Calling executeTaskComplete directly with a basePath is the same
      // post-resolution call shape.
      baseNative = makeTmpBase();
      seedMilestoneAndSlice(baseNative);
      const nativeResult = await executeTaskComplete(COMPLETION_ARGS, baseNative);
      assert.ok(!nativeResult.isError, "native completion must succeed");

      const snapshotNative = snapshotState(baseNative, "M001", "S01", "T01");
      closeDatabase();

      // ─── MCP path ────────────────────────────────────────────────────
      baseMcp = makeTmpBase();
      seedMilestoneAndSlice(baseMcp);

      const server = makeMockServer();
      registerWorkflowTools(server as Parameters<typeof registerWorkflowTools>[0]);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "gsd_task_complete must be registered on the MCP surface");

      const mcpResult = await taskTool.handler({ projectDir: baseMcp, ...COMPLETION_ARGS });
      assert.ok(!mcpResult.isError, "mcp completion must succeed");

      const snapshotMcp = snapshotState(baseMcp, "M001", "S01", "T01");

      // ─── Compare ─────────────────────────────────────────────────────
      assert.equal(
        snapshotNative.summary,
        snapshotMcp.summary,
        "SUMMARY.md content must be byte-equal between native and MCP completions",
      );

      assert.deepEqual(
        snapshotNative.taskRow,
        snapshotMcp.taskRow,
        "tasks DB row (modulo volatile timestamps and ids) must be equal",
      );

      // Journal event count must match (1 complete-task event per completion).
      assert.equal(
        snapshotNative.journalEvents.length,
        snapshotMcp.journalEvents.length,
        "both transports must emit the same number of complete-task journal events",
      );

      // Each journal event's params must match (these encode the completion
      // payload; cmd is normalized and actor must align).
      for (let i = 0; i < snapshotNative.journalEvents.length; i++) {
        assert.equal(
          snapshotNative.journalEvents[i].actor,
          snapshotMcp.journalEvents[i].actor,
          `journal event #${i} actor must match between native and MCP`,
        );
        assert.deepEqual(
          snapshotNative.journalEvents[i].params,
          snapshotMcp.journalEvents[i].params,
          `journal event #${i} params must match between native and MCP`,
        );
      }
    } finally {
      if (baseNative) cleanup(baseNative);
      if (baseMcp) cleanup(baseMcp);
    }
  });
});

const SUMMARY_SAVE_ARGS = {
  milestone_id: "M001",
  slice_id: "S01",
  artifact_type: "SUMMARY",
  content: "# Summary\n\nparity matrix artifact",
};

const DECISION_SAVE_ARGS = {
  scope: "global",
  decision: "Use matrix parity tests",
  choice: "Extend workflow-tools-parity.test.ts",
  rationale: "Lock native/MCP DB write equivalence",
  revisable: "yes",
};

describe("ADR-008 parity: shared workflow write tools native vs MCP", () => {
  it("gsd_summary_save writes identical artifact files", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_summary_save",
      args: SUMMARY_SAVE_ARGS,
      seed: (base) => {
        mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      },
      nativeRun: (base, args) => executeSummarySave(args as Parameters<typeof executeSummarySave>[0], base),
      assertEquivalent: ({ nativeBase, mcpBase }) => {
        const rel = "milestones/M001/slices/S01/S01-SUMMARY.md";
        const nativePath = join(nativeBase, ".gsd", rel);
        const mcpPath = join(mcpBase, ".gsd", rel);
        assert.ok(existsSync(nativePath), "native summary artifact must exist");
        assert.ok(existsSync(mcpPath), "mcp summary artifact must exist");
        assert.equal(
          normalizeTimestamps(readFileSync(nativePath, "utf-8").trim()),
          normalizeTimestamps(readFileSync(mcpPath, "utf-8").trim()),
          "summary artifact content must match between transports",
        );
      },
    });
  });

  it("gsd_milestone_status returns equivalent milestone metadata", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_milestone_status",
      args: { milestoneId: "M001" },
      seed: seedMilestoneRow,
      nativeRun: (base, args) =>
        executeMilestoneStatus(args as Parameters<typeof executeMilestoneStatus>[0], base),
      assertEquivalent: ({ nativeResult, mcpResult }) => {
        const nativeDetails = normalizeParams(
          ((nativeResult as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>,
        );
        const mcpDetails = normalizeParams(
          ((mcpResult as { structuredContent?: Record<string, unknown> }).structuredContent
            ?? (mcpResult as { details?: Record<string, unknown> }).details
            ?? {}) as Record<string, unknown>,
        );
        assert.deepEqual(nativeDetails, mcpDetails, "milestone status details must match between transports");
      },
    });
  });

  it("gsd_decision_save persists equivalent decision rows", async () => {
    await runNativeAndMcpParity({
      toolName: "gsd_decision_save",
      args: {
        ...DECISION_SAVE_ARGS,
        when_context: "parity matrix",
        made_by: "agent",
      },
      seed: (base) => {
        openDatabase(join(base, ".gsd", "gsd.db"));
        closeDatabase();
      },
      assertEquivalent: ({ nativeBase, mcpBase }) => {
        const nativeDecisions = join(nativeBase, ".gsd", "DECISIONS.md");
        const mcpDecisions = join(mcpBase, ".gsd", "DECISIONS.md");
        assert.ok(existsSync(nativeDecisions), "native DECISIONS.md must exist");
        assert.ok(existsSync(mcpDecisions), "mcp DECISIONS.md must exist");
        assert.equal(
          normalizeTimestamps(readFileSync(nativeDecisions, "utf-8").trim()),
          normalizeTimestamps(readFileSync(mcpDecisions, "utf-8").trim()),
          "DECISIONS.md must match between transports",
        );
      },
    });
  });
});
