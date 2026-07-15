// Project/App: gsd-pi
// File Purpose: Frozen M003/S07 semantic-shadow and no-cutover contract.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { registerQueryTools } from "../bootstrap/query-tools.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  compareLifecycleShadow,
  type LifecycleShadowComparisonKind,
} from "../db/lifecycle-shadow-comparison.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";

const CLASSIFICATIONS = [
  "match",
  "semantic_match_exact_delta",
  "missing_shadow",
  "extra_shadow",
  "status_mismatch",
] as const satisfies readonly LifecycleShadowComparisonKind[];

const RUNTIME_MODES = [
  "auto",
  "interactive",
  "guided",
  "uok",
  "custom",
  "legacy",
] as const;

const TRANSPORTS = ["native_pi", "workflow_mcp"] as const;

const OBSERVATION_FIELDS = [
  "item_identity",
  "raw_legacy_status",
  "raw_canonical_status",
  "normalized_legacy_status",
  "normalized_canonical_status",
  "classification",
  "mode",
  "transport",
  "source_revision",
  "authority_epoch",
  "trace_id",
  "turn_id",
  "repair_disposition",
  "observation_loss_accounting",
] as const;

const REPAIR_RULES = [
  "durable_terminal_evidence_required",
  "missing_shadow_only",
  "ready_bootstrap_advances_legally",
  "never_invent_attempts_or_results",
  "never_rewrite_legacy_rows",
  "never_move_a_newer_head_backward",
  "extra_or_unexplained_shadow_remains_unresolved",
  "one_immutable_replay_safe_receipt",
] as const;

const FORBIDDEN_BOUNDARIES = [
  "canonical_read_authority",
  "canonical_dependency_eligibility",
  "canonical_retry_authority",
  "public_response_expansion",
  "legacy_path_deletion",
  "compatibility_case_deletion",
  "markdown_fallback_authority",
  "github_label_or_tag_authority",
] as const;

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-semantic-shadow-contract-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);

  const db = _getAdapter();
  assert.ok(db);
  db.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Frozen status fixture', 'active', '2026-07-14T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES ('M001', 'S01', 'Frozen slice', 'active', 1, '2026-07-14T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES
      ('M001', 'S01', 'T01', 'Finished task', 'done', 1),
      ('M001', 'S01', 'T02', 'Pending task', 'pending', 2);
  `);

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "semantic-shadow.contract.adopt",
    idempotencyKey: "semantic-shadow-contract/M001",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "semantic-shadow-contract",
    sourceTransport: "test",
    payload: { milestoneId: "M001", canonicalStatus: "completed" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "completed",
    });
    return {
      events: [{
        eventType: "semantic-shadow.contract.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { canonicalStatus: "completed" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "semantic-shadow-contract/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });

  writeFileSync(
    join(base, ".gsd", "ROADMAP.md"),
    "# Contradictory projection\n\n- [x] M001: projection says complete\n",
  );
  return base;
}

function makeMockPi() {
  const tools: Array<Record<string, unknown>> = [];
  return {
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    tools,
  } as any;
}

async function runNativePiStatus(base: string): Promise<any> {
  const pi = makeMockPi();
  registerQueryTools(pi);
  const tool = pi.tools.find((candidate: any) => candidate.name === "gsd_milestone_status");
  assert.ok(tool);
  const originalCwd = process.cwd();
  try {
    process.chdir(base);
    return await tool.execute("semantic-shadow-native-pi", { milestoneId: "M001" });
  } finally {
    process.chdir(originalCwd);
  }
}

async function runWorkflowMcpStatus(base: string): Promise<any> {
  return executeMilestoneStatus({ milestoneId: "M001" }, base);
}

function authoritySnapshot(): Record<string, unknown> {
  const db = _getAdapter();
  assert.ok(db);
  return {
    hierarchy: db.prepare(`
      SELECT id, status FROM milestones
      UNION ALL SELECT milestone_id || '/' || id, status FROM slices
      UNION ALL SELECT milestone_id || '/' || slice_id || '/' || id, status FROM tasks
      ORDER BY 1
    `).all(),
    lifecycles: db.prepare(`
      SELECT item_kind, milestone_id, slice_id, task_id, lifecycle_status, state_version
      FROM workflow_item_lifecycles ORDER BY lifecycle_id
    `).all(),
    operations: db.prepare("SELECT operation_id, operation_type FROM workflow_operations ORDER BY operation_id").all(),
    events: db.prepare("SELECT event_id, event_type FROM workflow_domain_events ORDER BY event_id").all(),
    projections: db.prepare("SELECT projection_work_id, projection_key FROM workflow_projection_work ORDER BY projection_work_id").all(),
  };
}

test("freezes the exact semantic-shadow classifications without translation aliases", () => {
  assert.deepEqual(CLASSIFICATIONS, [
    "match",
    "semantic_match_exact_delta",
    "missing_shadow",
    "extra_shadow",
    "status_mismatch",
  ]);

  const cases: Array<{
    legacy: string | null;
    canonical: string | null;
    expected: ReturnType<typeof compareLifecycleShadow>;
  }> = [
    {
      legacy: "in_progress",
      canonical: "in_progress",
      expected: {
        kind: "match",
        legacyStatus: "in_progress",
        canonicalStatus: "in_progress",
        normalizedLegacyStatus: "in_progress",
        normalizedCanonicalStatus: "in_progress",
      },
    },
    {
      legacy: "active",
      canonical: "ready",
      expected: {
        kind: "semantic_match_exact_delta",
        legacyStatus: "active",
        canonicalStatus: "ready",
        normalizedLegacyStatus: "in_progress",
        normalizedCanonicalStatus: "ready",
      },
    },
    {
      legacy: "active",
      canonical: null,
      expected: {
        kind: "missing_shadow",
        legacyStatus: "active",
        canonicalStatus: null,
        normalizedLegacyStatus: "in_progress",
        normalizedCanonicalStatus: null,
      },
    },
    {
      legacy: null,
      canonical: "ready",
      expected: {
        kind: "extra_shadow",
        legacyStatus: null,
        canonicalStatus: "ready",
        normalizedLegacyStatus: null,
        normalizedCanonicalStatus: "ready",
      },
    },
    {
      legacy: "done",
      canonical: "paused",
      expected: {
        kind: "status_mismatch",
        legacyStatus: "done",
        canonicalStatus: "paused",
        normalizedLegacyStatus: "completed",
        normalizedCanonicalStatus: "paused",
      },
    },
  ];

  assert.deepEqual(
    cases.map(({ legacy, canonical }) => compareLifecycleShadow(legacy, canonical)),
    cases.map(({ expected }) => expected),
  );
  assert.equal(CLASSIFICATIONS.includes("exact_match" as never), false);
});

test("freezes the complete mode, transport, observation, and repair inventories", () => {
  assert.deepEqual(RUNTIME_MODES, ["auto", "interactive", "guided", "uok", "custom", "legacy"]);
  assert.deepEqual(TRANSPORTS, ["native_pi", "workflow_mcp"]);
  assert.deepEqual(OBSERVATION_FIELDS, [
    "item_identity",
    "raw_legacy_status",
    "raw_canonical_status",
    "normalized_legacy_status",
    "normalized_canonical_status",
    "classification",
    "mode",
    "transport",
    "source_revision",
    "authority_epoch",
    "trace_id",
    "turn_id",
    "repair_disposition",
    "observation_loss_accounting",
  ]);
  assert.deepEqual(REPAIR_RULES, [
    "durable_terminal_evidence_required",
    "missing_shadow_only",
    "ready_bootstrap_advances_legally",
    "never_invent_attempts_or_results",
    "never_rewrite_legacy_rows",
    "never_move_a_newer_head_backward",
    "extra_or_unexplained_shadow_remains_unresolved",
    "one_immutable_replay_safe_receipt",
  ]);
  assert.deepEqual(FORBIDDEN_BOUNDARIES, [
    "canonical_read_authority",
    "canonical_dependency_eligibility",
    "canonical_retry_authority",
    "public_response_expansion",
    "legacy_path_deletion",
    "compatibility_case_deletion",
    "markdown_fallback_authority",
    "github_label_or_tag_authority",
  ]);
});

test("keeps milestone status byte/deep-equal across native Pi and the shared workflow executor", async () => {
  const base = makeFixture();
  const expectedResult = {
    milestoneId: "M001",
    title: "Frozen status fixture",
    status: "active",
    createdAt: "2026-07-14T00:00:00.000Z",
    completedAt: null,
    sliceCount: 1,
    slices: [{
      id: "S01",
      status: "active",
      taskCounts: { total: 2, done: 1, pending: 1 },
    }],
  };
  const expectedContent = [{ type: "text", text: JSON.stringify(expectedResult, null, 2) }];
  const expectedDetails = { operation: "milestone_status", ...expectedResult };
  const before = authoritySnapshot();
  assert.deepEqual(before.lifecycles, [{
    item_kind: "milestone",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    lifecycle_status: "completed",
    state_version: 0,
  }], "fixture must disagree with the legacy active status");
  assert.match(
    readFileSync(join(base, ".gsd", "ROADMAP.md"), "utf8"),
    /\[x\] M001/,
    "fixture must include a contradictory completed projection",
  );

  for (const [surface, result] of [
    ["native_pi", await runNativePiStatus(base)],
    ["workflow_executor", await runWorkflowMcpStatus(base)],
  ] as const) {
    assert.deepEqual(result.content, expectedContent, `${surface} content changed`);
    assert.equal(result.content[0].text, expectedContent[0].text, `${surface} text is not byte-equal`);
    assert.deepEqual(result.details, expectedDetails, `${surface} details changed`);
  }

  assert.deepEqual(authoritySnapshot(), before, "status reads must not mutate authority or delete compatibility state");
  assert.equal(expectedResult.status, "active", "legacy status remains the public read authority");
});
