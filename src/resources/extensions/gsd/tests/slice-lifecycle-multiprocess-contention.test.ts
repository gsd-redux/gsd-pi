// Project/App: gsd-pi
// File Purpose: Persistent multi-process contention contract for Slice lifecycle operations.

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { closeDatabase, _getAdapter } from "../gsd-db.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";
import { createWorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

type SliceOperationKind = "complete" | "cancel" | "reopen";

interface DurableCounts {
  revision: number;
  operations: number;
  events: number;
  outbox: number;
  projections: number;
  gateRuns: number;
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface SliceReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  [key: string]: unknown;
}

interface WorkerOutcome {
  idempotencyKey: string;
  receipt?: SliceReceipt;
  error?: {
    code: string;
    message: string;
  };
}

const WORKER_SCRIPT = `
  import { existsSync, writeFileSync } from "node:fs";

  const [
    databaseHref,
    lifecycleHref,
    kind,
    idempotencyKey,
    dbPath,
    readyPath,
    attemptPath,
    releasePath,
  ] = process.argv.slice(-8);
  const [{ openDatabase, closeDatabase }, { cancelSlice, completeSlice, reopenSlice }] = await Promise.all([
    import(databaseHref),
    import(lifecycleHref),
  ]);
  if (!openDatabase(dbPath)) throw new Error("contention worker could not open the workflow database");
  writeFileSync(readyPath, String(process.pid), "utf8");
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 2));
  writeFileSync(attemptPath, String(process.pid), "utf8");

  const invocation = {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "system",
    actorId: "slice-contention-test",
    traceId: "trace/" + idempotencyKey,
    turnId: "turn/" + idempotencyKey,
  };
  const slice = { milestoneId: "M001", sliceId: kind === "reopen" ? "S01" : "S02" };
  const closeout = {
    sliceTitle: "Contention contract",
    oneLiner: "One Slice lifecycle operation wins a multi-process race.",
    narrative: "Every same-key retry receives the committed durable receipt.",
    verification: "Two-process persistent SQLite contention test",
    uatContent: "## UAT Type\\n\\n- UAT mode: runtime-executable\\n\\nPASS",
    operationalReadiness: "The authoritative operation is replay-safe.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    provides: [],
    requires: [],
    affects: [],
    keyFiles: [],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    drillDownPaths: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsSurfaced: [],
    requirementsInvalidated: [],
    filesModified: [],
  };

  const outcome = { idempotencyKey };
  try {
    if (kind === "complete") {
      outcome.receipt = completeSlice({ invocation, slice, closeout });
    } else if (kind === "cancel") {
      outcome.receipt = cancelSlice({ invocation, slice, reason: "The remaining Slice work is no longer required." });
    } else {
      outcome.receipt = reopenSlice({ invocation, slice, reason: "The completed Slice must be redone." });
    }
  } catch (error) {
    outcome.error = {
      code: String(error?.code ?? "UNKNOWN"),
      message: String(error?.message ?? error),
    };
  } finally {
    closeDatabase();
  }
  process.stdout.write("SLICE_OUTCOME=" + JSON.stringify(outcome) + "\\n");
`;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "test database must be open");
  return adapter;
}

function durableCounts(): DurableCounts {
  const count = (table: string): number => Number(
    db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"],
  );
  return {
    revision: Number(db().prepare("SELECT revision FROM project_authority WHERE singleton = 1").get()?.["revision"]),
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    outbox: count("workflow_outbox"),
    projections: count("workflow_projection_work"),
    gateRuns: count("gate_runs"),
  };
}

type ContentionWorker = ChildProcessByStdio<null, Readable, Readable>;

function spawnWorker(
  kind: SliceOperationKind,
  idempotencyKey: string,
  dbPath: string,
  readyPath: string,
  attemptPath: string,
  releasePath: string,
): ContentionWorker {
  const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
  const databaseHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts"),
  ).href;
  const lifecycleHref = pathToFileURL(
    join(process.cwd(), "src/resources/extensions/gsd/slice-lifecycle-domain-operation.ts"),
  ).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, [
    "--import",
    resolver,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    WORKER_SCRIPT,
    databaseHref,
    lifecycleHref,
    kind,
    idempotencyKey,
    dbPath,
    readyPath,
    attemptPath,
    releasePath,
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFiles(
  paths: string[],
  children: ContentionWorker[],
  description: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!paths.every(existsSync)) {
    const exited = children.find((child) => child.exitCode !== null);
    assert.equal(exited, undefined, `a contention worker exited before ${description}`);
    assert.ok(Date.now() < deadline, `contention workers did not reach ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function collectChild(child: ContentionWorker): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function parseOutcome(result: ChildResult): WorkerOutcome {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("SLICE_OUTCOME="));
  assert.ok(line, `contention worker did not return a Slice outcome: ${result.stdout}`);
  return JSON.parse(line.slice("SLICE_OUTCOME=".length)) as WorkerOutcome;
}

function replayPayload(receipt: SliceReceipt): Omit<SliceReceipt, "status"> {
  const { status: _, ...payload } = receipt;
  return payload;
}

function seedOperation(kind: SliceOperationKind): void {
  seedSliceCompletionAuthority({
    milestoneId: "M001",
    sliceId: kind === "reopen" ? "S01" : "S02",
    completedTaskIds: kind === "complete" || kind === "reopen" ? ["T01"] : [],
    runId: `contention-${kind}`,
  });
}

function assertAuthoritativeOutcome(kind: SliceOperationKind): void {
  const sliceId = kind === "reopen" ? "S01" : "S02";
  const expected = {
    complete: { slice: "complete", task: "complete" },
    cancel: { slice: "skipped", task: "skipped" },
    reopen: { slice: "in_progress", task: "pending" },
  }[kind];
  assert.equal(db().prepare(`
    SELECT status FROM slices WHERE milestone_id = 'M001' AND id = :slice_id
  `).get({ ":slice_id": sliceId })?.["status"], expected.slice);
  assert.equal(db().prepare(`
    SELECT status FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = :slice_id AND id = 'T01'
  `).get({ ":slice_id": sliceId })?.["status"], expected.task);
}

function terminateWorkers(
  children: ContentionWorker[],
  results: Array<Promise<ChildResult>>,
): Promise<PromiseSettledResult<ChildResult>[]> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  return Promise.allSettled(results);
}

for (const kind of ["complete", "cancel", "reopen"] as const) {
  test(`${kind} same-key contention commits once and returns one replay-equivalent receipt`, { concurrency: false }, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    const children: ContentionWorker[] = [];
    const results: Array<Promise<ChildResult>> = [];
    t.after(async () => {
      await terminateWorkers(children, results);
      fixture.cleanup();
    });
    seedOperation(kind);
    const before = durableCounts();
    const readyPaths = [join(fixture.root, `ready-${kind}-1`), join(fixture.root, `ready-${kind}-2`)];
    const attemptPaths = [join(fixture.root, `attempt-${kind}-1`), join(fixture.root, `attempt-${kind}-2`)];
    const releasePath = join(fixture.root, `release-${kind}`);
    closeDatabase();

    const key = `slice-contention/${kind}/same-key`;
    children.push(...readyPaths.map((readyPath, index) => spawnWorker(
      kind,
      key,
      fixture.dbPath,
      readyPath,
      attemptPaths[index]!,
      releasePath,
    )));
    results.push(...children.map(collectChild));
    await waitForFiles(readyPaths, children, "reaching the start barrier");
    writeFileSync(releasePath, "go", "utf8");
    const outcomes = (await Promise.all(results)).map(parseOutcome);
    fixture.reopen();

    const receipts = outcomes.map((outcome) => {
      assert.equal(outcome.error, undefined);
      assert.ok(outcome.receipt, "same-key worker must return a Slice receipt");
      return outcome.receipt;
    });
    assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ["committed", "replayed"]);
    assert.deepEqual(replayPayload(receipts[0]!), replayPayload(receipts[1]!));
    assert.deepEqual(durableCounts(), {
      revision: before.revision + 1,
      operations: before.operations + 1,
      events: before.events + 1,
      outbox: before.outbox + 1,
      projections: before.projections + 1,
      gateRuns: before.gateRuns + (kind === "complete" ? 1 : 0),
    });
    assert.deepEqual(
      db().prepare(`
        SELECT operation.operation_id, operation.operation_type, operation.idempotency_key,
               COUNT(DISTINCT event.event_id) AS event_count,
               COUNT(DISTINCT outbox.outbox_id) AS outbox_count,
               COUNT(DISTINCT projection.projection_work_id) AS projection_count
        FROM workflow_operations operation
        JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
        JOIN workflow_outbox outbox ON outbox.event_id = event.event_id
        JOIN workflow_projection_work projection ON projection.enqueue_operation_id = operation.operation_id
        WHERE operation.idempotency_key = :idempotency_key
        GROUP BY operation.operation_id, operation.operation_type, operation.idempotency_key
      `).all({ ":idempotency_key": key }),
      [{
        operation_id: receipts[0]!.operationId,
        operation_type: `slice.${kind}`,
        idempotency_key: key,
        event_count: 1,
        outbox_count: 1,
        projection_count: 1,
      }],
    );
    assertAuthoritativeOutcome(kind);
  });

  test(`${kind} different-key contention rejects one stale writer without residue`, { concurrency: false }, async (t) => {
    const fixture = await createWorkflowAuthorityFixture();
    const children: ContentionWorker[] = [];
    const results: Array<Promise<ChildResult>> = [];
    let lockHeld = false;
    t.after(async () => {
      if (lockHeld) db().exec("ROLLBACK");
      await terminateWorkers(children, results);
      fixture.cleanup();
    });
    seedOperation(kind);
    const before = durableCounts();
    const keys = [`slice-contention/${kind}/writer-1`, `slice-contention/${kind}/writer-2`];
    const readyPaths = keys.map((_, index) => join(
      fixture.root,
      `ready-${kind}-different-${index + 1}`,
    ));
    const attemptPaths = keys.map((_, index) => join(
      fixture.root,
      `attempt-${kind}-different-${index + 1}`,
    ));
    const releasePath = join(fixture.root, `release-${kind}-different`);

    children.push(...keys.map((key, index) => spawnWorker(
      kind,
      key,
      fixture.dbPath,
      readyPaths[index]!,
      attemptPaths[index]!,
      releasePath,
    )));
    results.push(...children.map(collectChild));
    await waitForFiles(readyPaths, children, "reaching the start barrier");
    db().exec("BEGIN IMMEDIATE");
    lockHeld = true;
    writeFileSync(releasePath, "go", "utf8");
    await waitForFiles(attemptPaths, children, "entering the lifecycle command boundary");
    await new Promise((resolve) => setTimeout(resolve, 50));
    db().exec("COMMIT");
    lockHeld = false;

    const outcomes = (await Promise.all(results)).map(parseOutcome);
    const winners = outcomes.filter((outcome) => outcome.receipt !== undefined);
    const losers = outcomes.filter((outcome) => outcome.error !== undefined);
    assert.equal(winners.length, 1, "exactly one different-key writer must commit");
    assert.equal(losers.length, 1, "exactly one different-key writer must be rejected");
    const winner = winners[0]!;
    const loser = losers[0]!;
    assert.equal(winner.receipt!.status, "committed");
    assert.equal(loser.error!.code, "GSD_REVISION_CONFLICT");
    assert.match(loser.error!.message, /stale (?:project revision|authority epoch)/i);
    assert.deepEqual(durableCounts(), {
      revision: before.revision + 1,
      operations: before.operations + 1,
      events: before.events + 1,
      outbox: before.outbox + 1,
      projections: before.projections + 1,
      gateRuns: before.gateRuns + (kind === "complete" ? 1 : 0),
    });
    assert.deepEqual(db().prepare(`
      SELECT idempotency_key FROM workflow_operations
      WHERE idempotency_key IN (:winner_key, :loser_key)
    `).all({
      ":winner_key": winner.idempotencyKey,
      ":loser_key": loser.idempotencyKey,
    }), [{ idempotency_key: winner.idempotencyKey }]);
    assert.equal(db().prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_domain_events event
      JOIN workflow_operations operation ON operation.operation_id = event.operation_id
      WHERE operation.idempotency_key = :loser_key
    `).get({ ":loser_key": loser.idempotencyKey })?.["count"], 0);
    assert.equal(db().prepare(`
      SELECT COUNT(*) AS count
      FROM workflow_projection_work projection
      JOIN workflow_operations operation ON operation.operation_id = projection.enqueue_operation_id
      WHERE operation.idempotency_key = :loser_key
    `).get({ ":loser_key": loser.idempotencyKey })?.["count"], 0);
    assertAuthoritativeOutcome(kind);
  });
}
