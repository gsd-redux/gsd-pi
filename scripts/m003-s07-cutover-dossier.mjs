#!/usr/bin/env node

// Project/App: gsd-pi
// File Purpose: Deterministic validation and normalization core for the M003/S07 cutover dossier.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODES = Object.freeze(["auto", "interactive", "guided", "uok", "custom", "legacy"]);
export const TRANSPORTS = Object.freeze(["native_pi", "workflow_mcp"]);
export const CLASSIFICATIONS = Object.freeze([
  "match",
  "semantic_match_exact_delta",
  "missing_shadow",
  "extra_shadow",
  "status_mismatch",
]);
export const PROOF_OUTCOMES = Object.freeze([
  "advanced",
  "repaired",
  "unresolved",
  "rejected",
  "observation_loss",
]);
export const COMPATIBILITY_IDS = Object.freeze([
  "runtime-disagreement",
  "frozen-public-response",
  "mode-transport-matrix",
  "unadopted-import",
  "unadopted-reconcile",
  "same-status-repair",
  "park-unpark",
  "discard",
  "skipped-dispatch",
  "db-unavailable-status",
]);
export const DEFERRED_BLOCKERS = Object.freeze([
  "production-read-authority",
  "canonical-dependency-eligibility",
  "integrated-slice-source-uat-identity",
  "closeout-effects",
  "merge-publication-settlement",
  "park-unpark-discard-adoption",
  "projection-work-redesign",
  "legacy-cascade-deletion",
  "compatibility-retirement",
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LOSS_REASONS = new Set([
  "context_resolution_failed",
  "shadow_query_failed",
  "primary_sink_failed",
  "projection_sink_failed",
]);
const TOP_LEVEL_KEYS = new Set([
  "recommendation",
  "evidenceSourceRevision",
  "authority",
  "observations",
  "dispositionProof",
  "observationLosses",
  "repairHistory",
  "liveDrift",
  "taskReceiptHeads",
  "compatibilityInventory",
  "noCutover",
  "authorityBaseline",
  "deferredCutoverBlockers",
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a nonblank string`);
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  return requireString(value, label);
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase sha256 digest`);
  return value;
}

function orderBy(inventory, value, label) {
  const index = inventory.indexOf(value);
  if (index === -1) fail(`Unknown ${label}: ${String(value)}`);
  return index;
}

function forbiddenInputToken(key) {
  const tokens = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
  return tokens.find((token) => [
    "github",
    "label",
    "labels",
    "tag",
    "tags",
    "network",
    "octokit",
    "hosted",
    "url",
    "urls",
  ].includes(token));
}

function rejectForbiddenInputs(value, path = "input") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenInputs(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const token = forbiddenInputToken(key);
      if (token) fail(`Forbidden ${token} input at ${path}.${key}`);
      rejectForbiddenInputs(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && /(?:https?:\/\/|git@github|github\.com)/i.test(value)) {
    fail(`Forbidden network input value at ${path}`);
  }
}

function rejectUnknownTopLevelKeys(input) {
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`Unknown dossier input field: ${key}`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function validateItemRelation(item) {
  const legacy = item.rawLegacyStatus;
  const canonical = item.rawCanonicalStatus;
  const normalizedLegacy = item.normalizedLegacyStatus;
  const normalizedCanonical = item.normalizedCanonicalStatus;
  let valid = false;
  switch (item.classification) {
    case "match":
      valid = legacy !== null && legacy === canonical && normalizedLegacy === normalizedCanonical;
      break;
    case "semantic_match_exact_delta":
      valid = legacy !== null && canonical !== null && legacy !== canonical
        && normalizedLegacy !== null && normalizedLegacy === normalizedCanonical;
      break;
    case "missing_shadow":
      valid = legacy !== null && canonical === null
        && normalizedLegacy !== null && normalizedCanonical === null;
      break;
    case "extra_shadow":
      valid = legacy === null && canonical !== null
        && normalizedLegacy === null && normalizedCanonical !== null;
      break;
    case "status_mismatch":
      valid = legacy !== null && canonical !== null
        && normalizedLegacy !== null && normalizedCanonical !== null
        && normalizedLegacy !== normalizedCanonical;
      break;
  }
  if (!valid) fail(`Classification tuple ${item.classification} has inconsistent raw or normalized statuses`);
}

function validateItemIdentity(identity) {
  if (identity.itemKind === "milestone" && (identity.sliceId !== null || identity.taskId !== null)) {
    fail("Milestone identity must not contain Slice or Task IDs");
  }
  if (identity.itemKind === "slice" && (identity.sliceId === null || identity.taskId !== null)) {
    fail("Slice identity requires a Slice ID and no Task ID");
  }
  if (identity.itemKind === "task" && (identity.sliceId === null || identity.taskId === null)) {
    fail("Task identity requires both Slice and Task IDs");
  }
}

function normalizeItem(rawItem) {
  const item = requireRecord(rawItem, "Observation item");
  const classification = requireString(item.classification, "Observation classification");
  orderBy(CLASSIFICATIONS, classification, "classification");
  const identity = requireRecord(item.itemIdentity, "Observation item identity");
  const normalized = {
    classification,
    itemIdentity: {
      itemKind: requireString(identity.itemKind, "Observation item kind"),
      milestoneId: requireString(identity.milestoneId, "Observation milestone ID"),
      sliceId: requireNullableString(identity.sliceId, "Observation slice ID"),
      taskId: requireNullableString(identity.taskId, "Observation task ID"),
    },
    rawLegacyStatus: requireNullableString(item.rawLegacyStatus, "Raw legacy status"),
    rawCanonicalStatus: requireNullableString(item.rawCanonicalStatus, "Raw canonical status"),
    normalizedLegacyStatus: requireNullableString(item.normalizedLegacyStatus, "Normalized legacy status"),
    normalizedCanonicalStatus: requireNullableString(item.normalizedCanonicalStatus, "Normalized canonical status"),
  };
  if (!["milestone", "slice", "task"].includes(normalized.itemIdentity.itemKind)) {
    fail(`Unknown observation item kind: ${normalized.itemIdentity.itemKind}`);
  }
  if (normalized.itemIdentity.milestoneId !== "M003") fail("Observation milestone ID must be M003");
  validateItemIdentity(normalized.itemIdentity);
  validateItemRelation(normalized);
  return normalized;
}

function normalizeObservations(rawObservations, sourceRevision) {
  const observations = requireArray(rawObservations, "Observations");
  const cells = new Map();
  for (const rawObservation of observations) {
    const observation = requireRecord(rawObservation, "Observation envelope");
    const mode = requireString(observation.mode, "Observation mode");
    const transport = requireString(observation.transport, "Observation transport");
    orderBy(MODES, mode, "mode");
    orderBy(TRANSPORTS, transport, "transport");
    const cell = `${mode}/${transport}`;
    if (cells.has(cell)) fail(`Duplicate observation cell: ${cell}`);

    const observedSource = requireSha(observation.sourceRevision, "Observation source revision");
    if (observedSource !== sourceRevision) fail(`Observation source revision does not match dossier source: ${cell}`);
    if (observation.repairDisposition !== "not_attempted") {
      fail(`Clean observation repair disposition must be not_attempted: ${cell}`);
    }
    const loss = requireRecord(observation.observationLossAccounting, "Observation loss accounting");
    if (loss.lossCount !== 0 || loss.persistedCount !== 1) {
      fail(`Clean observation coverage must have zero loss and one persisted record: ${cell}`);
    }

    const items = requireArray(observation.items, "Observation items").map(normalizeItem);
    const byClassification = new Map();
    const identities = new Set();
    for (const item of items) {
      if (byClassification.has(item.classification)) {
        fail(`Duplicate classification tuple for ${cell}/${item.classification}`);
      }
      const identityKey = JSON.stringify(item.itemIdentity);
      if (identities.has(identityKey)) fail(`Duplicate observation identity in ${cell}`);
      identities.add(identityKey);
      byClassification.set(item.classification, item);
    }
    for (const classification of CLASSIFICATIONS) {
      if (!byClassification.has(classification)) {
        fail(`Missing classification tuple for ${cell}/${classification}`);
      }
    }
    if (items.length !== CLASSIFICATIONS.length) fail(`Observation cell ${cell} must have five classification tuples`);

    cells.set(cell, {
      mode,
      transport,
      sourceRevision: observedSource,
      projectRevision: requireInteger(observation.projectRevision, "Observation project revision"),
      authorityEpoch: requireInteger(observation.authorityEpoch, "Observation authority epoch"),
      traceId: requireString(observation.traceId, "Observation trace ID"),
      turnId: requireString(observation.turnId, "Observation turn ID"),
      repairDisposition: "not_attempted",
      observationLossAccounting: { lossCount: 0, persistedCount: 1 },
      items: [...items].sort((left, right) => (
        orderBy(CLASSIFICATIONS, left.classification, "classification")
        - orderBy(CLASSIFICATIONS, right.classification, "classification")
      )),
    });
  }

  for (const mode of MODES) {
    for (const transport of TRANSPORTS) {
      const cell = `${mode}/${transport}`;
      if (!cells.has(cell)) fail(`Missing observation cell: ${cell}`);
    }
  }
  if (cells.size !== MODES.length * TRANSPORTS.length) fail("Observation coverage must contain exactly 12 cells");

  const ordered = [...cells.values()].sort((left, right) => (
    orderBy(MODES, left.mode, "mode") - orderBy(MODES, right.mode, "mode")
    || orderBy(TRANSPORTS, left.transport, "transport")
      - orderBy(TRANSPORTS, right.transport, "transport")
  ));
  return ordered.flatMap((observation) => observation.items.map((item) => ({
    mode: observation.mode,
    transport: observation.transport,
    sourceRevision: observation.sourceRevision,
    projectRevision: observation.projectRevision,
    authorityEpoch: observation.authorityEpoch,
    traceId: observation.traceId,
    turnId: observation.turnId,
    repairDisposition: observation.repairDisposition,
    observationLossAccounting: observation.observationLossAccounting,
    ...item,
  })));
}

function normalizeLosses(rawLosses) {
  const losses = requireArray(rawLosses, "Observation losses");
  const ids = new Set();
  const normalized = losses.map((rawLoss) => {
    const loss = requireRecord(rawLoss, "Observation loss");
    const id = requireString(loss.id, "Observation loss ID");
    if (ids.has(id)) fail(`Duplicate observation loss: ${id}`);
    ids.add(id);
    const lossCount = requireInteger(loss.lossCount, "Observation loss count");
    const persistedCount = requireInteger(loss.persistedCount, "Observation persisted count");
    if (!loss.accounted || lossCount === 0) fail(`Unaccounted observation loss: ${id}`);
    if (loss.terminalRecords !== 1) fail(`Observation loss must have exactly one terminal record: ${id}`);
    if (![0, 1].includes(persistedCount)) fail(`Observation persisted count must be zero or one: ${id}`);
    const causes = requireArray(loss.causes, "Observation loss causes").map((rawCause) => {
      const cause = requireRecord(rawCause, "Observation loss cause");
      const reason = requireString(cause.reason, "Observation loss reason");
      if (!LOSS_REASONS.has(reason)) fail(`Unknown observation loss reason: ${reason}`);
      return { reason, errorHash: requireSha(cause.errorHash, "Observation loss error hash") };
    }).sort((left, right) => left.reason.localeCompare(right.reason) || left.errorHash.localeCompare(right.errorHash));
    if (causes.length !== lossCount) fail(`Observation loss cause count does not match lossCount: ${id}`);
    return { id, lossCount, persistedCount, terminalRecords: 1, accounted: true, causes };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeDispositionProof(rawProof, losses) {
  const proof = requireArray(rawProof, "Disposition proof");
  const byOutcome = new Map();
  for (const rawEntry of proof) {
    const entry = requireRecord(rawEntry, "Disposition proof entry");
    const outcome = requireString(entry.outcome, "Disposition proof outcome");
    orderBy(PROOF_OUTCOMES, outcome, "proof outcome");
    if (byOutcome.has(outcome)) fail(`Duplicate disposition proof: ${outcome}`);
    if (outcome === "rejected" && entry.residueFree !== true) {
      fail("Rejected disposition proof must be residue-free");
    }
    if (outcome === "observation_loss") {
      if (entry.accounted !== true) fail("Observation-loss disposition proof must be accounted");
      const lossRef = requireString(entry.lossRef, "Observation-loss reference");
      if (!losses.some((loss) => loss.id === lossRef)) fail(`Observation-loss proof has unknown loss reference: ${lossRef}`);
    }
    byOutcome.set(outcome, {
      outcome,
      evidenceHash: requireSha(entry.evidenceHash, "Disposition proof evidence hash"),
      residueFree: entry.residueFree === true,
      accounted: entry.accounted === true,
      ...(outcome === "observation_loss" ? { lossRef: entry.lossRef } : {}),
    });
  }
  for (const outcome of PROOF_OUTCOMES) {
    if (!byOutcome.has(outcome)) fail(`Missing disposition proof: ${outcome}`);
  }
  if (byOutcome.size !== PROOF_OUTCOMES.length) fail("Disposition proof must contain exactly five outcomes");
  return PROOF_OUTCOMES.map((outcome) => byOutcome.get(outcome));
}

function normalizeRepairHistory(rawHistory) {
  const history = requireArray(rawHistory, "Repair history");
  if (history.length !== 33) fail("Canonical history must contain exactly 33 repair receipts");
  const rows = history.map((rawRow) => {
    const row = requireRecord(rawRow, "Repair receipt");
    const normalized = {
      resultingRevision: requireInteger(row.resultingRevision, "Repair revision"),
      eventIndex: requireInteger(row.eventIndex, "Repair event index"),
      eventId: requireString(row.eventId, "Repair event ID"),
      eventType: requireString(row.eventType, "Repair event type"),
      disposition: requireString(row.disposition, "Repair disposition"),
      comparisonKind: requireString(row.comparisonKind, "Repair comparison kind"),
      evidenceDigest: requireSha(row.evidenceDigest, "Repair evidence digest"),
      eventCount: requireInteger(row.eventCount, "Repair event count"),
      outboxCount: requireInteger(row.outboxCount, "Repair outbox count"),
      projectionCount: requireInteger(row.projectionCount, "Repair projection count"),
    };
    if (normalized.eventCount !== 1 || normalized.outboxCount !== 1 || normalized.projectionCount !== 1) {
      fail(`Repair receipt must have event/outbox/projection counts 1/1/1: ${normalized.eventId}`);
    }
    const expectedEvent = normalized.disposition === "advanced"
      ? "lifecycle.shadow.advanced"
      : "lifecycle.shadow.repaired";
    if (!["advanced", "repaired"].includes(normalized.disposition) || normalized.eventType !== expectedEvent) {
      fail(`Repair event/disposition mismatch: ${normalized.eventId}`);
    }
    if (normalized.disposition === "advanced" && normalized.comparisonKind !== "status_mismatch") {
      fail(`Advanced repair must originate from status_mismatch: ${normalized.eventId}`);
    }
    if (normalized.disposition === "repaired" && !["missing_shadow", "status_mismatch"].includes(normalized.comparisonKind)) {
      fail(`Repaired receipt has invalid comparison: ${normalized.eventId}`);
    }
    return normalized;
  }).sort((left, right) => (
    left.resultingRevision - right.resultingRevision
    || left.eventIndex - right.eventIndex
    || left.eventId.localeCompare(right.eventId)
  ));

  rows.forEach((row, index) => {
    if (row.resultingRevision !== 138 + index || row.eventIndex !== 0) {
      fail("Repair lineage must cover revisions 138-170 with event index zero");
    }
  });
  const counts = {
    total: rows.length,
    advanced: rows.filter((row) => row.disposition === "advanced").length,
    repaired: rows.filter((row) => row.disposition === "repaired").length,
    missingShadow: rows.filter((row) => row.comparisonKind === "missing_shadow").length,
    statusMismatch: rows.filter((row) => row.comparisonKind === "status_mismatch").length,
    distinctEvidenceDigests: new Set(rows.map((row) => row.evidenceDigest)).size,
  };
  if (counts.advanced !== 10 || counts.repaired !== 23
    || counts.missingShadow !== 11 || counts.statusMismatch !== 22
    || counts.distinctEvidenceDigests !== 23) {
    fail("Repair historical cardinality must be 10 advanced, 23 repaired, 11 missing, 22 mismatch, and 23 distinct evidence digests");
  }
  return { counts, rows };
}

function normalizeLiveDrift(rawRows) {
  const rows = requireArray(rawRows, "Live drift rows");
  if (rows.length === 0) fail("Live drift snapshot must not be empty");
  const kindOrder = ["milestone", "slice", "task"];
  return rows.map((rawRow) => {
    const row = requireRecord(rawRow, "Live drift row");
    const classification = requireString(row.classification, "Live drift classification");
    if (!["match", "semantic_match_exact_delta"].includes(classification)) {
      fail(`Live drift contains unexplained ${classification}`);
    }
    const itemKind = requireString(row.itemKind, "Live drift item kind");
    orderBy(kindOrder, itemKind, "live item kind");
    return {
      itemKind,
      milestoneId: requireString(row.milestoneId, "Live drift milestone ID"),
      sliceId: requireNullableString(row.sliceId, "Live drift slice ID"),
      taskId: requireNullableString(row.taskId, "Live drift task ID"),
      legacyStatus: requireNullableString(row.legacyStatus, "Live legacy status"),
      canonicalStatus: requireNullableString(row.canonicalStatus, "Live canonical status"),
      classification,
    };
  }).sort((left, right) => (
    orderBy(kindOrder, left.itemKind, "live item kind") - orderBy(kindOrder, right.itemKind, "live item kind")
    || left.milestoneId.localeCompare(right.milestoneId)
    || (left.sliceId ?? "").localeCompare(right.sliceId ?? "")
    || (left.taskId ?? "").localeCompare(right.taskId ?? "")
  ));
}

function normalizeTaskReceiptHeads(rawHeads) {
  const heads = requireArray(rawHeads, "Task receipt heads");
  const expected = Array.from({ length: 6 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
  const byTask = new Map();
  for (const rawHead of heads) {
    const head = requireRecord(rawHead, "Task receipt head");
    const taskId = requireString(head.taskId, "Receipt head task ID");
    if (byTask.has(taskId)) fail(`Duplicate receipt head: ${taskId}`);
    if (head.attemptState !== "settled" || head.resultOutcome !== "succeeded"
      || head.verdict !== "pass" || head.current !== true) {
      fail(`Receipt head must be current, settled, succeeded, and passing: ${taskId}`);
    }
    byTask.set(taskId, {
      taskId,
      attemptNumber: requireInteger(head.attemptNumber, "Receipt attempt number"),
      attemptState: "settled",
      resultOutcome: "succeeded",
      verdict: "pass",
      current: true,
      testedSourceRevision: requireSha(head.testedSourceRevision, "Receipt tested source revision"),
      evidenceHash: requireSha(head.evidenceHash, "Receipt evidence hash"),
    });
  }
  for (const taskId of expected) {
    if (!byTask.has(taskId)) fail(`Missing current receipt head: ${taskId}`);
  }
  if (byTask.size !== expected.length) fail("Receipt heads must contain exactly T01-T06");
  return expected.map((taskId) => byTask.get(taskId));
}

function normalizeCompatibility(rawInventory) {
  const inventory = requireArray(rawInventory, "Compatibility inventory");
  const byId = new Map();
  for (const rawEntry of inventory) {
    const entry = requireRecord(rawEntry, "Compatibility entry");
    const id = requireString(entry.id, "Compatibility ID");
    if (byId.has(id)) fail(`Duplicate compatibility inventory entry: ${id}`);
    if (entry.verdict !== "pass") fail(`Compatibility inventory entry must pass: ${id}`);
    byId.set(id, { id, verdict: "pass" });
  }
  for (const id of COMPATIBILITY_IDS) {
    if (!byId.has(id)) fail(`Compatibility inventory is missing ${id}`);
  }
  if (byId.size !== COMPATIBILITY_IDS.length) fail("Compatibility inventory contains an unknown entry");
  return COMPATIBILITY_IDS.map((id) => byId.get(id));
}

function requireExactGate(rawGate, expected, label) {
  const gate = requireRecord(rawGate, label);
  if (gate.passed !== expected || gate.total !== expected) fail(`${label} must be ${expected}/${expected}`);
  return { passed: expected, total: expected };
}

function normalizeNoCutover(rawNoCutover) {
  const noCutover = requireRecord(rawNoCutover, "No-cutover gate");
  return {
    structural: requireExactGate(noCutover.structural, 5, "No-cutover structural gate"),
    behavioral: requireExactGate(noCutover.behavioral, 10, "No-cutover behavioral gate"),
  };
}

function normalizeBlockers(rawBlockers) {
  const blockers = requireArray(rawBlockers, "Deferred cutover blockers");
  const actual = new Set(blockers.map((blocker) => requireString(blocker, "Deferred cutover blocker")));
  for (const blocker of DEFERRED_BLOCKERS) {
    if (!actual.has(blocker)) fail(`Missing deferred cutover blocker: ${blocker}`);
  }
  if (actual.size !== DEFERRED_BLOCKERS.length || actual.size !== blockers.length) {
    fail("Deferred cutover blocker inventory must match the frozen NO_GO contract");
  }
  return [...DEFERRED_BLOCKERS];
}

function observedCounts(rows) {
  return {
    envelopes: new Set(rows.map((row) => `${row.mode}/${row.transport}`)).size,
    items: rows.length,
    byMode: Object.fromEntries(MODES.map((mode) => [mode, rows.filter((row) => row.mode === mode).length])),
    byTransport: Object.fromEntries(TRANSPORTS.map((transport) => [
      transport,
      rows.filter((row) => row.transport === transport).length,
    ])),
    byClassification: Object.fromEntries(CLASSIFICATIONS.map((classification) => [
      classification,
      rows.filter((row) => row.classification === classification).length,
    ])),
  };
}

export function buildDossier(rawInput) {
  const input = requireRecord(rawInput, "Dossier input");
  rejectForbiddenInputs(input);
  rejectUnknownTopLevelKeys(input);
  if (input.recommendation !== "NO_GO") fail("Dossier recommendation must remain NO_GO");
  const evidenceSourceRevision = requireSha(input.evidenceSourceRevision, "Evidence source revision");
  const authority = requireRecord(input.authority, "Authority snapshot");
  const normalizedAuthority = {
    projectRevision: requireInteger(authority.projectRevision, "Authority project revision"),
    authorityEpoch: requireInteger(authority.authorityEpoch, "Authority epoch"),
  };
  const observationCoverage = normalizeObservations(input.observations, evidenceSourceRevision);
  const observationLosses = normalizeLosses(input.observationLosses);
  const dispositionProof = normalizeDispositionProof(input.dispositionProof, observationLosses);
  const repairHistory = normalizeRepairHistory(input.repairHistory);
  const liveDrift = normalizeLiveDrift(input.liveDrift);
  const taskReceiptHeads = normalizeTaskReceiptHeads(input.taskReceiptHeads);
  const compatibilityInventory = normalizeCompatibility(input.compatibilityInventory);
  const noCutover = normalizeNoCutover(input.noCutover);
  const authorityBaseline = requireExactGate(input.authorityBaseline, 4, "Authority baseline");
  const deferredCutoverBlockers = normalizeBlockers(input.deferredCutoverBlockers);
  const expectedCoverage = { envelopes: 12, items: 60, tuples: 60 };
  const counts = observedCounts(observationCoverage);

  const capstoneEvidence = {
    evidenceSourceRevision,
    expectedCoverage,
    observedCounts: counts,
    observationCoverage,
    dispositionProof,
    observationLosses,
    noCutover,
    authorityBaseline,
  };
  const canonicalHistory = {
    authority: normalizedAuthority,
    repairHistory,
    liveDrift,
    taskReceiptHeads,
  };
  const report = {
    schemaVersion: 1,
    milestoneId: "M003",
    sliceId: "S07",
    recommendation: "NO_GO",
    evidenceSourceRevision,
    authority: normalizedAuthority,
    expectedCoverage,
    observedCounts: counts,
    observationCoverage,
    dispositionProof,
    observationLosses,
    repairHistory,
    liveDrift,
    taskReceiptHeads,
    compatibilityInventory,
    noCutover,
    authorityBaseline,
    deferredCutoverBlockers,
    hashes: {
      capstoneEvidenceHash: hashCanonical(capstoneEvidence),
      canonicalHistoryHash: hashCanonical(canonicalHistory),
    },
  };
  return {
    ...report,
    hashes: { ...report.hashes, dossierHash: hashCanonical(report) },
  };
}

export function renderDossier(dossier) {
  return `${JSON.stringify(canonicalValue(dossier), null, 2)}\n`;
}

export function parseArgs(argv = process.argv.slice(2)) {
  let inputPath = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--input requires a local path");
      if (/:\/\//.test(value) || /^git@/i.test(value)) fail("--input must be a local path");
      inputPath = value;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!inputPath) fail("--input requires a local path");
  return { inputPath, json };
}

function runCli() {
  const args = parseArgs();
  const input = JSON.parse(readFileSync(resolve(args.inputPath), "utf8"));
  const dossier = buildDossier(input);
  if (args.json) process.stdout.write(renderDossier(dossier));
  else process.stdout.write(`M003/S07 dossier valid: ${dossier.hashes.dossierHash}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
