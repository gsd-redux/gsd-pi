// Project/App: gsd-pi
// File Purpose: RED contracts for durable Milestone validation and DB-only completion readiness.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { clearPathCache } from "../paths.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneOptions,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

const tempDirs = new Set<string>();

type ValidationOptionsWithInvocation = ValidateMilestoneOptions & {
  invocation: ExecutionInvocation;
};

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "milestone-validation-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void = () => {},
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function makeBase(plannedUat = ""): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-validation-domain-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'validated';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({
    id: "M001",
    title: "Milestone validation",
    status: "active",
    planning: { verificationUat: plannedUat },
  });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  executeAtFence("test.milestone.fixture", "fixture/milestone/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  return basePath;
}

const validValidation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

function validationOptions(idempotencyKey: string): ValidationOptionsWithInvocation {
  return {
    invocation: invocation(idempotencyKey),
    skipBrowserEvidenceGate: true,
  };
}

async function validate(
  basePath: string,
  idempotencyKey: string,
  overrides: Partial<ValidateMilestoneParams> = {},
) {
  return handleValidateMilestone(
    { ...validValidation, ...overrides },
    basePath,
    validationOptions(idempotencyKey),
  );
}

async function complete(basePath: string) {
  return handleCompleteMilestone({
    milestoneId: "M001",
    title: "Milestone validation",
    oneLiner: "Validated closeout",
    narrative: "The Milestone is ready to close.",
    verificationPassed: true,
  }, basePath);
}

function sourceRevision(basePath: string): string {
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) throw new Error(source.error);
  return source.snapshot.aggregateRevision;
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Milestone validation commits one immutable receipt and exact replay adds no lineage", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/replay";

  const committed = await validate(basePath, key);
  assert.ok(!("error" in committed), "initial validation should commit");
  writeFileSync(committed.validationPath, "projection repair sentinel\n");
  const replayed = await validate(basePath, key);

  assert.ok(!("error" in replayed), "exact retry should replay");
  assert.equal(
    readFileSync(committed.validationPath, "utf8"),
    "projection repair sentinel\n",
    "exact Domain Operation replay must not repeat projection side effects",
  );
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate' AND idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one immutable operation receipt");
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE operation.operation_type = 'milestone.validate'
      AND operation.idempotency_key = '${key}'
  `).count, 1, "exact retry must retain one validation event");
});

test("Milestone validation rejects changed facts under the same execution identity", async () => {
  const basePath = makeBase();
  const key = "milestone-validate/public/conflict";
  await validate(basePath, key);

  await assert.rejects(
    () => validate(basePath, key, {
      verdict: "needs-attention",
      verdictRationale: "Conflicting facts under the same key.",
    }),
    /idempotency conflict/i,
  );
});

test("Milestone completion rejects a file-only passing validation", async () => {
  const basePath = makeBase();
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# File-only validation\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "a projection must not authorize completion");
  assert.match(result.error, /validation|database|evidence/i);
});

test("Milestone completion rejects passing validation made stale by a descendant lifecycle change", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  executeAtFence("test.task.reopened", "fixture/task/newer-revision", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });

  const result = await complete(basePath);

  assert.ok("error" in result, "stale validation must not authorize completion");
  assert.match(result.error, /stale|revision|current|source/i);
});

test("Milestone completion rejects passing validation after source changes", async () => {
  const basePath = makeBase();
  const validated = await validate(basePath, "milestone-validate/public/source-stale");
  assert.ok(!("error" in validated), "validation fixture should commit");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'changed after validation';\n");

  const result = await complete(basePath);

  assert.ok("error" in result, "validation for an older source must not authorize completion");
  assert.match(result.error, /source|revision|current|stale/i);
});

test("Milestone completion rejects newer failed DB evidence despite a passing validation file", async () => {
  const basePath = makeBase();
  const passing = await validate(basePath, "milestone-validate/public/pass-before-failure");
  assert.ok(!("error" in passing), "passing validation fixture should commit");
  const failed = await validate(basePath, "milestone-validate/public/newer-failure", {
    verdict: "needs-attention",
    verdictRationale: "The latest database evidence does not pass.",
  });
  assert.ok(!("error" in failed), "newer failed validation fixture should commit");
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: pass\n---\n# Stale passing projection\n",
  );

  const result = await complete(basePath);

  assert.ok("error" in result, "newer failed database evidence must block completion");
  assert.match(result.error, /needs-attention|validation|evidence/i);
});

test("planned UAT cannot pass from prose without a current database UAT fact", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await validate(basePath, "milestone-validate/public/missing-uat", {
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Not run | PASS |",
  });

  assert.ok("error" in result, "required UAT must be backed by current database evidence");
  assert.match(result.error, /UAT|evidence|database|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "rejected UAT must leave no validation operation");
});

test("planned UAT passes only with source-bound structured browser evidence", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");
  const params = {
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: sourceRevision(basePath),
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  } as ValidateMilestoneParams & {
    verificationEvidence: Array<Record<string, unknown>>;
  };

  const result = await handleValidateMilestone(
    params,
    basePath,
    validationOptions("milestone-validate/public/structured-uat"),
  );

  assert.ok(!("error" in result), `unexpected validation error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(db().prepare(`
    SELECT criterion.criterion_key, criterion.evidence_class, verdict.verdict, evidence.observation
    FROM workflow_acceptance_criteria criterion
    JOIN workflow_technical_verdicts verdict ON verdict.criterion_id = criterion.criterion_id
    JOIN workflow_verification_evidence evidence ON evidence.verdict_id = verdict.verdict_id
    WHERE criterion.criterion_key = 'milestone-validation:uat'
  `).get(), {
    criterion_key: "milestone-validation:uat",
    evidence_class: "browser",
    verdict: "pass",
    observation: "passed",
  });
});

test("planned UAT rejects structured evidence from an older source revision", async () => {
  const basePath = makeBase("Run the browser acceptance journey.");

  const result = await handleValidateMilestone({
    ...validValidation,
    verificationClasses:
      "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| UAT | Browser journey | PASS |",
    verificationEvidence: [{
      verificationClass: "UAT",
      evidenceClass: "browser",
      commandOrTool: "browser acceptance journey",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      testedSourceRevision: "sha256:stale-source",
      observation: "passed",
      durableOutputRef: "artifact://browser/acceptance-journey",
      environment: { runner: "browser", route: "/acceptance" },
      rationale: "The user-visible acceptance journey passed.",
    }],
  }, basePath, validationOptions("milestone-validate/public/stale-structured-uat"));

  assert.ok("error" in result, "evidence from another source revision must fail closed");
  assert.match(result.error, /source|revision|current/i);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.validate'
  `).count, 0, "stale evidence must not create a canonical validation receipt");
});
