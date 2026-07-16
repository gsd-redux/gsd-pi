// Project/App: gsd-pi
// File Purpose: Behavior-first proof that semantic shadow state has not become read or routing authority.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { detectStuck } from "../auto/detect-stuck.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { markFailed, recordDispatchClaim } from "../db/unit-dispatches.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import {
  _getAdapter,
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";
import type { WindowEntry } from "../auto/types.ts";

import {
  analyzeLocalInputBoundary,
  analyzeNoCutoverSources,
  NO_CUTOVER_BEHAVIORAL_WITNESSES,
  NO_CUTOVER_SOURCE_FILES,
  parseArgs,
  REPO_ROOT,
  runSemanticShadowNoCutoverGate,
} from "../../../../../scripts/semantic-shadow-no-cutover-gate.mjs";

const SOURCE_FILES = NO_CUTOVER_SOURCE_FILES;

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function seedLifecycle(
  input: Parameters<typeof adoptOrTransitionLifecycle>[1],
  operationSuffix: string,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "semantic-shadow.no-cutover.seed",
    idempotencyKey: `semantic-shadow/no-cutover/${operationSuffix}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "semantic-shadow-no-cutover",
    sourceTransport: "test",
    payload: {
      itemKind: input.itemKind,
      milestoneId: input.milestoneId,
      sliceId: input.sliceId ?? null,
      taskId: input.taskId ?? null,
      lifecycleStatus: input.lifecycleStatus,
    },
  }, (context) => {
    adoptOrTransitionLifecycle(context, input);
    return {
      events: [{
        eventType: "semantic-shadow.no-cutover.seeded",
        entityType: input.itemKind,
        entityId: [input.milestoneId, input.sliceId, input.taskId].filter(Boolean).join("/"),
        payload: { lifecycleStatus: input.lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `semantic-shadow/no-cutover/${operationSuffix.toLowerCase()}`,
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function readLifecycleStatus(itemKind: string): string {
  const db = _getAdapter();
  assert.ok(db);
  const row = db.prepare(
    "SELECT lifecycle_status FROM workflow_item_lifecycles WHERE item_kind = :itemKind",
  ).get({ ":itemKind": itemKind }) as { lifecycle_status: string } | undefined;
  assert.ok(row);
  return row.lifecycle_status;
}

function writeMilestoneContext(base: string, milestoneId: string): void {
  const directory = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "CONTEXT.md"), `# ${milestoneId}\n`);
}

function repeatedWindow(unitKey: string): WindowEntry[] {
  return [
    { key: unitKey },
    { key: "other-unit" },
    { key: unitKey },
    { key: "third-unit" },
    { key: unitKey },
  ];
}

function loadSource(file: string): string {
  // allow-source-grep: sources are parsed into a TypeScript AST by the imported gate analyzer.
  return readFileSync(join(REPO_ROOT, file), "utf8");
}

function pristineSources(): Record<keyof typeof SOURCE_FILES, string> {
  return Object.fromEntries(
    Object.entries(SOURCE_FILES).map(([key, file]) => [key, loadSource(file)]),
  ) as Record<keyof typeof SOURCE_FILES, string>;
}

test("legacy milestone status remains public when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-status-");
  insertMilestone({
    id: "M001",
    title: "Legacy status wins",
    status: "active",
  });
  _getAdapter()?.prepare(
    "UPDATE milestones SET created_at = '2026-07-15T00:00:00.000Z' WHERE id = 'M001'",
  ).run();
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Legacy slice",
    status: "active",
    depends: [],
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Legacy task",
    status: "pending",
  });
  seedLifecycle({
    itemKind: "milestone",
    milestoneId: "M001",
    lifecycleStatus: "completed",
  }, "status-M001");

  assert.equal(readLifecycleStatus("milestone"), "completed");
  const result = await executeMilestoneStatus({ milestoneId: "M001" }, base);
  const expected = {
    milestoneId: "M001",
    title: "Legacy status wins",
    status: "active",
    createdAt: "2026-07-15T00:00:00.000Z",
    completedAt: null,
    sliceCount: 1,
    slices: [{
      id: "S01",
      status: "active",
      taskCounts: { total: 1, done: 0, pending: 1 },
    }],
  };
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(expected, null, 2) }]);
  assert.deepEqual(result.details, { operation: "milestone_status", ...expected });
});

test("legacy dependency and dispatch decisions win in both disagreement directions", async () => {
  const eligibilityBase = makeProject("gsd-no-cutover-eligibility-");
  for (const id of ["M001", "M002", "M003", "M004"]) {
    writeMilestoneContext(eligibilityBase, id);
  }
  insertMilestone({ id: "M001", title: "Legacy complete", status: "complete" });
  insertMilestone({
    id: "M002",
    title: "Allowed dependent",
    status: "active",
    depends_on: ["M001"],
  });
  insertMilestone({ id: "M003", title: "Legacy active", status: "active" });
  insertMilestone({
    id: "M004",
    title: "Blocked dependent",
    status: "active",
    depends_on: ["M003"],
  });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" },
    "eligibility-complete",
  );
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M003", lifecycleStatus: "completed" },
    "eligibility-active",
  );
  invalidateStateCache();

  const eligibility = await analyzeParallelEligibility(eligibilityBase);
  assert.ok(eligibility.eligible.some((entry) => entry.milestoneId === "M002"));
  assert.ok(eligibility.ineligible.some((entry) => entry.milestoneId === "M004"));
  closeDatabase();

  const dispatchBase = makeProject("gsd-no-cutover-dispatch-");
  writeMilestoneContext(dispatchBase, "M010");
  insertMilestone({ id: "M010", title: "Dispatch", status: "active" });
  insertSlice({
    id: "S01", milestoneId: "M010", title: "Legacy skipped", status: "skipped", depends: [],
  });
  insertSlice({
    id: "S02", milestoneId: "M010", title: "Allowed target", status: "pending", depends: ["S01"],
  });
  insertSlice({
    id: "S03", milestoneId: "M010", title: "Legacy active", status: "active", depends: [],
  });
  insertSlice({
    id: "S04", milestoneId: "M010", title: "Blocked target", status: "pending", depends: ["S03"],
  });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M010", sliceId: "S01", lifecycleStatus: "in_progress" },
    "dispatch-skipped",
  );
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M010", sliceId: "S03", lifecycleStatus: "completed" },
    "dispatch-active",
  );

  assert.equal(
    getPriorSliceCompletionBlocker(dispatchBase, "main", "execute-task", "M010/S02/T01"),
    null,
  );
  assert.match(
    getPriorSliceCompletionBlocker(dispatchBase, "main", "execute-task", "M010/S04/T01") ?? "",
    /dependency slice M010\/S03 is not complete/,
  );
});

test("resolveDispatch keeps legacy milestone status authoritative when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-resolve-dispatch-");
  insertMilestone({ id: "M001", title: "Legacy active", status: "active" });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" },
    "resolve-dispatch-active",
  );

  const active = await resolveDispatch({
    basePath: base,
    mid: "M001",
    midTitle: "Legacy active",
    prefs: undefined,
    state: {
      activeMilestone: { id: "M001", title: "Legacy active" },
      activeSlice: null,
      activeTask: null,
      phase: "needs-discussion",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M001", title: "Legacy active", status: "active" }],
    },
  });
  assert.equal(active.action, "dispatch");
  assert.equal(active.unitType, "discuss-milestone");

  insertMilestone({ id: "M002", title: "Legacy complete", status: "complete" });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "in_progress" },
    "resolve-dispatch-complete",
  );
  const complete = await resolveDispatch({
    basePath: base,
    mid: "M002",
    midTitle: "Legacy complete",
    prefs: undefined,
    state: {
      activeMilestone: { id: "M002", title: "Legacy complete" },
      activeSlice: null,
      activeTask: null,
      phase: "needs-discussion",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [{ id: "M002", title: "Legacy complete", status: "complete" }],
    },
  });
  assert.equal(complete.action, "stop");
  assert.match(complete.reason, /Milestone M002 is closed/);
});

test("dispatch retry ledger remains authoritative when canonical lifecycle disagrees", () => {
  const base = makeProject("gsd-no-cutover-retry-");
  insertMilestone({ id: "M001", title: "Retry", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Retry slice", status: "active", depends: [] });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Legacy pending task",
    status: "pending",
  });
  seedLifecycle({
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "completed",
  }, "retry-task");
  assert.equal(readLifecycleStatus("task"), "completed");

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  const claim = recordDispatchClaim({
    traceId: "no-cutover-retry",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    attemptN: 1,
    maxAttempts: 3,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markFailed(claim.dispatchId, { errorSummary: "transient", retryAfterMs: 60_000 });

  const unitKey = "execute-task:M001/S01/T01";
  assert.equal(detectStuck(repeatedWindow(unitKey)), null, "future ledger retry suppresses stuck");
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(
    "UPDATE unit_dispatches SET next_run_at = '1970-01-01T00:00:00.000Z' WHERE id = :id",
  ).run({ ":id": claim.dispatchId });
  assert.ok(detectStuck(repeatedWindow(unitKey)), "expired ledger retry re-enables stuck");
  assert.equal(readLifecycleStatus("task"), "completed", "canonical disagreement stayed constant");
});

test("legacy validation assessment steers state when canonical lifecycle disagrees", async () => {
  const base = makeProject("gsd-no-cutover-state-");
  insertMilestone({ id: "M001", title: "State authority", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", depends: [] });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Done",
    status: "complete",
  });
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed" },
    "state-completed",
  );
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
    "state-slice",
  );
  seedLifecycle({
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "completed",
  }, "state-task");

  assert.equal((await deriveStateFromDb(base)).phase, "validating-milestone");

  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\n---\n",
  });
  invalidateStateCache();
  assert.equal((await deriveStateFromDb(base)).phase, "completing-milestone");

  insertAssessment({
    path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001",
    sliceId: null,
    taskId: null,
    status: "needs-remediation",
    scope: "milestone-validation",
    fullContent: "---\nverdict: needs-remediation\n---\n",
  });
  invalidateStateCache();
  const blocked = await deriveStateFromDb(base);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockers[0] ?? "", /needs-remediation/);
});

test("AST boundaries reject canonical response, decision, and hosted-metadata sabotage", () => {
  const pristine = pristineSources();
  assert.ok(analyzeNoCutoverSources(pristine).every((check) => check.verdict === "pass"));

  const responseLeak = pristine.status.replace(
    "details: { operation: \"milestone_status\", ...result },",
    "details: { operation: \"milestone_status\", ...result, shadowSnapshot },",
  );
  assert.notEqual(responseLeak, pristine.status, "controlled response sabotage must be applied");
  const responseChecks = analyzeNoCutoverSources({ ...pristine, status: responseLeak });
  assert.equal(responseChecks.find((check) => check.id === "status-response-authority")?.verdict, "fail");

  const shorthandResponseLeak = pristine.status.replace(
    'details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false },',
    'details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false, canonical: getMilestoneLifecycleShadowSnapshot(params.milestoneId) },',
  );
  assert.notEqual(
    shorthandResponseLeak,
    pristine.status,
    "controlled shorthand response sabotage must be applied",
  );
  const shorthandResponseChecks = analyzeNoCutoverSources({ ...pristine, status: shorthandResponseLeak });
  assert.equal(
    shorthandResponseChecks.find((check) => check.id === "status-response-authority")?.verdict,
    "fail",
  );

  for (const mutation of [
    "Object.assign(result, { canonical: getMilestoneLifecycleShadowSnapshot(params.milestoneId) });",
    "result.canonical = getMilestoneLifecycleShadowSnapshot(params.milestoneId);",
  ]) {
    const lateMutation = pristine.status.replace(
      "      return {\n        response: {",
      `      ${mutation}\n      return {\n        response: {`,
    );
    assert.notEqual(lateMutation, pristine.status, "controlled late response mutation must be applied");
    const lateMutationChecks = analyzeNoCutoverSources({ ...pristine, status: lateMutation });
    assert.equal(
      lateMutationChecks.find((check) => check.id === "status-response-authority")?.verdict,
      "fail",
    );
  }

  const eligibilityCutover = pristine.eligibility.replace(
    "const state = await deriveState(basePath);",
    "const state = await deriveState(basePath); getMilestoneLifecycleShadowSnapshot('M001');",
  ).replace(
    "import { deriveState } from \"./state.js\";",
    "import { deriveState } from \"./state.js\";\nimport { getMilestoneLifecycleShadowSnapshot } from './db/queries.js';",
  );
  assert.notEqual(eligibilityCutover, pristine.eligibility, "controlled eligibility sabotage must be applied");
  const eligibilityChecks = analyzeNoCutoverSources({ ...pristine, eligibility: eligibilityCutover });
  assert.equal(
    eligibilityChecks.find((check) => check.id === "parallel-eligibility-authority")?.verdict,
    "fail",
  );

  const resolverCutover = pristine.resolver.replace(
    'import { isClosedStatus } from "./status-guards.js";',
    'import { isClosedStatus } from "./status-guards.js";\nimport { getMilestoneLifecycleShadowSnapshot } from "./db/queries.js";',
  ).replace(
    "const milestone = getMilestone(dispatchCtx.mid);",
    "const milestone = getMilestone(dispatchCtx.mid); getMilestoneLifecycleShadowSnapshot(dispatchCtx.mid);",
  );
  assert.notEqual(resolverCutover, pristine.resolver, "controlled resolver sabotage must be applied");
  const resolverChecks = analyzeNoCutoverSources({ ...pristine, resolver: resolverCutover });
  assert.equal(
    resolverChecks.find((check) => check.id === "dispatch-resolver-no-canonical-read")?.verdict,
    "fail",
  );

  const closeoutReadCutover = pristine.validation.replace(
    'import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";',
    'import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";\nimport { readMilestoneCloseoutReadiness } from "./db/milestone-closeout-readiness.js";',
  ).replace(
    "  const assessment = getLatestAssessmentByScope(milestoneId, \"milestone-validation\");",
    "  readMilestoneCloseoutReadiness(milestoneId);\n  const assessment = getLatestAssessmentByScope(milestoneId, \"milestone-validation\");",
  );
  assert.notEqual(closeoutReadCutover, pristine.validation, "controlled closeout-read sabotage must be applied");
  const closeoutReadChecks = analyzeNoCutoverSources({ ...pristine, validation: closeoutReadCutover });
  assert.equal(
    closeoutReadChecks.find((check) => check.id === "validation-assessment-authority")?.verdict,
    "fail",
  );

  const localWitnessImpersonation = pristine.validation.replace(
    'import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";',
    'import { isDbAvailable } from "./gsd-db.js";\nfunction getLatestAssessmentByScope() { return undefined; }',
  );
  assert.notEqual(
    localWitnessImpersonation,
    pristine.validation,
    "controlled local witness impersonation must be applied",
  );
  const localWitnessChecks = analyzeNoCutoverSources({ ...pristine, validation: localWitnessImpersonation });
  assert.equal(
    localWitnessChecks.find((check) => check.id === "validation-assessment-authority")?.verdict,
    "fail",
  );

  const omittedValidationCutover = pristine.validation.replace(
    "  return status && isValidMilestoneVerdict(status) ? status : undefined;",
    "  if (status === \"omitted\") return status;\n  return status && isValidMilestoneVerdict(status) ? status : undefined;",
  );
  assert.notEqual(
    omittedValidationCutover,
    pristine.validation,
    "controlled omitted-validation sabotage must be applied",
  );
  const omittedValidationChecks = analyzeNoCutoverSources({
    ...pristine,
    validation: omittedValidationCutover,
  });
  assert.equal(
    omittedValidationChecks.find((check) => check.id === "validation-assessment-authority")?.verdict,
    "fail",
  );

  const namespaceCutover = pristine.eligibility.replace(
    "const state = await deriveState(basePath);",
    "const state = await deriveState(basePath); const readCanonical = () => lifecycleQueries.getMilestoneLifecycleShadowSnapshot('M001'); readCanonical();",
  ).replace(
    "import { deriveState } from \"./state.js\";",
    "import { deriveState } from \"./state.js\";\nimport * as lifecycleQueries from './db/queries.js';",
  );
  const namespaceChecks = analyzeNoCutoverSources({ ...pristine, eligibility: namespaceCutover });
  assert.equal(
    namespaceChecks.find((check) => check.id === "parallel-eligibility-authority")?.verdict,
    "fail",
  );

  for (const aliasCutover of [
    pristine.eligibility.replace(
      "const state = await deriveState(basePath);",
      "const state = await deriveState(basePath); const readCanonical = getMilestoneLifecycleShadowSnapshot; readCanonical('M001');",
    ).replace(
      "import { deriveState } from \"./state.js\";",
      "import { deriveState } from \"./state.js\";\nimport { getMilestoneLifecycleShadowSnapshot } from './db/queries.js';",
    ),
    pristine.eligibility.replace(
      "const state = await deriveState(basePath);",
      "const state = await deriveState(basePath); const { getMilestoneLifecycleShadowSnapshot: readCanonical } = lifecycleQueries; readCanonical('M001');",
    ).replace(
      "import { deriveState } from \"./state.js\";",
      "import { deriveState } from \"./state.js\";\nimport * as lifecycleQueries from './db/queries.js';",
    ),
  ]) {
    const aliasChecks = analyzeNoCutoverSources({ ...pristine, eligibility: aliasCutover });
    assert.equal(
      aliasChecks.find((check) => check.id === "parallel-eligibility-authority")?.verdict,
      "fail",
    );
  }

  assert.throws(
    () => analyzeLocalInputBoundary("import { Octokit } from '@octokit/rest';\nprocess.env.GITHUB_REF;"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("import '@octokit/rest';"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("process.env['GITHUB_REF'];"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary(
      "import { spawnSync as run } from 'node:child_process'; run('gh', ['pr', 'list']);",
    ),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("const key = 'GITHUB_REF'; process.env[key];"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary(
      "import { spawnSync } from 'node:child_process'; const command = 'gh'; spawnSync(command, ['release', 'list']);",
    ),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary(
      "import { spawnSync } from 'child_process'; spawnSync('gh', ['pr', 'list']);",
    ),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("const env = process.env; env.GITHUB_REF;"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("const env = process.env; const { GH_TOKEN: token } = env;"),
    /hosted metadata/,
  );
  assert.throws(
    () => analyzeLocalInputBoundary("function read(key) { return process.env[key]; }"),
    /hosted metadata/,
  );
  assert.doesNotThrow(
    () => analyzeLocalInputBoundary("const key = 'SAFE_LOCAL_INPUT'; process.env[key];"),
  );
  assert.throws(
    () => analyzeLocalInputBoundary("const url = 'https://api.github.com/repos/open-gsd/gsd-pi/tags'; fetch(url);"),
    /external network/,
  );
  assert.doesNotThrow(() => analyzeLocalInputBoundary("console.log('release complete');"));
  assert.ok(analyzeNoCutoverSources(pristine).every((check) => check.verdict === "pass"));
});

test("gate fails closed for missing witnesses and child regressions, then restores", () => {
  const witness = NO_CUTOVER_BEHAVIORAL_WITNESSES[0];
  const spawnResult = (status: number, stdout = "") => ({
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  });
  const successfulChild = (() => spawnResult(
    0,
    `ok 1 - ${witness.title}\n`,
  )) as unknown as typeof import("node:child_process").spawnSync;

  const missing = runSemanticShadowNoCutoverGate({
    sourceLoader: loadSource,
    spawnSyncImpl: successfulChild,
    witnesses: [{
      id: "missing",
      file: witness.file,
      title: "controlled missing witness",
    }],
  });
  assert.equal(missing.verdict, "fail");
  assert.match(missing.behavioralChecks[0].error, /missing runnable witness/);

  const childFailure = runSemanticShadowNoCutoverGate({
    sourceLoader: loadSource,
    spawnSyncImpl: (() => ({
      ...spawnResult(7),
      stderr: "controlled",
    })) as unknown as typeof import("node:child_process").spawnSync,
    witnesses: [witness],
  });
  assert.equal(childFailure.verdict, "fail");
  assert.equal(childFailure.behavioralChecks[0].exitCode, 7);

  const skippedWitness = runSemanticShadowNoCutoverGate({
    sourceLoader: loadSource,
    spawnSyncImpl: (() => spawnResult(
      0,
      `ok 1 - ${witness.title} # SKIP\n`,
    )) as unknown as typeof import("node:child_process").spawnSync,
    witnesses: [witness],
  });
  assert.equal(skippedWitness.verdict, "fail");
  assert.match(skippedWitness.behavioralChecks[0].error, /missing runnable witness/);

  let capturedEnvironment: NodeJS.ProcessEnv | undefined;
  const restored = runSemanticShadowNoCutoverGate({
    sourceLoader: loadSource,
    spawnSyncImpl: ((_executable: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      capturedEnvironment = options.env;
      return spawnResult(0, `ok 1 - ${witness.title}\n`);
    }) as unknown as typeof import("node:child_process").spawnSync,
    environment: { SAFE_LOCAL_INPUT: "yes", GITHUB_REF: "refs/tags/v0", GH_TOKEN: "ignored" },
    witnesses: [witness],
  });
  assert.equal(restored.verdict, "pass");
  assert.equal(restored.githubMetadataUsed, false);
  assert.equal(capturedEnvironment?.SAFE_LOCAL_INPUT, "yes");
  assert.equal(capturedEnvironment?.GITHUB_REF, undefined);
  assert.equal(capturedEnvironment?.GH_TOKEN, undefined);
  assert.deepEqual(parseArgs(["--json"]), { json: true });
  assert.throws(() => parseArgs(["--label", "approved"]), /Unknown argument/);
});
