import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalToolExecutor } from "./local-tool-executor.js";
import type { SessionManager } from "./session-manager.js";
import type { ProjectInfo } from "./types.js";

test("local tool executor rejects unsupported user-controlled tool names", async () => {
  const executor = new LocalToolExecutor({} as SessionManager, async () => []);

  await assert.rejects(
    executor.execute("constructor", {}),
    /Unsupported forwarded GSD MCP tool: constructor/,
  );
});

test("local tool executor rejects unadvertised project paths", async () => {
  const executor = new LocalToolExecutor({} as SessionManager, async () => []);

  await assert.rejects(
    executor.execute("gsd_progress", { projectDir: "/tmp/not-advertised" }),
    /Project is not advertised by the Local GSD Runtime: \/tmp\/not-advertised/,
  );
});

test("local tool executor resolves project aliases from scanned projects", async () => {
  const project: ProjectInfo = {
    name: "allowed-project",
    path: "/tmp/allowed-project",
    markers: ["git"],
    lastModified: Date.now(),
  };
  let startedProjectDir: string | undefined;
  const executor = new LocalToolExecutor({
    startSession: async ({ projectDir }: { projectDir: string }) => {
      startedProjectDir = projectDir;
      return "session-1";
    },
  } as SessionManager, async () => [project]);

  await executor.execute("gsd_execute", {
    projectDir: "/tmp/not-advertised",
  }, "allowed-project");

  assert.equal(startedProjectDir, project.path);
});

test("local tool executor forwards cloud blocker resolution", async () => {
  let resolved: { sessionId: string; response: string } | undefined;
  const executor = new LocalToolExecutor({
    resolveBlocker: async (sessionId: string, response: string) => {
      resolved = { sessionId, response };
    },
  } as SessionManager, async () => []);

  const result = await executor.execute("gsd_resolve_blocker", {
    sessionId: "session-1",
    response: "continue",
  });

  assert.deepEqual(resolved, { sessionId: "session-1", response: "continue" });
  assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify({ resolved: true }, null, 2) }] });
});

test("local tool executor forwards task recovery resume to the registered workflow handler", async () => {
  const executor = new LocalToolExecutor({} as SessionManager, async () => []);
  let forwarded: Record<string, unknown> | undefined;
  let forwardedExtra: Record<string, unknown> | undefined;
  const handlers = (executor as unknown as {
    workflowHandlers: Map<string, (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>>;
  }).workflowHandlers;
  handlers.set("gsd_task_recovery_resume", async (args, extra) => {
    forwarded = args;
    forwardedExtra = extra;
    return { resumed: true };
  });

  const result = await executor.execute("gsd_task_recovery_resume", {
    recoveryActionId: "recovery-action-1",
    repairSummary: "The defect was repaired.",
    evidence: { check: "passed" },
  }, undefined, "cloud-request-42");

  assert.deepEqual(forwarded, {
    recoveryActionId: "recovery-action-1",
    repairSummary: "The defect was repaired.",
    evidence: { check: "passed" },
  });
  assert.deepEqual(forwardedExtra, {
    _meta: { "io.opengsd/idempotency-key": "cloud-request-42" },
  });
  assert.deepEqual(result, { resumed: true });
});

test("local tool executor returns status payload with progress counters", async () => {
  const startedAt = Date.now() - 1234;
  const executor = new LocalToolExecutor({
    getSession: (sessionId: string) => sessionId === "session-1"
      ? {
          sessionId,
          status: "running",
          events: [
            { type: "message" },
            { type: "tool_use" },
            { type: "tool_execution_start" },
          ],
          pendingBlocker: null,
          cost: { totalCost: 0, tokens: { input: 0, output: 0 } },
          startTime: startedAt,
        }
      : undefined,
  } as unknown as SessionManager, async () => []);

  const result = await executor.execute("gsd_status", { sessionId: "session-1" });
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  const status = JSON.parse(text) as { status: string; progress: { eventCount: number; toolCalls: number } };

  assert.equal(status.status, "running");
  assert.deepEqual(status.progress, { eventCount: 3, toolCalls: 2 });
});

test("local tool executor returns gsd_query project-state payload", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-query-project-"));
  const gsdDir = join(projectDir, ".gsd");
  mkdirSync(join(gsdDir, "milestones", "M001"), { recursive: true });
  writeFileSync(join(gsdDir, "STATE.md"), "state text");
  writeFileSync(join(gsdDir, "PROJECT.md"), "project text");
  writeFileSync(join(gsdDir, "REQUIREMENTS.md"), "requirements text");
  writeFileSync(join(gsdDir, "milestones", "M001", "M001-ROADMAP.md"), "roadmap text");

  const project: ProjectInfo = {
    name: "query-project",
    path: projectDir,
    markers: ["git"],
    lastModified: Date.now(),
  };
  const executor = new LocalToolExecutor({} as SessionManager, async () => [project]);

  const result = await executor.execute("gsd_query", { projectDir });
  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  const query = JSON.parse(text) as {
    state: string;
    project: string;
    requirements: string;
    milestones: Array<{ id: string; hasRoadmap: boolean; hasSummary: boolean }>;
  };

  assert.equal(query.state, "state text");
  assert.equal(query.project, "project text");
  assert.equal(query.requirements, "requirements text");
  assert.deepEqual(query.milestones, [{ id: "M001", hasRoadmap: true, hasSummary: false }]);
});

test("local tool executor forwards unified graph tool modes", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "gsd-graph-project-"));
  const project: ProjectInfo = {
    name: "graph-project",
    path: projectDir,
    markers: ["git"],
    lastModified: Date.now(),
  };
  const executor = new LocalToolExecutor({} as SessionManager, async () => [project]);

  const result = await executor.execute("gsd_graph", {
    projectDir,
    mode: "status",
  });

  const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
  assert.equal(typeof JSON.parse(text), "object");
});
