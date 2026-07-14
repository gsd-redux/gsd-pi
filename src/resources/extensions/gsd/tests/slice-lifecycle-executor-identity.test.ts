// Project/App: gsd-pi
// File Purpose: Proves Pi lifecycle aliases share canonical private executor identity.

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
  readCapturedLifecycleCalls,
  resetCapturedLifecycleCalls,
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
  resetCapturedLifecycleCalls();
});

test("Pi canonical and alias lifecycle calls share canonical executor identity", async (t) => {
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
      {
        names: ["gsd_validate_milestone", "gsd_milestone_validate"],
        executor: "validate",
        canonicalName: "gsd_validate_milestone",
        params: {
          milestoneId: "M001",
          verdict: "pass",
          remediationRound: 0,
          successCriteriaChecklist: "- [x] Complete",
          sliceDeliveryAudit: "| S01 | pass |",
          crossSliceIntegration: "Passed",
          requirementCoverage: "Covered",
          verdictRationale: "Current structured evidence passed.",
          verificationEvidence: [{
            verificationClass: "UAT",
            evidenceClass: "browser",
            rationale: "The browser journey passed.",
            commandOrTool: "gsd-browser",
            workingDirectory: basePath,
            startedAt: "2026-07-14T12:00:00.000Z",
            endedAt: "2026-07-14T12:01:00.000Z",
            observation: "passed",
            durableOutputRef: "artifact://uat/browser-run",
            testedSourceRevision: "sha256:tested-source",
            environment: { browser: "chromium" },
          }],
        },
      },
      {
        names: ["gsd_complete_milestone", "gsd_milestone_complete"],
        executor: "milestone-complete",
        canonicalName: "gsd_complete_milestone",
        params: {
          milestoneId: "M001",
          title: "Identity",
          oneLiner: "One completion operation",
          narrative: "The adapter preserves private identity.",
          verificationPassed: true,
        },
      },
      {
        names: ["gsd_milestone_reopen", "gsd_reopen_milestone"],
        executor: "milestone-reopen",
        canonicalName: "gsd_milestone_reopen",
        params: { milestoneId: "M001", reason: "Redo the Milestone." },
      },
    ] as const;

    for (const entry of cases) {
      await t.test(`${entry.canonicalName} canonicalizes private identity`, async () => {
        for (const name of entry.names) {
          const tool = tools.find((candidate) => candidate.name === name);
          assert.ok(tool, `${name} must be registered`);
          await tool.execute("shared-call-42", entry.params, undefined, undefined, { cwd: basePath });
        }

        const matching = readCapturedLifecycleCalls().filter(
          (call) => call.executor === entry.executor,
        );
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
      });
    }
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
