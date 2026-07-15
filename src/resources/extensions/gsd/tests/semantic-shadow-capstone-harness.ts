// Project/App: gsd-pi
// File Purpose: Disposable collection and fail-closed normalization of semantic-shadow capstone evidence.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
  type LifecycleShadowRepairReceipt,
} from "../lifecycle-shadow-repair-domain-operation.ts";
import type {
  LifecycleShadowObservation,
  LifecycleShadowObservationItem,
  LifecycleShadowObservationLossAccounting,
} from "../lifecycle-shadow-observation.ts";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.ts";
import {
  captureMilestoneVerificationSourceRevision,
} from "../verification-source-integrity.ts";

export const M003_S07_DOSSIER_SOURCE_EXCLUSIONS = [
  "docs/dev/m003-s07-cutover-dossier.json",
] as const;

export const CAPSTONE_MODES = [
  "auto",
  "interactive",
  "guided",
  "uok",
  "custom",
  "legacy",
] as const;

export const CAPSTONE_TRANSPORTS = ["native_pi", "workflow_mcp"] as const;

export const CAPSTONE_CLASSIFICATIONS = [
  "extra_shadow",
  "match",
  "missing_shadow",
  "semantic_match_exact_delta",
  "status_mismatch",
] as const;

export const CAPSTONE_DISPOSITIONS = [
  "advanced",
  "repaired",
  "unresolved",
  "rejected",
  "observation_loss",
] as const;

const LOSS_REASONS = [
  "context_resolution_failed",
  "shadow_query_failed",
  "primary_sink_failed",
  "projection_sink_failed",
] as const;

export interface CapstoneObservationEnvelope extends LifecycleShadowObservation {
  responseHash: string;
}

export interface CapstoneDispositionEvidence {
  disposition: typeof CAPSTONE_DISPOSITIONS[number];
  sourceRevision: string;
  proof: Record<string, unknown>;
}

export interface SemanticShadowCapstoneEvidence {
  schemaVersion: 1;
  sourceRevision: string;
  responseHash: string;
  observations: CapstoneObservationEnvelope[];
  dispositions: CapstoneDispositionEvidence[];
}

interface NormalizedObservationItem {
  itemIdentity: Omit<LifecycleShadowObservationItem["itemIdentity"], "lifecycleId"> & {
    lifecyclePresent: boolean;
  };
  rawLegacyStatus: string | null;
  rawCanonicalStatus: string | null;
  normalizedLegacyStatus: string | null;
  normalizedCanonicalStatus: string | null;
  classification: typeof CAPSTONE_CLASSIFICATIONS[number];
}

interface NormalizedCapstoneObservationEnvelope extends Omit<CapstoneObservationEnvelope, "items"> {
  items: NormalizedObservationItem[];
}

export interface NormalizedSemanticShadowCapstoneEvidencePayload extends Omit<SemanticShadowCapstoneEvidence, "observations"> {
  observations: NormalizedCapstoneObservationEnvelope[];
}

export interface NormalizedSemanticShadowCapstoneEvidence {
  evidence: NormalizedSemanticShadowCapstoneEvidencePayload;
  evidenceHash: string;
}

interface CapstoneCollectorDependencies {
  captureSourceRevision?: typeof captureMilestoneVerificationSourceRevision;
}

function fail(message: string): never {
  throw new Error(`Invalid semantic-shadow capstone evidence: ${message}`);
}

function db() {
  const adapter = _getAdapter();
  if (!adapter) throw new Error("semantic-shadow capstone fixture database is unavailable");
  return adapter;
}

function seedLifecycle(
  identity: LifecycleIdentity,
  lifecycleStatus: CanonicalLifecycleStatus,
  key: string,
): void {
  const payload: DomainJsonValue = {
    itemKind: identity.itemKind,
    milestoneId: identity.milestoneId,
    sliceId: identity.sliceId ?? null,
    taskId: identity.taskId ?? null,
    lifecycleStatus,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.semantic-shadow-capstone.seed",
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
        eventType: "test.semantic-shadow-capstone.seeded",
        entityType: identity.itemKind,
        entityId: [identity.milestoneId, identity.sliceId, identity.taskId].filter(Boolean).join("/"),
        payload,
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: key, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

function seedFixture(): void {
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES
      ('M001', 'Capstone milestone', 'pending', '2026-07-15T00:00:00.000Z'),
      ('M002', 'Repair milestone', 'active', '2026-07-15T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, sequence, created_at)
    VALUES
      ('M001', 'S01', 'Observed slice', 'active', 1, '2026-07-15T00:00:00.000Z'),
      ('M001', 'S02', 'Missing shadow slice', 'queued', 2, '2026-07-15T00:00:00.000Z'),
      ('M002', 'S01', 'Repair slice', 'active', 1, '2026-07-15T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, sequence, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      ('M001', 'S01', 'T01', 'Extra shadow task', 'pending', 1, NULL, '', '', '', ''),
      ('M001', 'S01', 'T02', 'Mismatched task', 'done', 2, NULL, '', '', '', ''),
      ('M002', 'S01', 'A', 'Advance repair', 'complete', 1,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# A summary'),
      ('M002', 'S01', 'R', 'Adopt repair', 'complete', 2,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# R summary'),
      ('M002', 'S01', 'U', 'Unresolved repair', 'complete', 3, NULL, '', '', '', ''),
      ('M002', 'S01', 'X', 'Rejected repair', 'complete', 4,
       '2026-07-15T01:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# X summary');
  `);

  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "pending", "capstone/matrix/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "in_progress", "capstone/matrix/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "capstone/matrix/extra",
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T02" },
    "paused",
    "capstone/matrix/mismatch",
  );
  seedLifecycle(
    { itemKind: "task", milestoneId: "M002", sliceId: "S01", taskId: "A" },
    "ready",
    "capstone/repair/advance-seed",
  );

  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    DELETE FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  db().exec("PRAGMA foreign_keys = ON");
}

function expectedResponse() {
  const result = {
    milestoneId: "M001",
    title: "Capstone milestone",
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

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function observationPayloads(basePath: string): LifecycleShadowObservation[] {
  const observationDb = openIsolatedDatabase(join(basePath, ".gsd", "gsd.db"));
  if (!observationDb) throw new Error("semantic-shadow capstone observation database is unavailable");
  const rows = observationDb.prepare(`
    SELECT payload_json FROM audit_events
    WHERE type = 'lifecycle-shadow-observed'
    ORDER BY ts, event_id
  `).all();
  observationDb.close();
  return rows.map((row) => JSON.parse(String(row["payload_json"])) as LifecycleShadowObservation);
}

function repairInvocation(key: string) {
  return {
    idempotencyKey: key,
    sourceTransport: "internal" as const,
    actorType: "agent" as const,
    actorId: "semantic-shadow-capstone",
  };
}

function repairTask(taskId: string) {
  return { itemKind: "task" as const, milestoneId: "M002", sliceId: "S01", taskId };
}

function authoritySnapshot(): Record<string, unknown> {
  return {
    authority: db().prepare("SELECT revision, authority_epoch FROM project_authority").get(),
    lifecycles: db().prepare("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
    operations: db().prepare("SELECT * FROM workflow_operations ORDER BY operation_id").all(),
    events: db().prepare("SELECT * FROM workflow_domain_events ORDER BY event_id").all(),
    projections: db().prepare("SELECT * FROM workflow_projection_work ORDER BY projection_work_id").all(),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function replayMatches(
  committed: LifecycleShadowRepairReceipt,
  replayed: LifecycleShadowRepairReceipt,
): boolean {
  return sameValue(committed, { ...replayed, status: "committed" });
}

export async function collectSemanticShadowCapstoneEvidence(
  input: { sourceRoot: string },
  dependencies: CapstoneCollectorDependencies = {},
): Promise<SemanticShadowCapstoneEvidence> {
  const sourceRoot = resolve(input.sourceRoot);
  const captureSourceRevision = dependencies.captureSourceRevision
    ?? ((basePath, preferences) => captureMilestoneVerificationSourceRevision(
      basePath,
      preferences,
      { excludePaths: M003_S07_DOSSIER_SOURCE_EXCLUSIONS },
    ));
  const source = captureSourceRevision(sourceRoot, undefined);
  if (!source.ok) throw new Error(`Unable to capture semantic-shadow source: ${source.error}`);

  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-capstone-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  try {
    if (!openDatabase(join(basePath, ".gsd", "gsd.db"))) {
      throw new Error("Unable to open semantic-shadow capstone fixture database");
    }
    seedFixture();
    const frozenResponse = expectedResponse();
    const responseHash = stableHash(frozenResponse);
    for (const mode of CAPSTONE_MODES) {
      for (const transport of CAPSTONE_TRANSPORTS) {
        const response = await executeMilestoneStatus(
          { milestoneId: "M001" },
          basePath,
          {
            mode,
            transport,
            sourceRevision: source.sourceRevision,
            traceId: `trace:${mode}:${transport}`,
            turnId: `turn:${mode}:${transport}`,
          },
        );
        if (!sameValue(response.content, frozenResponse.content) || !sameValue(response.details, frozenResponse.structured)) {
          throw new Error(`Milestone status response changed for ${mode}/${transport}`);
        }
      }
    }
    const cleanObservations = observationPayloads(basePath);

    const advanced = repairLifecycleShadowForward({
      invocation: repairInvocation("capstone/repair/advanced"),
      item: repairTask("A"),
    });
    const repairedInput = {
      invocation: repairInvocation("capstone/repair/repaired"),
      item: repairTask("R"),
    };
    const repaired = repairLifecycleShadowForward(repairedInput);
    const afterRepair = authoritySnapshot();
    const replayed = repairLifecycleShadowForward(repairedInput);
    const repairedReplayEqual = replayMatches(repaired, replayed);
    const repairedAuthorityUnchanged = sameValue(afterRepair, authoritySnapshot());
    const unresolved = repairLifecycleShadowForward({
      invocation: repairInvocation("capstone/repair/unresolved"),
      item: repairTask("U"),
    });

    const beforeRejected = authoritySnapshot();
    _setLifecycleShadowRepairBeforeCommitForTest(() => {
      db().prepare("UPDATE tasks SET full_summary_md = '# changed' WHERE milestone_id = 'M002' AND id = 'X'").run();
    });
    let rejected = false;
    try {
      repairLifecycleShadowForward({
        invocation: repairInvocation("capstone/repair/rejected"),
        item: repairTask("X"),
      });
    } catch (error) {
      rejected = /stable durable completion evidence/i.test(String((error as Error).message));
    } finally {
      _setLifecycleShadowRepairBeforeCommitForTest(null);
    }
    const rejectedAuthorityUnchanged = sameValue(beforeRejected, authoritySnapshot());

    db().exec("PRAGMA foreign_keys = OFF");
    db().exec("ALTER TABLE workflow_item_lifecycles RENAME TO unavailable_workflow_item_lifecycles");
    db().exec("PRAGMA foreign_keys = ON");
    const lossResponse = await executeMilestoneStatus(
      { milestoneId: "M001" },
      basePath,
      {
        mode: "legacy",
        transport: "native_pi",
        sourceRevision: source.sourceRevision,
        traceId: "trace:observation-loss",
        turnId: "turn:observation-loss",
      },
    );
    if (!sameValue(lossResponse.content, frozenResponse.content) || !sameValue(lossResponse.details, frozenResponse.structured)) {
      throw new Error("Milestone status response changed during observation loss");
    }
    const lossObservation = observationPayloads(basePath).at(-1);
    if (!lossObservation) throw new Error("Observation-loss evidence was not persisted");

    const evidence: SemanticShadowCapstoneEvidence = {
      schemaVersion: 1,
      sourceRevision: source.sourceRevision,
      responseHash,
      observations: cleanObservations.map((observation) => ({ ...observation, responseHash })),
      dispositions: [
        {
          disposition: "advanced",
          sourceRevision: source.sourceRevision,
          proof: { beforeStatus: advanced.beforeStatus, afterStatus: advanced.afterStatus },
        },
        {
          disposition: "repaired",
          sourceRevision: source.sourceRevision,
          proof: {
            beforeStatus: repaired.beforeStatus,
            afterStatus: repaired.afterStatus,
            replayEqual: repairedReplayEqual,
            authorityUnchanged: repairedAuthorityUnchanged,
          },
        },
        {
          disposition: "unresolved",
          sourceRevision: source.sourceRevision,
          proof: { beforeStatus: unresolved.beforeStatus, afterStatus: unresolved.afterStatus },
        },
        {
          disposition: "rejected",
          sourceRevision: source.sourceRevision,
          proof: { rejected, authorityUnchanged: rejectedAuthorityUnchanged },
        },
        {
          disposition: "observation_loss",
          sourceRevision: source.sourceRevision,
          proof: {
            observationLossAccounting: lossObservation.observationLossAccounting,
            responseHash: stableHash({ content: lossResponse.content, structured: lossResponse.details }),
          },
        },
      ],
    };
    const confirmedSource = captureSourceRevision(sourceRoot, undefined);
    if (!confirmedSource.ok) {
      throw new Error(`Unable to confirm semantic-shadow source: ${confirmedSource.error}`);
    }
    if (confirmedSource.sourceRevision !== source.sourceRevision) {
      throw new Error("Semantic-shadow source changed during collection");
    }
    return evidence;
  } finally {
    _setLifecycleShadowRepairBeforeCommitForTest(null);
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${field} must be a sha256 digest`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a nonblank string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${field} must be a nonnegative integer`);
  return Number(value);
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a string or null`);
  return value;
}

function normalizeLossAccounting(value: unknown): LifecycleShadowObservationLossAccounting {
  const loss = asRecord(value, "observation loss accounting");
  const normalized: LifecycleShadowObservationLossAccounting = {
    lossCount: requireInteger(loss["lossCount"], "lossCount"),
    persistedCount: requireInteger(loss["persistedCount"], "persistedCount"),
  };
  if (loss["reason"] !== undefined) {
    const reason = String(loss["reason"]) as typeof LOSS_REASONS[number];
    if (!LOSS_REASONS.includes(reason)) fail(`unsupported loss reason: ${reason}`);
    normalized.reason = reason;
  }
  if (loss["errorHash"] !== undefined) normalized.errorHash = requireSha256(loss["errorHash"], "loss errorHash");
  if (loss["causes"] !== undefined) {
    if (!Array.isArray(loss["causes"])) fail("loss causes must be an array");
    normalized.causes = loss["causes"].map((cause) => {
      const entry = asRecord(cause, "loss cause");
      const reason = String(entry["reason"]) as typeof LOSS_REASONS[number];
      if (!LOSS_REASONS.includes(reason)) fail(`unsupported loss cause: ${reason}`);
      return {
        reason,
        errorHash: requireSha256(entry["errorHash"], "loss cause errorHash"),
      };
    }).sort((left, right) => left.reason.localeCompare(right.reason));
  }
  return normalized;
}

function statusTupleConsistent(item: NormalizedObservationItem): boolean {
  const legacy = item.rawLegacyStatus;
  const canonical = item.rawCanonicalStatus;
  const normalizedLegacy = item.normalizedLegacyStatus;
  const normalizedCanonical = item.normalizedCanonicalStatus;
  switch (item.classification) {
    case "match":
      return legacy !== null && legacy === canonical && normalizedLegacy === normalizedCanonical;
    case "semantic_match_exact_delta":
      return legacy !== null && canonical !== null && legacy !== canonical
        && normalizedLegacy !== null && normalizedLegacy === normalizedCanonical;
    case "missing_shadow":
      return legacy !== null && canonical === null && normalizedLegacy !== null && normalizedCanonical === null;
    case "extra_shadow":
      return legacy === null && canonical !== null && normalizedLegacy === null && normalizedCanonical !== null;
    case "status_mismatch":
      return legacy !== null && canonical !== null
        && normalizedLegacy !== null && normalizedCanonical !== null
        && normalizedLegacy !== normalizedCanonical;
  }
}

function normalizeItem(value: unknown): NormalizedObservationItem {
  const item = asRecord(value, "observation item");
  const identity = asRecord(item["itemIdentity"], "observation item identity");
  const classification = String(item["classification"]) as typeof CAPSTONE_CLASSIFICATIONS[number];
  if (!CAPSTONE_CLASSIFICATIONS.includes(classification)) fail(`unsupported classification: ${classification}`);
  let lifecyclePresent: boolean;
  if ("lifecycleId" in identity) {
    lifecyclePresent = requireNullableString(identity["lifecycleId"], "lifecycleId") !== null;
  } else {
    if (typeof identity["lifecyclePresent"] !== "boolean") fail("lifecyclePresent must be boolean");
    lifecyclePresent = identity["lifecyclePresent"];
  }
  const itemKind = requireString(
    identity["itemKind"],
    "itemKind",
  ) as NormalizedObservationItem["itemIdentity"]["itemKind"];
  if (!["milestone", "slice", "task"].includes(itemKind)) fail(`unsupported itemKind: ${itemKind}`);
  const milestoneId = requireString(identity["milestoneId"], "milestoneId");
  const sliceId = requireNullableString(identity["sliceId"], "sliceId");
  const taskId = requireNullableString(identity["taskId"], "taskId");
  if (
    (itemKind === "milestone" && (sliceId !== null || taskId !== null))
    || (itemKind === "slice" && (sliceId === null || taskId !== null))
    || (itemKind === "task" && (sliceId === null || taskId === null))
  ) fail(`invalid ${itemKind} identity`);
  const normalized: NormalizedObservationItem = {
    itemIdentity: {
      itemKind,
      milestoneId,
      sliceId,
      taskId,
      lifecyclePresent,
    },
    rawLegacyStatus: requireNullableString(item["rawLegacyStatus"], "rawLegacyStatus"),
    rawCanonicalStatus: requireNullableString(item["rawCanonicalStatus"], "rawCanonicalStatus"),
    normalizedLegacyStatus: requireNullableString(item["normalizedLegacyStatus"], "normalizedLegacyStatus"),
    normalizedCanonicalStatus: requireNullableString(item["normalizedCanonicalStatus"], "normalizedCanonicalStatus"),
    classification,
  };
  const expectedLifecyclePresence = classification !== "missing_shadow";
  if (lifecyclePresent !== expectedLifecyclePresence) {
    fail(`lifecycle presence conflicts with ${classification}`);
  }
  if (!statusTupleConsistent(normalized)) fail(`inconsistent status tuple for ${classification}`);
  return normalized;
}

function validateObservations(
  observations: unknown,
  sourceRevision: string,
  responseHash: string,
): NormalizedCapstoneObservationEnvelope[] {
  if (!Array.isArray(observations) || observations.length !== 12) {
    fail("exactly 12 observation envelopes are required");
  }
  const cells = new Set<string>();
  const normalized = observations.map((value) => {
    const observation = asRecord(value, "observation envelope");
    const mode = String(observation["mode"]) as typeof CAPSTONE_MODES[number];
    const transport = String(observation["transport"]) as typeof CAPSTONE_TRANSPORTS[number];
    if (!CAPSTONE_MODES.includes(mode) || !CAPSTONE_TRANSPORTS.includes(transport)) {
      fail(`unsupported observation cell: ${mode}/${transport}`);
    }
    const cell = `${mode}/${transport}`;
    if (cells.has(cell)) fail(`duplicate observation cell: ${cell}`);
    cells.add(cell);
    if (observation["sourceRevision"] !== sourceRevision) fail(`mixed source revision in ${cell}`);
    if (observation["responseHash"] !== responseHash) fail(`response neutrality changed in ${cell}`);
    const loss = normalizeLossAccounting(observation["observationLossAccounting"]);
    if (loss.lossCount !== 0 || loss.persistedCount !== 1) fail(`clean matrix observation loss in ${cell}`);
    if (loss.reason !== undefined || loss.errorHash !== undefined || loss.causes !== undefined) {
      fail(`clean matrix has spurious loss detail in ${cell}`);
    }
    if (!Array.isArray(observation["items"])) fail(`observation items are missing in ${cell}`);
    const items = observation["items"].map(normalizeItem).sort((left, right) =>
      CAPSTONE_CLASSIFICATIONS.indexOf(left.classification) - CAPSTONE_CLASSIFICATIONS.indexOf(right.classification)
    );
    if (items.length !== 5 || !items.every((item, index) => item.classification === CAPSTONE_CLASSIFICATIONS[index])) {
      fail(`classification set changed in ${cell}`);
    }
    const milestoneId = requireString(observation["milestoneId"], "observation milestoneId");
    if (milestoneId !== "M001") fail(`unexpected observation milestone: ${milestoneId}`);
    if (observation["repairDisposition"] !== "not_attempted") fail(`clean observation repair attempted in ${cell}`);
    return {
      milestoneId,
      items,
      mode,
      transport,
      sourceRevision,
      projectRevision: requireInteger(observation["projectRevision"], "projectRevision"),
      authorityEpoch: requireInteger(observation["authorityEpoch"], "authorityEpoch"),
      traceId: requireString(observation["traceId"], "traceId"),
      turnId: requireString(observation["turnId"], "turnId"),
      repairDisposition: "not_attempted" as const,
      observationLossAccounting: loss,
      responseHash,
    };
  });
  return normalized.sort((left, right) =>
    CAPSTONE_MODES.indexOf(left.mode) - CAPSTONE_MODES.indexOf(right.mode)
    || CAPSTONE_TRANSPORTS.indexOf(left.transport) - CAPSTONE_TRANSPORTS.indexOf(right.transport)
  );
}

function normalizeDispositionProof(disposition: string, proofValue: unknown, responseHash: string): Record<string, unknown> {
  const proof = asRecord(proofValue, `${disposition} proof`);
  if (disposition === "advanced") {
    if (proof["beforeStatus"] !== "ready" || proof["afterStatus"] !== "in_progress") fail("advanced proof is invalid");
    return { beforeStatus: "ready", afterStatus: "in_progress" };
  }
  if (disposition === "repaired") {
    if (
      proof["beforeStatus"] !== null
      || proof["afterStatus"] !== "completed"
      || proof["replayEqual"] !== true
      || proof["authorityUnchanged"] !== true
    ) fail("repaired proof must include exact residue-free replay equality");
    return { beforeStatus: null, afterStatus: "completed", replayEqual: true, authorityUnchanged: true };
  }
  if (disposition === "unresolved") {
    if (proof["beforeStatus"] !== null || proof["afterStatus"] !== null) fail("unresolved proof is invalid");
    return { beforeStatus: null, afterStatus: null };
  }
  if (disposition === "rejected") {
    if (proof["rejected"] !== true || proof["authorityUnchanged"] !== true) fail("rejected proof is invalid");
    return { rejected: true, authorityUnchanged: true };
  }
  const loss = normalizeLossAccounting(proof["observationLossAccounting"]);
  if (loss.lossCount < 1 || loss.persistedCount !== 1 || proof["responseHash"] !== responseHash) {
    fail("observation_loss proof must be persisted and response-neutral");
  }
  return { observationLossAccounting: loss, responseHash };
}

function validateDispositions(
  dispositions: unknown,
  sourceRevision: string,
  responseHash: string,
): CapstoneDispositionEvidence[] {
  if (!Array.isArray(dispositions) || dispositions.length !== 5) fail("exactly five disposition proofs are required");
  const seen = new Set<string>();
  const normalized = dispositions.map((value) => {
    const disposition = asRecord(value, "disposition evidence");
    const kind = String(disposition["disposition"]) as typeof CAPSTONE_DISPOSITIONS[number];
    if (!CAPSTONE_DISPOSITIONS.includes(kind)) fail(`unsupported disposition: ${kind}`);
    if (seen.has(kind)) fail(`duplicate disposition: ${kind}`);
    seen.add(kind);
    if (disposition["sourceRevision"] !== sourceRevision) fail(`mixed source revision in ${kind} proof`);
    return {
      disposition: kind,
      sourceRevision,
      proof: normalizeDispositionProof(kind, disposition["proof"], responseHash),
    };
  });
  return normalized.sort((left, right) =>
    CAPSTONE_DISPOSITIONS.indexOf(left.disposition) - CAPSTONE_DISPOSITIONS.indexOf(right.disposition)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeSemanticShadowCapstoneEvidence(
  input:
    | SemanticShadowCapstoneEvidence
    | NormalizedSemanticShadowCapstoneEvidencePayload
    | NormalizedSemanticShadowCapstoneEvidence,
): NormalizedSemanticShadowCapstoneEvidence {
  const wrapped = "evidence" in input;
  const evidence = wrapped ? input.evidence : input;
  if (evidence.schemaVersion !== 1) fail("schemaVersion must be 1");
  const sourceRevision = requireSha256(evidence.sourceRevision, "sourceRevision");
  const responseHash = requireSha256(evidence.responseHash, "responseHash");
  const normalizedEvidence: NormalizedSemanticShadowCapstoneEvidencePayload = {
    schemaVersion: 1,
    sourceRevision,
    responseHash,
    observations: validateObservations(evidence.observations, sourceRevision, responseHash),
    dispositions: validateDispositions(evidence.dispositions, sourceRevision, responseHash),
  };
  const evidenceHash = `sha256:${createHash("sha256").update(canonicalJson(normalizedEvidence)).digest("hex")}`;
  if (wrapped && input.evidenceHash !== evidenceHash) fail("evidence hash mismatch");
  return { evidence: normalizedEvidence, evidenceHash };
}
