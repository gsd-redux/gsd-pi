// Project/App: gsd-pi
// File Purpose: Proves Pi Slice lifecycle aliases share canonical private executor identity.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = fileURLToPath(
  new URL("./fixtures/slice-lifecycle-executor-capture.ts", import.meta.url),
);
process.env.GSD_ADVERTISE_TOOL_ALIASES = "1";

import { registerDbTools } from "../bootstrap/db-tools.ts";
import {
  readCapturedSliceLifecycleCalls,
  resetCapturedSliceLifecycleCalls,
} from "./fixtures/slice-lifecycle-executor-capture.ts";

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ): Promise<Record<string, unknown>>;
}

function registeredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerDbTools({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  return tools;
}

afterEach(() => {
  resetCapturedSliceLifecycleCalls();
});

test("Pi canonical and alias Slice lifecycle calls share canonical executor identity", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-slice-executor-identity-"));
  try {
    const tools = registeredTools();
    const cases = [
      {
        names: ["gsd_slice_complete", "gsd_complete_slice"],
        executor: "complete",
        canonicalName: "gsd_slice_complete",
        params: {
          milestoneId: "M001",
          sliceId: "S01",
          sliceTitle: "Identity",
          oneLiner: "One executor call",
          narrative: "The adapter preserves private identity.",
          uatContent: "## UAT\n\nPASS",
        },
      },
      {
        names: ["gsd_slice_reopen", "gsd_reopen_slice"],
        executor: "reopen",
        canonicalName: "gsd_slice_reopen",
        params: { milestoneId: "M001", sliceId: "S01", reason: "Redo the Slice." },
      },
      {
        names: ["gsd_skip_slice"],
        executor: "skip",
        canonicalName: "gsd_skip_slice",
        params: { milestoneId: "M001", sliceId: "S01", reason: "Descoped." },
      },
    ] as const;

    for (const entry of cases) {
      for (const name of entry.names) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} must be registered`);
        await tool.execute("shared-call-42", entry.params, undefined, undefined, { cwd: basePath });
      }
    }

    const calls = readCapturedSliceLifecycleCalls();
    assert.equal(calls.length, 5, "all canonical and alias calls must reach the shared executors");
    for (const entry of cases) {
      const matching = calls.filter((call) => call.executor === entry.executor);
      assert.equal(matching.length, entry.names.length);
      for (const call of matching) {
        assert.equal(realpathSync(call.basePath), realpathSync(basePath));
        assert.deepEqual(call.invocation, {
          idempotencyKey: `pi:${entry.canonicalName}:shared-call-42`,
          sourceTransport: "pi-tool",
          actorType: "agent",
          traceId: "shared-call-42",
        });
      }
    }
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
