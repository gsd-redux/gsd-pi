// Project/App: gsd-pi
// File Purpose: Executable contract for the deterministic M003/S07 cutover dossier.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DEFAULT_OUTPUT,
  buildDossier,
  hashCanonical,
  parseArgs,
  renderDossier,
  runDossierCli,
  validateDossier,
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
const COMPATIBILITY_DETAILS = Object.freeze({
  "runtime-disagreement": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-no-cutover.test.ts",
    title: "legacy milestone status remains public when canonical lifecycle disagrees",
  },
  "frozen-public-response": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-contract.test.ts",
    title: "keeps milestone status byte/deep-equal across native Pi and the shared workflow executor",
  },
  "mode-transport-matrix": {
    file: "src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts",
    title: "all supported modes and transports preserve the frozen response and exact observation identity",
  },
  "unadopted-import": {
    file: "src/resources/extensions/gsd/tests/md-importer-adopted-authority.test.ts",
    title: "unadopted re-import keeps existing checkbox completion behavior",
  },
  "unadopted-reconcile": {
    file: "src/resources/extensions/gsd/tests/workflow-reconcile.test.ts",
    title: "unadopted legacy Milestone completion remains an explicit reconciliation compatibility path",
  },
  "same-status-repair": {
    file: "src/resources/extensions/gsd/tests/adopted-lifecycle-bypass-closure.test.ts",
    title: "same-status completion timestamp repair remains available when adopted state is aligned",
  },
  "park-unpark": {
    file: "src/resources/extensions/gsd/tests/park-db-sync.test.ts",
    title: "unparkMilestone updates DB status to 'active' (#2694)",
  },
  discard: {
    file: "src/resources/extensions/gsd/tests/park-milestone.test.ts",
    title: "discardMilestone removes DB rows, worktree, and milestone branch",
  },
  "skipped-dispatch": {
    file: "src/resources/extensions/gsd/tests/dispatch-guard-closed-status.test.ts",
    title: "skipped prior DB slices do not block later slice dispatch",
  },
  "db-unavailable-status": {
    file: "src/resources/extensions/gsd/tests/milestone-status-tool.test.ts",
    title: "gsd_milestone_status handles missing DB gracefully",
  },
});
const COMMANDS = Object.freeze([
  {
    id: "semantic-shadow-capstone",
    command: "pnpm exec tsx --test src/resources/extensions/gsd/tests/semantic-shadow-capstone.test.ts src/resources/extensions/gsd/tests/semantic-shadow-mode-matrix.test.ts src/resources/extensions/gsd/tests/semantic-shadow-soak.test.ts packages/mcp-server/src/workflow-tools-parity.test.ts",
  },
  { id: "dossier-check", command: "node scripts/m003-s07-cutover-dossier.mjs --check" },
  { id: "authority-baseline", command: "pnpm run baseline:workflow-authority" },
  { id: "verify-merge", command: "pnpm run verify:merge" },
]);
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
      milestoneId: "M001",
      sliceId: "S07",
      taskId: `T${String(index + 1).padStart(2, "0")}`,
      lifecycleId: classification === "missing_shadow" ? null : `lifecycle-${index + 1}`,
    },
  };
  switch (classification) {
    case "match":
      return {
        ...common,
        rawLegacyStatus: "pending",
        rawCanonicalStatus: "pending",
        normalizedLegacyStatus: "pending",
        normalizedCanonicalStatus: "pending",
      };
    case "semantic_match_exact_delta":
      return {
        ...common,
        rawLegacyStatus: "queued",
        rawCanonicalStatus: "ready",
        normalizedLegacyStatus: "pending",
        normalizedCanonicalStatus: "ready",
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
        rawLegacyStatus: "active",
        rawCanonicalStatus: "completed",
        normalizedLegacyStatus: "in_progress",
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
    observationEvidencePlane: "capstone_fixture",
    canonicalHistoryEvidencePlane: "live_project",
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
        lifecycleId: "lifecycle-m003",
        itemKind: "milestone",
        milestoneId: "M003",
        sliceId: null,
        taskId: null,
        legacyStatus: "active",
        canonicalStatus: "ready",
        classification: "semantic_match_exact_delta",
      },
      {
        lifecycleId: "lifecycle-t07",
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
    compatibilityInventory: COMPATIBILITY_IDS.map((id) => ({
      id,
      ...COMPATIBILITY_DETAILS[id],
      verdict: "pass",
    })),
    commands: COMMANDS.map((command) => ({ ...command, exitCode: 0, verdict: "pass" })),
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
  input.commands.reverse();
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
  assert.equal(first.observationEvidencePlane, "capstone_fixture");
  assert.equal(first.canonicalHistoryEvidencePlane, "live_project");
  assert.equal(first.observationCoverage[0].itemIdentity.milestoneId, "M001");
  assert.deepEqual(first.observationCoverage.slice(0, 5).map((row) => row.classification), CLASSIFICATIONS);
  assert.equal(first.observationCoverage[0].itemIdentity.lifecyclePresent, true);
  assert.equal("lifecycleId" in first.observationCoverage[0].itemIdentity, false);
  assert.deepEqual(first.commands, COMMANDS.map((command) => ({ ...command, exitCode: 0, verdict: "pass" })));
  assert.deepEqual(first.compatibilityInventory[0], {
    id: "runtime-disagreement",
    ...COMPATIBILITY_DETAILS["runtime-disagreement"],
    verdict: "pass",
  });
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
  ["missing lifecycle identity", (input) => { delete input.observations[0].items[0].itemIdentity.lifecycleId; }, /lifecycle.*identity/i],
  ["live milestone relabeled as fixture", (input) => { input.liveDrift[0].milestoneId = "M001"; }, /live drift milestone.*M003/i],
  ["fixture milestone relabeled as live", (input) => { input.observations[0].items[0].itemIdentity.milestoneId = "M003"; }, /fixture observation milestone.*M001/i],
  ["missing fixture evidence plane", (input) => { delete input.observationEvidencePlane; }, /observation evidence plane.*capstone_fixture/i],
  ["wrong history evidence plane", (input) => { input.canonicalHistoryEvidencePlane = "capstone_fixture"; }, /canonical history evidence plane.*live_project/i],
  ["incomplete tuple identity", (input) => { input.observations[0].items[0].itemIdentity.taskId = null; }, /task identity/i],
  ["forged normalized status", (input) => { input.observations[0].items[1].normalizedLegacyStatus = "ready"; }, /frozen semantic relation/i],
  ["unavailable source", (input) => { input.observations[0].sourceRevision = "unavailable"; }, /source revision/i],
  ["mixed exact source", (input) => { input.observations[0].sourceRevision = sha("other-source"); }, /source revision/i],
  ["clean matrix loss", (input) => { input.observations[0].observationLossAccounting.lossCount = 1; }, /clean observation.*loss/i],
  ["unaccounted isolated loss", (input) => { input.observationLosses[0].accounted = false; }, /unaccounted observation loss/i],
  ["competing loss terminal", (input) => { input.observationLosses[0].terminalRecords = 2; }, /terminal record/i],
  ["corrupt repair digest", (input) => { input.repairHistory[0].evidenceDigest = "sha256:bad"; }, /repair.*digest/i],
  ["missing repair receipt", (input) => input.repairHistory.pop(), /33 repair/i],
  ["missing repair outbox", (input) => { input.repairHistory[0].outboxCount = 0; }, /repair.*1\/1\/1/i],
  ["historical disposition drift", (input) => { input.repairHistory[0].disposition = "repaired"; }, /repair.*disposition/i],
  ["missing live lifecycle identity", (input) => { delete input.liveDrift[0].lifecycleId; }, /live drift.*lifecycle identity/i],
  ["live missing shadow", (input) => { input.liveDrift[0].classification = "missing_shadow"; }, /live drift/i],
  ["forged allowed live classification", (input) => { input.liveDrift[0].classification = "match"; }, /frozen semantic relation/i],
  ["unknown live status", (input) => { input.liveDrift[0].legacyStatus = "mystery"; }, /live drift/i],
  ["nonpassing receipt head", (input) => { input.taskReceiptHeads[0].verdict = "fail"; }, /receipt head/i],
  ["missing compatibility witness", (input) => input.compatibilityInventory.pop(), /compatibility inventory/i],
  ["missing compatibility file", (input) => { delete input.compatibilityInventory[0].file; }, /compatibility.*file/i],
  ["changed compatibility title", (input) => { input.compatibilityInventory[0].title = "renamed"; }, /compatibility.*title/i],
  ["missing command", (input) => input.commands.pop(), /command inventory/i],
  ["changed command", (input) => { input.commands[0].command = "pnpm test"; }, /command inventory/i],
  ["failed command", (input) => { input.commands[0].exitCode = 1; }, /command.*pass/i],
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

test("validateDossier reconstructs normalized evidence and rejects changed hashes", () => {
  const dossier = buildDossier(validInput());
  assert.deepEqual(validateDossier(dossier), dossier);

  const corrupt = structuredClone(dossier);
  corrupt.hashes.capstoneEvidenceHash = sha("corrupt");
  assert.throws(() => validateDossier(corrupt), /hash|normalized dossier/i);
});

test("parseArgs exposes check and explicit local generation modes", () => {
  assert.deepEqual(parseArgs(["--input", "evidence.json", "--json"]), {
    mode: "generate",
    inputPath: "evidence.json",
    outputPath: DEFAULT_OUTPUT,
    json: true,
  });
  assert.deepEqual(parseArgs(["--check"]), {
    mode: "check",
    inputPath: null,
    outputPath: DEFAULT_OUTPUT,
    json: false,
  });
  assert.deepEqual(parseArgs(["--input", "evidence.json", "--output", "result.json"]), {
    mode: "generate",
    inputPath: "evidence.json",
    outputPath: "result.json",
    json: false,
  });
  assert.throws(() => parseArgs(["--check", "--input", "evidence.json"]), /check.*input/i);
  assert.throws(() => parseArgs(["--check", "--output", "result.json"]), /output.*generate/i);
  assert.throws(() => parseArgs(["--input", "https://example.test/evidence.json"]), /local path/i);
  assert.throws(() => parseArgs(["--github-label", "ready"]), /unknown argument/i);
});

test("bare --check validates and byte-compares the default checked dossier", () => {
  const dossier = buildDossier(validInput());
  const rendered = renderDossier(dossier);
  const output = [];
  const io = {
    readText(path) {
      assert.equal(path, DEFAULT_OUTPUT);
      return rendered;
    },
    writeText() {
      assert.fail("--check must not write");
    },
    writeStdout(text) {
      output.push(text);
    },
  };

  runDossierCli(["--check"], io);
  assert.match(output.join(""), /valid/i);

  assert.throws(() => runDossierCli(["--check"], {
    ...io,
    readText: () => `${rendered}\n`,
  }), /byte|canonical|stale/i);
});

test("explicit --output writes a validated generated dossier", () => {
  const directory = mkdtempSync(join(tmpdir(), "m003-s07-dossier-output-"));
  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "dossier.json");
  writeFileSync(inputPath, `${JSON.stringify(validInput())}\n`);

  const result = spawnSync(process.execPath, [
    "scripts/m003-s07-cutover-dossier.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(outputPath, "utf8")).hashes.dossierHash,
    buildDossier(validInput()).hashes.dossierHash,
  );
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
