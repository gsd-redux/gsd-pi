import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE = new URL(
  "../tools/workflow-tool-executors.ts",
  import.meta.url,
).pathname;

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";
import {
  closeDatabase,
  getDb,
  openDatabase,
} from "../mcp-bridge.ts";
import { insertRequirement, getDbPath } from "../gsd-db.ts";
import { resolveProjectRootDbPath } from "../db-workspace.ts";
import { invalidateAllCaches } from "../cache.ts";

type NativeTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<Record<string, unknown>>;
};

type McpTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function makeProjectBase(prefix: string): string {
  const base = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(basePaths: string[]): void {
  try {
    closeDatabase();
  } catch {
    // noop
  }
  invalidateAllCaches();
  for (const base of basePaths) {
    rmSync(base, { recursive: true, force: true });
  }
}

function makeNativeTools(): NativeTool[] {
  const tools: NativeTool[] = [];
  registerDbTools({
    registerTool(tool: NativeTool) {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerDbTools>[0]);
  return tools;
}

function makeMcpTools(): McpTool[] {
  const tools: McpTool[] = [];
  registerWorkflowTools({
    tool(name: string, _description: string, _params: Record<string, unknown>, handler: McpTool["handler"]) {
      tools.push({ name, handler });
    },
  } as Parameters<typeof registerWorkflowTools>[0]);
  return tools;
}

function nativeTool(tools: NativeTool[], name: string): NativeTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function mcpTool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function readError(result: Record<string, unknown>): string | undefined {
  const details = result.details as Record<string, unknown> | undefined;
  return typeof details?.error === "string" ? (details.error as string) : undefined;
}

function seedRequirement(id: string, description: string): void {
  insertRequirement({
    id,
    class: "core-capability",
    status: "active",
    description,
    why: "regression",
    source: "test",
    primary_owner: "M001/S01",
    supporting_slices: "",
    validation: "n/a",
    notes: "",
    full_content: `- [ ] **${id}: ${description}**`,
    superseded_by: null,
  });
}

test("canonical read tools: missing DB returns db_unavailable and does not create gsd.db", async () => {
  const base = makeProjectBase("gsd-canonical-missing-db");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();
    const dbPath = resolveProjectRootDbPath(base);

    assert.equal(existsSync(dbPath), false, "fixture starts without gsd.db");

    const nativeList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-1",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeList as { details?: Record<string, unknown> }).details;
    assert.equal(nativeDetails?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "native read should not create gsd.db as side effect");

    const mcpList = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });
    const mcpDetails = (mcpList as { details?: Record<string, unknown> }).details;
    assert.equal(mcpDetails?.error, "db_unavailable");
    assert.equal(existsSync(dbPath), false, "MCP read should not create gsd.db as side effect");
  } finally {
    cleanup([base]);
  }
});

test("canonical read tools: reading project B does not switch global DB handle from project A", async () => {
  const baseA = makeProjectBase("gsd-canonical-global-a");
  const baseB = makeProjectBase("gsd-canonical-global-b");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(baseA));
    seedRequirement("R101", "A requirement");

    openDatabase(resolveProjectRootDbPath(baseB));
    seedRequirement("R201", "B requirement");

    openDatabase(resolveProjectRootDbPath(baseA));
    const before = getDbPath();
    assert.ok(before, "global DB should be open on project A");

    const nativeList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-2",
      { limit: 10 },
      undefined,
      undefined,
      { cwd: baseB },
    );
    const nativeCount = ((nativeList as { details?: { count?: number } }).details?.count ?? -1);
    assert.equal(nativeCount, 1, "native isolated read should query project B rows");
    assert.equal(getDbPath(), before, "native isolated read must keep global DB path unchanged");

    const mcpList = await mcpTool(mcp, "gsd_requirement_list").handler({
      projectDir: baseB,
      limit: 10,
    });
    const mcpCount = ((mcpList as { details?: { count?: number } }).details?.count ?? -1);
    assert.equal(mcpCount, 1, "MCP isolated read should query project B rows");
    assert.equal(getDbPath(), before, "MCP isolated read must keep global DB path unchanged");
  } finally {
    cleanup([baseA, baseB]);
  }
});

test("canonical read tools: query_error returns structured error and does not break subsequent isolated reads", async () => {
  const base = makeProjectBase("gsd-canonical-query-error");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();
    const dbPath = resolveProjectRootDbPath(base);

    openDatabase(dbPath);
    const db = (await import("../gsd-db.ts"))._getAdapter();
    assert.ok(db, "adapter should be available");
    db.prepare("DROP TABLE requirements").run();

    const nativeResult = await nativeTool(native, "gsd_requirement_list").execute(
      "call-3",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeDetails = (nativeResult as { details?: Record<string, unknown> }).details;
    assert.equal(nativeDetails?.error, "query_error");

    const mcpResult = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });
    const mcpDetails = (mcpResult as { details?: Record<string, unknown> }).details;
    assert.equal(mcpDetails?.error, "query_error");

    const isolated = (await import("../db-workspace.ts")).openWorkflowDatabaseIsolated(dbPath);
    assert.ok(isolated, "isolated open should still work after handled query_error");
    isolated?.close();
  } finally {
    cleanup([base]);
  }
});

test("canonical read tools: native and MCP read the same canonical requirement row", async () => {
  const base = makeProjectBase("gsd-canonical-parity");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    seedRequirement("R777", "Parity requirement");

    const nativeGet = await nativeTool(native, "gsd_requirement_get").execute(
      "call-4",
      { id: "R777" },
      undefined,
      undefined,
      { cwd: base },
    );
    const nativeRequirement = (nativeGet as { details?: { requirement?: Record<string, unknown> } }).details?.requirement;

    const mcpGet = await mcpTool(mcp, "gsd_requirement_get").handler({
      projectDir: base,
      id: "R777",
    });
    const mcpRequirement = (mcpGet as { details?: { requirement?: Record<string, unknown> } }).details?.requirement;

    assert.equal(nativeRequirement?.id, "R777");
    assert.equal(mcpRequirement?.id, "R777");
    assert.equal(nativeRequirement?.description, "Parity requirement");
    assert.equal(mcpRequirement?.description, "Parity requirement");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: empty valid DB returns consistent empty list semantics", async () => {
  const base = makeProjectBase("gsd-canonical-empty-db");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    assert.ok(openDatabase(resolveProjectRootDbPath(base)), "fixture database should open successfully");

    const nativeList = await nativeTool(native, "gsd_decision_list").execute(
      "call-5",
      { limit: 20 },
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpList = await mcpTool(mcp, "gsd_decision_list").handler({
      projectDir: base,
      limit: 20,
    });

    const nativeDetails = nativeList.details as { count?: number; error?: string } | undefined;
    const mcpDetails = mcpList.details as { count?: number; error?: string } | undefined;

    assert.equal(nativeDetails?.error, undefined);
    assert.equal(mcpDetails?.error, undefined);
    assert.equal(nativeDetails?.count, 0);
    assert.equal(mcpDetails?.count, 0);
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: unknown ID returns not_found for native and MCP", async () => {
  const base = makeProjectBase("gsd-canonical-unknown-id");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    assert.ok(openDatabase(resolveProjectRootDbPath(base)), "fixture database should open successfully");

    const nativeGet = await nativeTool(native, "gsd_requirement_get").execute(
      "call-6",
      { id: "R999" },
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpGet = await mcpTool(mcp, "gsd_requirement_get").handler({
      projectDir: base,
      id: "R999",
    });

    assert.equal(readError(nativeGet), "not_found");
    assert.equal(readError(mcpGet), "not_found");
  } finally {
    cleanup([base]);
  }
});

test("canonical read parity: corrupt requirements table returns query_error for native and MCP", async () => {
  const base = makeProjectBase("gsd-canonical-query-error-parity");
  try {
    const native = makeNativeTools();
    const mcp = makeMcpTools();

    openDatabase(resolveProjectRootDbPath(base));
    const db = getDb();
    db.prepare("DROP TABLE requirements").run();

    const nativeReqList = await nativeTool(native, "gsd_requirement_list").execute(
      "call-7",
      {},
      undefined,
      undefined,
      { cwd: base },
    );
    const mcpReqList = await mcpTool(mcp, "gsd_requirement_list").handler({ projectDir: base });

    assert.equal(readError(nativeReqList), "query_error");
    assert.equal(readError(mcpReqList), "query_error");
  } finally {
    cleanup([base]);
  }
});
