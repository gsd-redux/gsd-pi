// Project/App: gsd-pi
// File Purpose: Cross-mode native Pi/workflow MCP semantic-shadow convergence proof.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  registerWorkflowTools,
  resolveMilestoneStatusObservationTokenState,
} from "../../../../../packages/mcp-server/src/workflow-tools.ts";
import { streamViaClaudeCode } from "../../claude-code-cli/stream-adapter.ts";
import { autoSession } from "../auto-runtime-state.ts";
import {
  clearNativeMilestoneStatusSourceRevisions,
  registerQueryTools,
} from "../bootstrap/query-tools.ts";
import {
  executeDomainOperation,
  type DomainJsonValue,
} from "../db/domain-operation.ts";
import { openIsolatedDatabase } from "../db/engine.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  clearGuidedUnitContext,
  setGuidedUnitContext,
} from "../guided-unit-context.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
} from "../lifecycle-shadow-repair-domain-operation.ts";
import {
  buildLifecycleShadowObservation,
  type MilestoneStatusObservationContext,
  type MilestoneStatusRuntimeMode,
  type MilestoneStatusTransport,
} from "../lifecycle-shadow-observation.ts";
import {
  beginMilestoneStatusObservationTurn,
  classifyMilestoneStatusRuntimeMode,
  clearMilestoneStatusObservationTurn,
  MILESTONE_STATUS_OBSERVATION_TOKEN_ENV,
  readMilestoneStatusObservationTurn,
  resolveMilestoneStatusObservationContext,
} from "../milestone-status-observation-context.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";
import {
  captureMilestoneVerificationSourceRevision,
  type MilestoneVerificationSourceRevisionResult,
} from "../verification-source-integrity.ts";

process.env.GSD_WORKFLOW_EXECUTORS_MODULE ??= fileURLToPath(new URL(
  "../tools/workflow-tool-executors.ts",
  import.meta.url,
));

const RUNTIME_MODES = [
  "auto",
  "interactive",
  "guided",
  "uok",
  "custom",
  "legacy",
] as const satisfies readonly MilestoneStatusRuntimeMode[];

const TRANSPORTS = [
  "native_pi",
  "workflow_mcp",
] as const satisfies readonly MilestoneStatusTransport[];

const CLASSIFICATIONS = [
  "extra_shadow",
  "match",
  "missing_shadow",
  "semantic_match_exact_delta",
  "status_mismatch",
] as const;

const tempDirs = new Set<string>();

type SourceRevisionCapture = (
  basePath: string,
  preferences: Parameters<typeof captureMilestoneVerificationSourceRevision>[1],
) => MilestoneVerificationSourceRevisionResult;

afterEach(() => {
  _setLifecycleShadowRepairBeforeCommitForTest(null);
  autoSession.reset();
  clearGuidedUnitContext();
  clearGSDPreferencesCache();
  clearNativeMilestoneStatusSourceRevisions();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function makeBase(prefix: string): string {
  const basePath = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(basePath);
  execFileSync("git", ["init", "-q"], { cwd: basePath });
  writeFileSync(join(basePath, "source.txt"), "tracked source\n", "utf-8");
  execFileSync("git", ["add", "source.txt"], { cwd: basePath });
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function seedLifecycle(
  identity: LifecycleIdentity,
  lifecycleStatus: CanonicalLifecycleStatus,
  key: string,
): void {
  const entityId = [identity.milestoneId, identity.sliceId, identity.taskId]
    .filter(Boolean)
    .join("/");
  const payload: DomainJsonValue = {
    itemKind: identity.itemKind,
    milestoneId: identity.milestoneId,
    sliceId: identity.sliceId ?? null,
    taskId: identity.taskId ?? null,
    lifecycleStatus,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.semantic-shadow-mode-matrix.seed",
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus });
    return {
      events: [{
        eventType: "test.semantic-shadow-mode-matrix.seeded",
        entityType: identity.itemKind,
        entityId,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: key.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function seedFiveClassificationFixture(basePath: string): void {
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Mode matrix milestone', 'pending', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES
      ('M001', 'S01', 'Observed slice', 'active', 1, '2026-07-15T00:00:00.000Z'),
      ('M001', 'S02', 'Missing shadow slice', 'queued', 2, '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Extra shadow task', 'pending', 1),
      ('M001', 'S01', 'T02', 'Mismatched task', 'done', 2);
  `);

  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001" },
    "pending",
    `matrix/${basePath}/milestone`,
  );
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01" },
    "in_progress",
    `matrix/${basePath}/slice`,
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    `matrix/${basePath}/task-extra`,
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    "paused",
    `matrix/${basePath}/task-mismatch`,
  );

  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    DELETE FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db().exec("PRAGMA foreign_keys = ON");
}

function expectedFoundResponse() {
  const result = {
    milestoneId: "M001",
    title: "Mode matrix milestone",
    status: "pending",
    createdAt: "2026-07-15T00:00:00.000Z",
    completedAt: null,
    sliceCount: 2,
    slices: [
      { id: "S01", status: "active", taskCounts: { total: 1, done: 1, pending: 0 } },
      { id: "S02", status: "queued", taskCounts: { total: 0, done: 0, pending: 0 } },
    ],
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structured: { operation: "milestone_status", ...result },
  };
}

function writeUokPreference(
  basePath: string,
  input: { enabled: boolean; legacyFallback?: boolean },
): void {
  writeFileSync(
    join(basePath, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "uok:",
      `  enabled: ${String(input.enabled)}`,
      "  legacy_fallback:",
      `    enabled: ${String(input.legacyFallback === true)}`,
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );
  clearGSDPreferencesCache();
}

function configureNativeMode(
  mode: MilestoneStatusRuntimeMode,
  basePath: string,
  context: MilestoneStatusObservationContext,
): void {
  autoSession.reset();
  clearGuidedUnitContext();

  if (mode === "guided") {
    setGuidedUnitContext(basePath, "validate-milestone");
    return;
  }
  if (mode === "interactive") return;

  autoSession.active = true;
  autoSession.basePath = basePath;
  autoSession.currentTraceId = context.traceId ?? null;
  autoSession.currentTurnId = context.turnId ?? null;
  autoSession.currentUnit = {
    type: "validate-milestone",
    id: "M001",
    startedAt: Date.now(),
  };

  if (mode === "custom") {
    autoSession.activeEngineId = "custom";
    autoSession.activeRunDir = basePath;
    writeUokPreference(basePath, { enabled: true });
    return;
  }
  if (mode === "uok") {
    writeUokPreference(basePath, { enabled: true });
    return;
  }
  if (mode === "legacy") {
    writeUokPreference(basePath, { enabled: true, legacyFallback: true });
    return;
  }
  writeUokPreference(basePath, { enabled: false });
}

function makeNativePiTool(captureSourceRevision?: SourceRevisionCapture) {
  const tools: Array<Record<string, any>> = [];
  registerQueryTools({
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
    },
  } as any, captureSourceRevision ? {
    captureMilestoneVerificationSourceRevision: captureSourceRevision,
  } : undefined);
  const tool = tools.find((candidate) => candidate.name === "gsd_milestone_status");
  assert.ok(tool, "native Pi milestone status registration is required");
  return tool;
}

function makeMcpTool() {
  type RequestExtra = {
    requestId?: string | number;
    sessionId?: string;
    _meta?: Record<string, unknown>;
  };
  const tools: Array<{
    name: string;
    handler: (args: Record<string, unknown>, extra?: RequestExtra) => Promise<any>;
  }> = [];
  registerWorkflowTools({
    tool(
      name: string,
      _description: string,
      _params: Record<string, unknown>,
      handler: (args: Record<string, unknown>, extra?: RequestExtra) => Promise<any>,
    ) {
      tools.push({ name, handler });
    },
  } as any, { advertiseAliases: false });
  const tool = tools.find((candidate) => candidate.name === "gsd_milestone_status");
  assert.ok(tool, "workflow MCP milestone status registration is required");
  return tool;
}

function observationPayload(basePath: string): Record<string, any> {
  const observationDb = openIsolatedDatabase(join(basePath, ".gsd", "gsd.db"));
  assert.ok(observationDb, "matrix observation database must be readable");
  const rows = observationDb.prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observed'
    ORDER BY ts, event_id
  `).all();
  const eventTypes = observationDb.prepare("SELECT type FROM audit_events ORDER BY ts, event_id").all();
  observationDb.close();
  const jsonlPath = join(basePath, ".gsd", "audit", "events.jsonl");
  const jsonl = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf-8") : "";
  assert.equal(
    rows.length,
    1,
    `each matrix cell must persist exactly one observation for ${basePath}; saw ${JSON.stringify(eventTypes)}; jsonl=${jsonl}`,
  );
  return JSON.parse(String(rows[0]!["payload_json"])) as Record<string, any>;
}

function expectedContext(
  mode: MilestoneStatusRuntimeMode,
  transport: MilestoneStatusTransport,
): MilestoneStatusObservationContext {
  const context: MilestoneStatusObservationContext = {
    mode,
    transport,
    sourceRevision: "pending_capture",
  };
  if (transport === "native_pi" || !["guided", "interactive"].includes(mode)) {
    context.traceId = `trace:${mode}:${transport}`;
    context.turnId = `turn:${mode}:${transport}`;
  }
  return context;
}

async function runNativeCell(
  mode: MilestoneStatusRuntimeMode,
  basePath: string,
  context: MilestoneStatusObservationContext,
  captureSourceRevision?: SourceRevisionCapture,
): Promise<any> {
  configureNativeMode(mode, basePath, context);
  const tool = makeNativePiTool(captureSourceRevision);
  return tool.execute(
    context.traceId,
    { milestoneId: "M001" },
    undefined,
    undefined,
    {
      cwd: basePath,
      sessionManager: { getSessionId: () => context.turnId },
    },
  );
}

async function runMcpCell(
  mode: MilestoneStatusRuntimeMode,
  basePath: string,
  context: MilestoneStatusObservationContext,
  captureSourceRevision?: SourceRevisionCapture,
): Promise<any> {
  configureNativeMode(mode, basePath, context);
  let capturedToken: string | undefined;
  let capturedMode: MilestoneStatusRuntimeMode | undefined;
  let workflowServerToken: string | undefined;
  let result: any;
  const stream = streamViaClaudeCode(
    { id: "claude-sonnet-4-6" } as any,
    {
      systemPrompt: "Read the current milestone status.",
      messages: [{ role: "user", content: "Check M001." }],
    } as any,
    {
      cwd: basePath,
      _skipWorkflowMcpPreflightForTest: true,
      async *_sdkQueryForTest(args: {
        prompt: string | AsyncIterable<unknown>;
        options?: Record<string, unknown>;
      }) {
        capturedToken = (args.options?.env as Record<string, string | undefined> | undefined)?.[
          MILESTONE_STATUS_OBSERVATION_TOKEN_ENV
        ];
        if (capturedToken) {
          capturedMode = readMilestoneStatusObservationTurn(basePath, capturedToken)?.mode;
          if (captureSourceRevision) {
            resolveMilestoneStatusObservationContext(
              basePath,
              "workflow_mcp",
              capturedToken,
              captureSourceRevision,
            );
          }
          const workflowServer = (
            args.options?.mcpServers as Record<string, Record<string, unknown>> | undefined
          )?.["gsd-workflow"];
          if (workflowServer && typeof workflowServer.command === "string") {
            workflowServerToken = (workflowServer.env as Record<string, string> | undefined)?.[
              MILESTONE_STATUS_OBSERVATION_TOKEN_ENV
            ];
          }
          const previousToken = process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
          process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = capturedToken;
          try {
            result = await makeMcpTool().handler(
              { projectDir: basePath, milestoneId: "M001" },
              {
                requestId: "unrelated-jsonrpc-request",
                sessionId: "unrelated-mcp-session",
                _meta: { "claudecode/toolUseId": "unrelated-tool-use" },
              },
            );
          } finally {
            if (previousToken === undefined) delete process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
            else process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = previousToken;
          }
        }
        yield {
          type: "result",
          subtype: "success",
          uuid: `result-${mode}`,
          session_id: `sdk-session-${mode}`,
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as const;
      },
    } as any,
  );

  await stream.result();
  assert.ok(capturedToken, `${mode} pump must create an exact observation token`);
  assert.equal(capturedMode, mode, `${mode} must come from production pump signals`);
  if (workflowServerToken !== undefined) assert.equal(workflowServerToken, capturedToken);
  assert.ok(result, `${mode} pump must reach the real MCP registration`);
  assert.equal(readMilestoneStatusObservationTurn(basePath, capturedToken), null);
  return result;
}

test("all supported modes and transports preserve the frozen response and exact observation identity", async () => {
  const expectedResponse = expectedFoundResponse();
  const observedCells: Array<Record<string, unknown>> = [];
  const expectedCells: Array<Record<string, unknown>> = [];

  for (const mode of RUNTIME_MODES) {
    for (const transport of TRANSPORTS) {
      closeDatabase();
      const basePath = makeBase(`gsd-shadow-matrix-${mode}-${transport}-`);
      seedFiveClassificationFixture(basePath);
      const context = expectedContext(mode, transport);
      let captureCount = 0;
      let capturedRevision: string | undefined;
      const capture: SourceRevisionCapture = (captureBasePath, preferences) => {
        captureCount += 1;
        const captured = captureMilestoneVerificationSourceRevision(captureBasePath, preferences);
        if (captured.ok) capturedRevision = captured.sourceRevision;
        return captured;
      };
      const result = transport === "native_pi"
        ? await runNativeCell(mode, basePath, context, capture)
        : await runMcpCell(mode, basePath, context, capture);

      assert.equal(captureCount, 1, `${mode}/${transport} must capture source exactly once`);
      assert.ok(capturedRevision, `${mode}/${transport} must capture an available source revision`);

      assert.deepEqual(result.content, expectedResponse.content, `${mode}/${transport} content changed`);
      assert.equal(
        result.content[0].text,
        expectedResponse.content[0].text,
        `${mode}/${transport} response is not byte-identical`,
      );
      const structured = transport === "native_pi" ? result.details : result.structuredContent;
      assert.deepEqual(structured, expectedResponse.structured, `${mode}/${transport} structured response changed`);

      const observation = observationPayload(basePath);
      assert.equal(observation.items.length, 5, `${mode}/${transport} must observe the full hierarchy fixture`);
      assert.deepEqual(
        observation.items.map((item: any) => item.classification).sort(),
        [...CLASSIFICATIONS],
        `${mode}/${transport} classification coverage changed`,
      );
      assert.ok(
        observation.items.every((item: any) => !("repairDisposition" in item)),
        "classification items must not be renamed into repair dispositions",
      );
      assert.equal(observation.repairDisposition, "not_attempted");
      assert.deepEqual(observation.observationLossAccounting, { lossCount: 0, persistedCount: 1 });

      observedCells.push({
        mode: observation.mode,
        transport: observation.transport,
        sourceRevision: observation.sourceRevision,
        traceId: observation.traceId,
        turnId: observation.turnId,
        repairDisposition: observation.repairDisposition,
      });
      expectedCells.push({
        ...context,
        sourceRevision: capturedRevision,
        traceId: context.traceId ?? null,
        turnId: context.turnId ?? null,
        repairDisposition: "not_attempted",
      });
    }
  }

  assert.equal(observedCells.length, 12);
  assert.deepEqual(new Set(observedCells.map((cell) => cell.mode)), new Set(RUNTIME_MODES));
  assert.deepEqual(new Set(observedCells.map((cell) => cell.transport)), new Set(TRANSPORTS));
  assert.deepEqual(observedCells, expectedCells, "registrations must propagate exact private observation identity");
});

test("native and Claude pump capture the actual project source revision exactly once", async () => {
  const expectedResponse = expectedFoundResponse();

  for (const transport of TRANSPORTS) {
    closeDatabase();
    const basePath = makeBase(`gsd-shadow-source-${transport}-`);
    seedFiveClassificationFixture(basePath);
    const context = expectedContext("interactive", transport);
    let captureCount = 0;
    let capturedRevision: string | undefined;
    const capture: SourceRevisionCapture = (captureBasePath, preferences) => {
      captureCount += 1;
      const captured = captureMilestoneVerificationSourceRevision(captureBasePath, preferences);
      if (captured.ok) capturedRevision = captured.sourceRevision;
      return captured;
    };

    const result = transport === "native_pi"
      ? await runNativeCell("interactive", basePath, context, capture)
      : await runMcpCell("interactive", basePath, context, capture);

    assert.equal(captureCount, 1, `${transport} must capture source once per invocation/pump`);
    assert.deepEqual(result.content, expectedResponse.content, `${transport} content changed`);
    const structured = transport === "native_pi" ? result.details : result.structuredContent;
    assert.deepEqual(structured, expectedResponse.structured, `${transport} structured response changed`);
    const observation = observationPayload(basePath);
    assert.ok(capturedRevision, `${transport} must capture an available source revision`);
    assert.equal(observation.sourceRevision, capturedRevision);
    assert.equal(observation.contextError, undefined);
    assert.deepEqual(observation.observationLossAccounting, { lossCount: 0, persistedCount: 1 });
  }
});

test("source capture failure stays response-neutral and accounts context loss", async () => {
  const expectedResponse = expectedFoundResponse();
  const unavailableCapture: SourceRevisionCapture = () => ({
    ok: false,
    error: "deliberate source capture failure",
  });

  for (const transport of TRANSPORTS) {
    closeDatabase();
    const basePath = makeBase(`gsd-shadow-source-failure-${transport}-`);
    seedFiveClassificationFixture(basePath);
    const context = expectedContext("interactive", transport);
    let captureCount = 0;
    const capture: SourceRevisionCapture = (captureBasePath, preferences) => {
      captureCount += 1;
      return unavailableCapture(captureBasePath, preferences);
    };

    const result = transport === "native_pi"
      ? await runNativeCell("interactive", basePath, context, capture)
      : await runMcpCell("interactive", basePath, context, capture);

    assert.equal(captureCount, 1, `${transport} must attempt source capture once`);
    assert.deepEqual(result.content, expectedResponse.content, `${transport} failure changed content`);
    const structured = transport === "native_pi" ? result.details : result.structuredContent;
    assert.deepEqual(structured, expectedResponse.structured, `${transport} failure changed structured response`);
    const observation = observationPayload(basePath);
    assert.equal(observation.sourceRevision, "unavailable");
    assert.equal(observation.contextError, "unavailable");
    assert.equal(observation.observationLossAccounting.lossCount, 1);
    assert.equal(observation.observationLossAccounting.persistedCount, 1);
    assert.equal(observation.observationLossAccounting.reason, "context_resolution_failed");
    assert.match(observation.observationLossAccounting.errorHash, /^sha256:[0-9a-f]{64}$/u);
  }
});

test("runtime classification and turn markers are bounded and token-fenced", () => {
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: true, activeEngineId: "custom" }), "custom");
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: true, uokLegacyFallback: true }), "legacy");
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: true, uokEnabled: true }), "uok");
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: true, uokEnabled: false }), "auto");
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: false, guidedActive: true }), "guided");
  assert.equal(classifyMilestoneStatusRuntimeMode({ autoActive: false }), "interactive");

  const basePath = makeBase("gsd-shadow-matrix-turn-marker-");
  assert.equal(beginMilestoneStatusObservationTurn(
    basePath,
    { mode: "guided", sourceRevision: "revision:first" },
    { now: 1_000, ttlMs: 1_000, token: "first-token" },
  ), "first-token");
  assert.equal(readMilestoneStatusObservationTurn(basePath, "first-token", 1_999)?.mode, "guided");

  assert.equal(beginMilestoneStatusObservationTurn(
    basePath,
    { mode: "uok", sourceRevision: "revision:second" },
    { now: 1_500, ttlMs: 1_000, token: "second-token" },
  ), "second-token");
  assert.equal(clearMilestoneStatusObservationTurn(basePath, "first-token"), true);
  assert.equal(readMilestoneStatusObservationTurn(basePath, "second-token", 2_499)?.mode, "uok");
  assert.equal(readMilestoneStatusObservationTurn(basePath, "second-token", 2_500), null);
  assert.equal(clearMilestoneStatusObservationTurn(basePath, "second-token"), false);
});

test("starting a turn scavenges expired and corrupt crash residue without removing live turns", () => {
  const basePath = makeBase("gsd-shadow-matrix-turn-scavenge-");
  assert.equal(beginMilestoneStatusObservationTurn(
    basePath,
    { mode: "guided", sourceRevision: "revision:live" },
    { now: 2_000, ttlMs: 10_000, token: "live-token" },
  ), "live-token");

  db().prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', :key, :value_json, :updated_at)
  `).run({
    ":key": "milestone-status-observation-turn:expired-token",
    ":value_json": JSON.stringify({
      token: "expired-token",
      databasePath: join(basePath, ".gsd", "gsd.db"),
      mode: "auto",
      sourceRevision: "revision:expired",
      startedAt: new Date(0).toISOString(),
      expiresAt: new Date(1_000).toISOString(),
    }),
    ":updated_at": new Date(0).toISOString(),
  });
  db().prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', :key, '{not json', :updated_at)
  `).run({
    ":key": "milestone-status-observation-turn:corrupt-token",
    ":updated_at": new Date(0).toISOString(),
  });

  assert.equal(beginMilestoneStatusObservationTurn(
    basePath,
    { mode: "uok", sourceRevision: "revision:new" },
    { now: 5_000, ttlMs: 10_000, token: "new-token" },
  ), "new-token");

  assert.deepEqual(
    db().prepare(`
      SELECT key FROM runtime_kv
      WHERE scope = 'global'
        AND scope_id = ''
        AND key LIKE 'milestone-status-observation-turn:%'
      ORDER BY key
    `).all().map((row) => row["key"]),
    [
      "milestone-status-observation-turn:live-token",
      "milestone-status-observation-turn:new-token",
    ],
  );
});

test("pending turn source capture occurs once on first status observation", () => {
  const basePath = makeBase("gsd-shadow-matrix-lazy-source-");
  const token = beginMilestoneStatusObservationTurn(basePath, {
    mode: "auto",
    sourceRevision: "pending_capture",
    traceId: "trace:lazy",
    turnId: "turn:lazy",
  });
  assert.ok(token);
  let captures = 0;
  const capture = () => {
    captures += 1;
    return { ok: true as const, sourceRevision: "sha256:lazy-source" };
  };

  const first = resolveMilestoneStatusObservationContext(
    basePath,
    "workflow_mcp",
    token,
    capture,
  );
  const second = resolveMilestoneStatusObservationContext(
    basePath,
    "workflow_mcp",
    token,
    capture,
  );

  assert.equal(captures, 1);
  assert.equal(first.sourceRevision, "sha256:lazy-source");
  assert.equal(second.sourceRevision, "sha256:lazy-source");
});

test("overlapping turns resolve only the exact private capability token", async () => {
  const basePath = makeBase("gsd-shadow-matrix-overlap-");
  const firstToken = beginMilestoneStatusObservationTurn(basePath, {
    mode: "auto",
    sourceRevision: "revision:first",
    traceId: "trace:first",
    turnId: "turn:first",
  });
  const secondToken = beginMilestoneStatusObservationTurn(basePath, {
    mode: "custom",
    sourceRevision: "revision:second",
    traceId: "trace:second",
    turnId: "turn:second",
  });
  assert.ok(firstToken);
  assert.ok(secondToken);
  assert.equal(await resolveMilestoneStatusObservationTokenState(basePath, firstToken), "active");
  assert.equal(await resolveMilestoneStatusObservationTokenState(basePath, "unknown-token"), "inactive");

  db().prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', :key, 'not-json', :updated_at)
  `).run({
    ":key": "milestone-status-observation-turn:corrupt-token",
    ":updated_at": new Date().toISOString(),
  });
  assert.equal(
    await resolveMilestoneStatusObservationTokenState(basePath, "corrupt-token"),
    "unavailable",
  );

  assert.deepEqual(
    resolveMilestoneStatusObservationContext(basePath, "workflow_mcp", firstToken),
    {
      mode: "auto",
      transport: "workflow_mcp",
      sourceRevision: "revision:first",
      traceId: "trace:first",
      turnId: "turn:first",
    },
  );
  assert.deepEqual(
    resolveMilestoneStatusObservationContext(basePath, "workflow_mcp", secondToken),
    {
      mode: "custom",
      transport: "workflow_mcp",
      sourceRevision: "revision:second",
      traceId: "trace:second",
      turnId: "turn:second",
    },
  );

  const unavailable = resolveMilestoneStatusObservationContext(basePath, "workflow_mcp", "unknown-token");
  assert.equal(unavailable.mode, "legacy");
  assert.equal(unavailable.contextError, "unavailable");
  const lossObservation = buildLifecycleShadowObservation("M001", {
    projectRevision: 1,
    authorityEpoch: 0,
    items: [],
  }, unavailable);
  assert.equal(lossObservation.contextError, "unavailable");
  assert.equal(lossObservation.observationLossAccounting.lossCount, 1);
  assert.equal(lossObservation.observationLossAccounting.persistedCount, 1);
  assert.equal(lossObservation.observationLossAccounting.reason, "context_resolution_failed");
  assert.match(lossObservation.observationLossAccounting.errorHash ?? "", /^sha256:[0-9a-f]{64}$/u);
});

test("a token from another project is loss-accounted instead of misattributed", () => {
  const firstBasePath = makeBase("gsd-shadow-matrix-token-project-first-");
  const secondBasePath = makeBase("gsd-shadow-matrix-token-project-second-");
  const token = beginMilestoneStatusObservationTurn(firstBasePath, {
    mode: "custom",
    sourceRevision: "revision:other",
    traceId: "trace:other",
    turnId: "turn:other",
  });
  assert.ok(token);

  const context = resolveMilestoneStatusObservationContext(secondBasePath, "workflow_mcp", token);
  assert.deepEqual(context, {
    mode: "legacy",
    transport: "workflow_mcp",
    sourceRevision: "unavailable",
    contextError: "unavailable",
  });
});

test("native and pump context ignore an auto session owned by another project", async () => {
  const ownerPath = makeBase("gsd-shadow-matrix-auto-owner-");
  closeDatabase();
  const nativeTargetPath = makeBase("gsd-shadow-matrix-native-target-");
  closeDatabase();
  const pumpTargetPath = makeBase("gsd-shadow-matrix-pump-target-");
  closeDatabase();
  configureNativeMode("auto", ownerPath, {
    mode: "auto",
    transport: "native_pi",
    sourceRevision: "unavailable",
    traceId: "trace:owner",
    turnId: "turn:owner",
  });

  const nativeResult = await makeNativePiTool().execute(
    "trace:native-target",
    { milestoneId: "M404" },
    undefined,
    undefined,
    {
      cwd: nativeTargetPath,
      sessionManager: { getSessionId: () => "turn:native-target" },
    },
  );
  assert.equal(nativeResult.details.found, false);
  const nativeObservation = observationPayload(nativeTargetPath);
  assert.equal(nativeObservation.mode, "interactive");
  assert.equal(nativeObservation.traceId, "trace:native-target");
  assert.equal(nativeObservation.turnId, "turn:native-target");
  closeDatabase();

  let pumpMode: string | undefined;
  let pumpTraceId: string | undefined;
  let pumpTurnId: string | undefined;
  const stream = streamViaClaudeCode(
    { id: "claude-sonnet-4-6" } as any,
    { messages: [{ role: "user", content: "Check status." }] } as any,
    {
      cwd: pumpTargetPath,
      _skipWorkflowMcpPreflightForTest: true,
      async *_sdkQueryForTest(args: { options?: Record<string, unknown> }) {
        const token = (args.options?.env as Record<string, string | undefined> | undefined)?.[
          MILESTONE_STATUS_OBSERVATION_TOKEN_ENV
        ];
        const pumpContext = token
          ? readMilestoneStatusObservationTurn(pumpTargetPath, token)
          : null;
        pumpMode = pumpContext?.mode;
        pumpTraceId = pumpContext?.traceId;
        pumpTurnId = pumpContext?.turnId;
        yield {
          type: "result",
          subtype: "success",
          uuid: "result-project-fence",
          session_id: "sdk-session",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as const;
      },
    } as any,
  );
  await stream.result();
  assert.equal(pumpMode, "interactive");
  assert.equal(pumpTraceId, undefined);
  assert.equal(pumpTurnId, undefined);
});

test("a pump without a database strips any inherited observation token", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-matrix-pump-no-db-"));
  tempDirs.add(basePath);
  const previousToken = process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
  let sdkToken: string | undefined;
  try {
    process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = "stale-parent-token";
    const stream = streamViaClaudeCode(
      { id: "claude-sonnet-4-6" } as any,
      { messages: [{ role: "user", content: "Check status." }] } as any,
      {
        cwd: basePath,
        _skipWorkflowMcpPreflightForTest: true,
        async *_sdkQueryForTest(args: { options?: Record<string, unknown> }) {
          sdkToken = (args.options?.env as Record<string, string | undefined> | undefined)?.[
            MILESTONE_STATUS_OBSERVATION_TOKEN_ENV
          ];
          yield {
            type: "result",
            subtype: "success",
            uuid: "result-no-db",
            session_id: "sdk-session",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "done",
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          } as const;
        },
      } as any,
    );
    await stream.result();
  } finally {
    if (previousToken === undefined) delete process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
    else process.env[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = previousToken;
  }
  assert.equal(sdkToken, undefined);
});

test("invalid exact context rows are reported as observation loss", () => {
  const basePath = makeBase("gsd-shadow-matrix-invalid-context-");
  const token = beginMilestoneStatusObservationTurn(basePath, {
    mode: "auto",
    sourceRevision: "revision:corrupt",
  });
  assert.ok(token);
  db().prepare(`
    UPDATE runtime_kv SET value_json = '{not json'
    WHERE key = :key
  `).run({ ":key": `milestone-status-observation-turn:${token}` });

  const context = resolveMilestoneStatusObservationContext(basePath, "workflow_mcp", token);
  assert.equal(context.mode, "legacy");
  assert.equal(context.contextError, "invalid");
});

function seedRepairFixture(): string {
  const basePath = makeBase("gsd-shadow-matrix-repair-");
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Repair fixture', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Repair slice', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M001', 'S01', 'T01', 'Repairable', 'complete',
        '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion',
        'passed', '# T01 summary'
      ),
      ('M001', 'S01', 'T02', 'Unresolved', 'complete', NULL, '', '', '', '');
  `);
  return basePath;
}

function repairInvocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "internal" as const,
    actorType: "agent",
    actorId: "semantic-shadow-mode-matrix",
    traceId: `trace:${key}`,
    turnId: `turn:${key}`,
  };
}

function repairTask(taskId: string) {
  return { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId };
}

function repairAuthoritySnapshot(): Record<string, unknown> {
  return {
    authority: db().prepare("SELECT revision, authority_epoch FROM project_authority").get(),
    lifecycles: db().prepare("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
    operations: db().prepare("SELECT * FROM workflow_operations ORDER BY operation_id").all(),
    events: db().prepare("SELECT * FROM workflow_domain_events ORDER BY event_id").all(),
    projections: db().prepare("SELECT * FROM workflow_projection_work ORDER BY projection_work_id").all(),
  };
}

test("repair outcomes remain separate: repaired, unresolved, and rejection without residue", () => {
  seedRepairFixture();

  const repaired = repairLifecycleShadowForward({
    invocation: repairInvocation("matrix/repair/repaired"),
    item: repairTask("T01"),
  });
  assert.equal(repaired.comparison.kind, "missing_shadow");
  assert.equal(repaired.disposition, "repaired");

  const unresolved = repairLifecycleShadowForward({
    invocation: repairInvocation("matrix/repair/unresolved"),
    item: repairTask("T02"),
  });
  assert.equal(unresolved.comparison.kind, "missing_shadow");
  assert.equal(unresolved.disposition, "unresolved");

  db().prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M001', 'S01', 'T03', 'Rejected', 'complete',
      '2026-07-15T02:00:00.000Z', 'Finished', 'Historical completion',
      'passed', '# T03 summary'
    )
  `).run();
  const beforeRejected = repairAuthoritySnapshot();
  _setLifecycleShadowRepairBeforeCommitForTest(() => {
    db().prepare("UPDATE tasks SET full_summary_md = '# changed' WHERE id = 'T03'").run();
  });
  assert.throws(() => repairLifecycleShadowForward({
    invocation: repairInvocation("matrix/repair/rejected"),
    item: repairTask("T03"),
  }), /stable durable completion evidence/i);
  const afterRejected = repairAuthoritySnapshot();
  assert.deepEqual(afterRejected, beforeRejected, "rejected repair must leave no workflow-authority residue");
  assert.equal(
    db().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE idempotency_key LIKE 'matrix/repair/rejected%'").get()?.["count"],
    0,
  );
});

test("observation loss stays response-neutral and separate from classification", async () => {
  const basePath = makeBase("gsd-shadow-matrix-loss-");
  seedFiveClassificationFixture(basePath);
  db().exec("PRAGMA foreign_keys = OFF");
  db().exec("ALTER TABLE workflow_item_lifecycles RENAME TO unavailable_workflow_item_lifecycles");
  db().exec("PRAGMA foreign_keys = ON");

  const response = await executeMilestoneStatus(
    { milestoneId: "M001" },
    basePath,
    {
      mode: "legacy",
      transport: "native_pi",
      sourceRevision: "unavailable",
      traceId: "trace:observation-loss",
      turnId: "turn:observation-loss",
    },
  );
  assert.deepEqual(response.content, expectedFoundResponse().content);

  const observation = observationPayload(basePath);
  assert.deepEqual(observation.items, []);
  assert.equal(observation.repairDisposition, "not_attempted");
  assert.equal(observation.reason, "shadow_query_failed");
  assert.equal(observation.observationLossAccounting.lossCount, 1);
  assert.equal(observation.observationLossAccounting.persistedCount, 1);
  assert.equal(observation.observationLossAccounting.reason, "shadow_query_failed");
  assert.match(observation.observationLossAccounting.errorHash, /^sha256:[0-9a-f]{64}$/u);
});
