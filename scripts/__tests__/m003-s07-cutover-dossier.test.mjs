// Project/App: gsd-pi
// File Purpose: Executable contract for the deterministic M003/S07 cutover dossier.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildDossier,
  hashCanonical,
  parseArgs,
  renderDossier,
} from "../m003-s07-cutover-dossier.mjs";

const MODES = ["auto", "interactive", "guided", "uok", "custom", "legacy"];
const TRANSPORTS = ["native_pi", "workflow_mcp"];
const CLASSIFICATIONS = [
  "match",
  "semantic_match_exact_delta",
  "missing_shadow",
  "extra_shadow",
  "status_mismatch",
];
const PROOF_OUTCOMES = ["advanced", "repaired", "unresolved", "rejected", "observation_loss"];
const COMPATIBILITY_IDS = [
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
];
const DEFERRED_BLOCKERS = [
  "production-read-authority",
  "canonical-dependency-eligibility",
  "integrated-slice-source-uat-identity",
  "closeout-effects",
  "merge-publication-settlement",
  "park-unpark-discard-adoption",
  "projection-work-redesign",
  "legacy-cascade-deletion",
  "compatibility-retirement",
];

function sha(label) {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function item(classification, index) {
  const common = {
    classification,
    itemIdentity: {
      itemKind: "task",
      milestoneId: "M003",
      sliceId: "S07",
      taskId: `T${String(index + 1).padStart(2, "0")}`,
    },
  };
  switch (classification) {
    case "match":
      return {
        ...common,
        rawLegacyStatus: "completed",
        rawCanonicalStatus: "completed",
        normalizedLegacyStatus: "completed",
        normalizedCanonicalStatus: "completed",
      };
    case "semantic_match_exact_delta":
      return {
        ...common,
        rawLegacyStatus: "complete",
        rawCanonicalStatus: "completed",
        normalizedLegacyStatus: "completed",
        normalizedCanonicalStatus: "completed",
      };
    case "missing_shadow":
      return {
        ...common,
        rawLegacyStatus: "complete",
        rawCanonicalStatus: null,
        normalizedLegacyStatus: "completed",
        normalizedCanonicalStatus: null,
      };
    case "extra_shadow":
      return {
        ...common,
        rawLegacyStatus: null,
        rawCanonicalStatus: "ready",
        normalizedLegacyStatus: null,
        normalizedCanonicalStatus: "ready",
      };
    case "status_mismatch":
      return {
        ...common,
        rawLegacyStatus: "pending",
        rawCanonicalStatus: "completed",
        normalizedLegacyStatus: "ready",
        normalizedCanonicalStatus: "completed",
      };
    default:
      throw new Error(`Unsupported fixture classification: ${classification}`);
  }
}

function observation(mode, transport, sourceRevision) {
  return {
    mode,
    transport,
    sourceRevision,
    projectRevision: 7,
    authorityEpoch: 0,
    traceId: `trace-${mode}-${transport}`,
    turnId: `turn-${mode}-${transport}`,
    repairDisposition: "not_attempted",
    observationLossAccounting: { lossCount: 0, persistedCount: 1 },
    items: CLASSIFICATIONS.map(item),
  };
}

function repairHistory() {
  return Array.from({ length: 33 }, (_, index) => {
    const advanced = index < 10;
    const repairedMissing = index >= 10 && index < 21;
    return {
      resultingRevision: 138 + index,
      eventIndex: 0,
      eventId: `event-${String(index + 1).padStart(2, "0")}`,
      eventType: advanced ? "lifecycle.shadow.advanced" : "lifecycle.shadow.repaired",
      disposition: advanced ? "advanced" : "repaired",
      comparisonKind: repairedMissing ? "missing_shadow" : "status_mismatch",
      evidenceDigest: sha(`repair-evidence-${index % 23}`),
      eventCount: 1,
      outboxCount: 1,
      projectionCount: 1,
    };
  });
}

function validInput() {
  const sourceRevision = sha("candidate-source");
  return {
    recommendation: "NO_GO",
    evidenceSourceRevision: sourceRevision,
    authority: { projectRevision: 195, authorityEpoch: 0 },
    observations: MODES.flatMap((mode) => (
      TRANSPORTS.map((transport) => observation(mode, transport, sourceRevision))
    )),
    dispositionProof: PROOF_OUTCOMES.map((outcome) => ({
      outcome,
      evidenceHash: sha(`proof-${outcome}`),
      residueFree: outcome === "rejected",
      accounted: outcome === "observation_loss",
      ...(outcome === "observation_loss" ? { lossRef: "isolated-loss" } : {}),
    })),
    observationLosses: [{
      id: "isolated-loss",
      lossCount: 1,
      persistedCount: 1,
      terminalRecords: 1,
      accounted: true,
      causes: [{ reason: "primary_sink_failed", errorHash: sha("isolated-loss") }],
    }],
    repairHistory: repairHistory(),
    liveDrift: [
      {
        itemKind: "milestone",
        milestoneId: "M003",
        sliceId: null,
        taskId: null,
        legacyStatus: "active",
        canonicalStatus: "ready",
        classification: "semantic_match_exact_delta",
      },
      {
        itemKind: "task",
        milestoneId: "M003",
        sliceId: "S07",
        taskId: "T07",
        legacyStatus: "pending",
        canonicalStatus: "ready",
        classification: "semantic_match_exact_delta",
      },
    ],
    taskReceiptHeads: Array.from({ length: 6 }, (_, index) => ({
      taskId: `T${String(index + 1).padStart(2, "0")}`,
      attemptNumber: 1,
      attemptState: "settled",
      resultOutcome: "succeeded",
      verdict: "pass",
      current: true,
      testedSourceRevision: sha(`task-${index + 1}-source`),
      evidenceHash: sha(`task-${index + 1}-evidence`),
    })),
    compatibilityInventory: COMPATIBILITY_IDS.map((id) => ({ id, verdict: "pass" })),
    noCutover: {
      structural: { passed: 5, total: 5 },
      behavioral: { passed: 10, total: 10 },
    },
    authorityBaseline: { passed: 4, total: 4 },
    deferredCutoverBlockers: [...DEFERRED_BLOCKERS],
  };
}

function reversedInput() {
  const input = validInput();
  input.observations.reverse();
  for (const envelope of input.observations) envelope.items.reverse();
  input.dispositionProof.reverse();
  input.repairHistory.reverse();
  input.liveDrift.reverse();
  input.taskReceiptHeads.reverse();
  input.compatibilityInventory.reverse();
  input.deferredCutoverBlockers.reverse();
  return input;
}

test("buildDossier produces stable ordered JSON and self-verifying hashes", () => {
  const first = buildDossier(validInput());
  const second = buildDossier(reversedInput());

  assert.deepEqual(second, first);
  const rendered = renderDossier(first);
  assert.ok(rendered.indexOf('"authority"') < rendered.indexOf('"schemaVersion"'));
  assert.deepEqual(JSON.parse(rendered), first);
  assert.match(first.hashes.capstoneEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.hashes.canonicalHistoryHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.hashes.dossierHash, /^sha256:[0-9a-f]{64}$/);

  const withoutSelfHash = structuredClone(first);
  delete withoutSelfHash.hashes.dossierHash;
  assert.equal(first.hashes.dossierHash, hashCanonical(withoutSelfHash));
  assert.equal(first.observationCoverage.length, 60);
  assert.deepEqual(first.observationCoverage.slice(0, 5).map((row) => row.classification), CLASSIFICATIONS);
  assert.deepEqual(first.repairHistory.counts, {
    total: 33,
    advanced: 10,
    repaired: 23,
    missingShadow: 11,
    statusMismatch: 22,
    distinctEvidenceDigests: 23,
  });
});

const failureCases = [
  ["missing mode/transport cell", (input) => input.observations.pop(), /missing observation cell/i],
  ["duplicate mode/transport cell", (input) => input.observations.push(structuredClone(input.observations[0])), /duplicate observation cell/i],
  ["missing classification tuple", (input) => input.observations[0].items.pop(), /classification tuple/i],
  ["classification alias", (input) => { input.observations[0].items[0].classification = "exact_match"; }, /unknown classification/i],
  ["incomplete tuple identity", (input) => { input.observations[0].items[0].itemIdentity.taskId = null; }, /task identity/i],
  ["unavailable source", (input) => { input.observations[0].sourceRevision = "unavailable"; }, /source revision/i],
  ["mixed exact source", (input) => { input.observations[0].sourceRevision = sha("other-source"); }, /source revision/i],
  ["clean matrix loss", (input) => { input.observations[0].observationLossAccounting.lossCount = 1; }, /clean observation.*loss/i],
  ["unaccounted isolated loss", (input) => { input.observationLosses[0].accounted = false; }, /unaccounted observation loss/i],
  ["competing loss terminal", (input) => { input.observationLosses[0].terminalRecords = 2; }, /terminal record/i],
  ["corrupt repair digest", (input) => { input.repairHistory[0].evidenceDigest = "sha256:bad"; }, /repair.*digest/i],
  ["missing repair receipt", (input) => input.repairHistory.pop(), /33 repair/i],
  ["missing repair outbox", (input) => { input.repairHistory[0].outboxCount = 0; }, /repair.*1\/1\/1/i],
  ["historical disposition drift", (input) => { input.repairHistory[0].disposition = "repaired"; }, /repair.*disposition/i],
  ["live missing shadow", (input) => { input.liveDrift[0].classification = "missing_shadow"; }, /live drift/i],
  ["nonpassing receipt head", (input) => { input.taskReceiptHeads[0].verdict = "fail"; }, /receipt head/i],
  ["missing compatibility witness", (input) => input.compatibilityInventory.pop(), /compatibility inventory/i],
  ["no-cutover regression", (input) => { input.noCutover.behavioral.passed = 9; }, /no-cutover.*10\/10/i],
  ["authority baseline regression", (input) => { input.authorityBaseline.passed = 3; }, /baseline.*4\/4/i],
  ["GO recommendation", (input) => { input.recommendation = "GO"; }, /recommendation.*NO_GO/i],
  ["missing deferred blocker", (input) => input.deferredCutoverBlockers.pop(), /deferred cutover blocker/i],
  ["GitHub label input", (input) => { input.githubLabels = ["ready"]; }, /forbidden.*github/i],
  ["Git tag input", (input) => { input.releaseTags = ["v1.0.0"]; }, /forbidden.*tags/i],
  ["network input", (input) => { input.networkSource = "https://example.test/evidence"; }, /forbidden.*network/i],
];

for (const [name, mutate, expected] of failureCases) {
  test(`buildDossier rejects ${name}`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildDossier(input), expected);
  });
}

test("parseArgs exposes only local input and JSON output", () => {
  assert.deepEqual(parseArgs(["--input", "evidence.json", "--json"]), {
    inputPath: "evidence.json",
    json: true,
  });
  assert.throws(() => parseArgs(["--input", "https://example.test/evidence.json"]), /local path/i);
  assert.throws(() => parseArgs(["--github-label", "ready"]), /unknown argument/i);
});

test("CLI renders a validated local fixture without writing production JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "m003-s07-dossier-"));
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(validInput())}\n`);

  const result = spawnSync(process.execPath, [
    "scripts/m003-s07-cutover-dossier.mjs",
    "--input",
    inputPath,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), buildDossier(validInput()));
});
