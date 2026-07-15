// Project/App: gsd-pi
// File Purpose: Executable proof for reusable, deterministic semantic-shadow capstone evidence.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureMilestoneVerificationSourceRevision,
} from "../verification-source-integrity.ts";
import {
  CAPSTONE_CLASSIFICATIONS,
  CAPSTONE_DISPOSITIONS,
  CAPSTONE_MODES,
  CAPSTONE_TRANSPORTS,
  collectSemanticShadowCapstoneEvidence,
  M003_S07_DOSSIER_SOURCE_EXCLUSIONS,
  normalizeSemanticShadowCapstoneEvidence,
  type NormalizedSemanticShadowCapstoneEvidence,
  type SemanticShadowCapstoneEvidence,
} from "./semantic-shadow-capstone-harness.ts";

const loaderPath = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const emitterPath = fileURLToPath(new URL("./emit-semantic-shadow-capstone-evidence.ts", import.meta.url));

function corrupt<T>(value: T, mutate: (copy: T) => void): T {
  const copy = structuredClone(value);
  mutate(copy);
  return copy;
}

function disposition(evidence: SemanticShadowCapstoneEvidence, kind: string) {
  const entry = evidence.dispositions.find((candidate) => candidate.disposition === kind);
  assert.ok(entry, `missing ${kind} disposition`);
  return entry;
}

function withoutExactSourceRevision(value: NormalizedSemanticShadowCapstoneEvidence) {
  const evidence = structuredClone(value.evidence);
  const placeholder = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  evidence.sourceRevision = placeholder;
  for (const observation of evidence.observations) observation.sourceRevision = placeholder;
  for (const entry of evidence.dispositions) entry.sourceRevision = placeholder;
  return normalizeSemanticShadowCapstoneEvidence(evidence);
}

test("collector fails closed when source changes during collection", async () => {
  const revisions = [
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
  ];
  let captureCount = 0;
  const collectWithDependencies = collectSemanticShadowCapstoneEvidence as unknown as (
    input: { sourceRoot: string },
    dependencies: {
      captureSourceRevision: typeof captureMilestoneVerificationSourceRevision;
    },
  ) => Promise<SemanticShadowCapstoneEvidence>;

  await assert.rejects(
    collectWithDependencies(
      { sourceRoot: process.cwd() },
      {
        captureSourceRevision: () => ({
          ok: true,
          sourceRevision: revisions[captureCount++]!,
        }),
      },
    ),
    /semantic-shadow source changed during collection/i,
  );
  assert.equal(captureCount, 2);
});

test("collector binds full raw evidence to the actual source and normalizes deterministically", async () => {
  const sourceRoot = process.cwd();
  const expectedSource = captureMilestoneVerificationSourceRevision(
    sourceRoot,
    undefined,
    { excludePaths: M003_S07_DOSSIER_SOURCE_EXCLUSIONS },
  );
  assert.equal(expectedSource.ok, true);
  if (!expectedSource.ok) return;

  const raw = await collectSemanticShadowCapstoneEvidence({ sourceRoot });
  assert.equal(raw.sourceRevision, expectedSource.sourceRevision);
  assert.equal(raw.observations.length, CAPSTONE_MODES.length * CAPSTONE_TRANSPORTS.length);
  assert.deepEqual(
    raw.observations.flatMap((observation) => observation.items.map((item) => item.classification)).sort(),
    CAPSTONE_MODES.flatMap(() => CAPSTONE_TRANSPORTS.flatMap(() => CAPSTONE_CLASSIFICATIONS)).sort(),
  );
  for (const observation of raw.observations) {
    assert.equal(observation.sourceRevision, expectedSource.sourceRevision);
    assert.deepEqual(observation.observationLossAccounting, { lossCount: 0, persistedCount: 1 });
    for (const item of observation.items) {
      assert.ok(Object.hasOwn(item.itemIdentity, "lifecycleId"));
      assert.ok(Object.hasOwn(item, "rawLegacyStatus"));
      assert.ok(Object.hasOwn(item, "rawCanonicalStatus"));
      assert.ok(Object.hasOwn(item, "normalizedLegacyStatus"));
      assert.ok(Object.hasOwn(item, "normalizedCanonicalStatus"));
    }
  }

  const repaired = disposition(raw, "repaired");
  assert.deepEqual(repaired.proof, {
    beforeStatus: null,
    afterStatus: "completed",
    replayEqual: true,
    authorityUnchanged: true,
  });
  const loss = disposition(raw, "observation_loss");
  const lossAccounting = loss.proof["observationLossAccounting"] as Record<string, unknown>;
  assert.deepEqual(lossAccounting, {
    lossCount: 1,
    persistedCount: 1,
    reason: "shadow_query_failed",
    errorHash: lossAccounting["errorHash"],
  });

  const normalized = normalizeSemanticShadowCapstoneEvidence(raw);
  const replayedCollection = normalizeSemanticShadowCapstoneEvidence(
    await collectSemanticShadowCapstoneEvidence({ sourceRoot }),
  );
  assert.deepEqual(withoutExactSourceRevision(replayedCollection), withoutExactSourceRevision(normalized));
  assert.doesNotMatch(JSON.stringify(normalized), /lifecycleId/u);
  assert.ok(normalized.evidence.observations.every((observation) =>
    observation.items.every((item) => typeof item.itemIdentity.lifecyclePresent === "boolean")
  ));
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(normalized), normalized);
  assert.deepEqual(
    normalized.evidence.dispositions.map((entry) => entry.disposition),
    [...CAPSTONE_DISPOSITIONS],
  );

  const reordered = corrupt(raw, (copy) => {
    copy.observations.reverse();
    copy.dispositions.reverse();
    for (const observation of copy.observations) observation.items.reverse();
  });
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(reordered), normalized);
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(raw, (copy) => copy.observations.pop())),
    /12 observation envelopes/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(raw, (copy) => {
      copy.observations[11] = structuredClone(copy.observations[0]!);
    })),
    /duplicate observation cell/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(raw, (copy) => {
      copy.observations[0]!.sourceRevision = "sha256:mixed-source";
    })),
    /mixed source revision/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence({ ...normalized, evidenceHash: "sha256:corrupt" }),
    /evidence hash mismatch/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(raw, (copy) => {
      disposition(copy, "repaired").proof["replayEqual"] = false;
    })),
    /replay equality/i,
  );
  assert.throws(
    () => normalizeSemanticShadowCapstoneEvidence(corrupt(raw, (copy) => {
      const item = copy.observations[0]!.items.find((candidate) => candidate.classification === "match")!;
      item.rawLegacyStatus = "done";
    })),
    /inconsistent status tuple/i,
  );
});

test("stdout emitter is local and deterministic except for the exact source revision", () => {
  const args = [
    "--import",
    loaderPath,
    "--experimental-strip-types",
    emitterPath,
    "--source-root",
    process.cwd(),
  ];
  const first = execFileSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  const second = execFileSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  const firstParsed = JSON.parse(first);
  const secondParsed = JSON.parse(second);
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(firstParsed), firstParsed);
  assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(secondParsed), secondParsed);
  assert.deepEqual(withoutExactSourceRevision(secondParsed), withoutExactSourceRevision(firstParsed));
  assert.match(firstParsed.evidence.sourceRevision, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(first, /lifecycleId/u);
});

test("emitter writes canonical evidence to an explicit local output", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-capstone-emitter-"));
  const outputPath = join(root, "capstone.json");
  try {
    const stdout = execFileSync(process.execPath, [
      "--import",
      loaderPath,
      "--experimental-strip-types",
      emitterPath,
      "--source-root",
      process.cwd(),
      "--output",
      outputPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    const written = readFileSync(outputPath, "utf8");
    const parsed = JSON.parse(written);
    assert.equal(stdout, "");
    assert.equal(written, `${JSON.stringify(parsed, null, 2)}\n`);
    assert.deepEqual(normalizeSemanticShadowCapstoneEvidence(parsed), parsed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitter rejects network, duplicate, and extra arguments", () => {
  const invalidArguments = [
    ["--source-root", "https://example.com/repo"],
    ["--source-root", process.cwd(), "--output", "https://example.com/capstone.json"],
    ["--source-root", process.cwd(), "--source-root", process.cwd()],
    ["--source-root", process.cwd(), "unexpected"],
  ];
  for (const args of invalidArguments) {
    const result = spawnSync(process.execPath, [
      "--import",
      loaderPath,
      "--experimental-strip-types",
      emitterPath,
      ...args,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.notEqual(result.stderr, "", args.join(" "));
  }
});
