// Project/App: gsd-pi
// File Purpose: Fail-closed normalization for semantic-shadow capstone test evidence.

import { createHash } from "node:crypto";

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

export interface CapstoneObservationEnvelope {
  mode: typeof CAPSTONE_MODES[number];
  transport: typeof CAPSTONE_TRANSPORTS[number];
  sourceRevision: string;
  responseHash: string;
  classifications: string[];
  lossCount: number;
  persistedCount: number;
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

export interface NormalizedSemanticShadowCapstoneEvidence {
  evidence: SemanticShadowCapstoneEvidence;
  evidenceHash: string;
}

function fail(message: string): never {
  throw new Error(`Invalid semantic-shadow capstone evidence: ${message}`);
}

function asEvidence(
  input: SemanticShadowCapstoneEvidence | NormalizedSemanticShadowCapstoneEvidence,
): { evidence: SemanticShadowCapstoneEvidence; suppliedHash?: string } {
  if (!input || typeof input !== "object") fail("evidence must be an object");
  if ("evidence" in input) {
    if (!input.evidence || typeof input.evidence !== "object") fail("evidence payload is missing");
    return { evidence: input.evidence, suppliedHash: input.evidenceHash };
  }
  return { evidence: input };
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(`${field} must be a sha256 digest`);
  }
  return value;
}

function sameMembers(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function validateObservations(
  observations: CapstoneObservationEnvelope[],
  sourceRevision: string,
  responseHash: string,
): CapstoneObservationEnvelope[] {
  if (!Array.isArray(observations) || observations.length !== 12) {
    fail("exactly 12 observation envelopes are required");
  }

  const cells = new Set<string>();
  const normalized = observations.map((observation) => {
    if (!observation || typeof observation !== "object") fail("observation envelope is invalid");
    if (!CAPSTONE_MODES.includes(observation.mode)) fail(`unsupported mode: ${String(observation.mode)}`);
    if (!CAPSTONE_TRANSPORTS.includes(observation.transport)) {
      fail(`unsupported transport: ${String(observation.transport)}`);
    }
    const cell = `${observation.mode}/${observation.transport}`;
    if (cells.has(cell)) fail(`duplicate observation cell: ${cell}`);
    cells.add(cell);
    if (observation.sourceRevision !== sourceRevision) fail(`mixed source revision in ${cell}`);
    if (observation.responseHash !== responseHash) fail(`response neutrality changed in ${cell}`);
    if (observation.lossCount !== 0 || observation.persistedCount !== 1) {
      fail(`clean matrix observation loss in ${cell}`);
    }
    if (!Array.isArray(observation.classifications)) fail(`classification set is missing in ${cell}`);
    const classifications = [...observation.classifications].sort();
    if (!sameMembers(classifications, CAPSTONE_CLASSIFICATIONS)) {
      fail(`classification set changed in ${cell}`);
    }
    return { ...observation, classifications };
  });

  for (const mode of CAPSTONE_MODES) {
    for (const transport of CAPSTONE_TRANSPORTS) {
      if (!cells.has(`${mode}/${transport}`)) fail(`missing observation cell: ${mode}/${transport}`);
    }
  }
  return normalized.sort((left, right) =>
    CAPSTONE_MODES.indexOf(left.mode) - CAPSTONE_MODES.indexOf(right.mode)
    || CAPSTONE_TRANSPORTS.indexOf(left.transport) - CAPSTONE_TRANSPORTS.indexOf(right.transport)
  );
}

function validateDispositionProof(disposition: CapstoneDispositionEvidence, responseHash: string): void {
  const proof = disposition.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) fail(`${disposition.disposition} proof is missing`);
  if (disposition.disposition === "advanced") {
    if (proof["beforeStatus"] !== "ready" || proof["afterStatus"] !== "in_progress") {
      fail("advanced proof must show ready to in_progress");
    }
    return;
  }
  if (disposition.disposition === "repaired") {
    if (proof["beforeStatus"] !== null || proof["afterStatus"] !== "completed") {
      fail("repaired proof must show adoption to completed");
    }
    return;
  }
  if (disposition.disposition === "unresolved") {
    if (proof["beforeStatus"] !== null || proof["afterStatus"] !== null) {
      fail("unresolved proof must show no lifecycle mutation");
    }
    return;
  }
  if (disposition.disposition === "rejected") {
    if (proof["authorityUnchanged"] !== true) fail("rejected proof must preserve workflow authority");
    return;
  }
  if (
    typeof proof["lossCount"] !== "number"
    || proof["lossCount"] < 1
    || proof["persistedCount"] !== 1
    || proof["responseHash"] !== responseHash
  ) {
    fail("observation_loss proof must be persisted and response-neutral");
  }
}

function validateDispositions(
  dispositions: CapstoneDispositionEvidence[],
  sourceRevision: string,
  responseHash: string,
): CapstoneDispositionEvidence[] {
  if (!Array.isArray(dispositions) || dispositions.length !== CAPSTONE_DISPOSITIONS.length) {
    fail("exactly five independent disposition proofs are required");
  }
  const seen = new Set<string>();
  for (const disposition of dispositions) {
    if (!disposition || typeof disposition !== "object") fail("disposition evidence is invalid");
    if (!CAPSTONE_DISPOSITIONS.includes(disposition.disposition)) {
      fail(`unsupported disposition: ${String(disposition.disposition)}`);
    }
    if (seen.has(disposition.disposition)) fail(`duplicate disposition: ${disposition.disposition}`);
    seen.add(disposition.disposition);
    if (disposition.sourceRevision !== sourceRevision) {
      fail(`mixed source revision in ${disposition.disposition} proof`);
    }
    validateDispositionProof(disposition, responseHash);
  }
  return [...dispositions].sort((left, right) =>
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
  input: SemanticShadowCapstoneEvidence | NormalizedSemanticShadowCapstoneEvidence,
): NormalizedSemanticShadowCapstoneEvidence {
  const { evidence, suppliedHash } = asEvidence(input);
  if (evidence.schemaVersion !== 1) fail("schemaVersion must be 1");
  const sourceRevision = requireSha256(evidence.sourceRevision, "sourceRevision");
  const responseHash = requireSha256(evidence.responseHash, "responseHash");
  const normalizedEvidence: SemanticShadowCapstoneEvidence = {
    schemaVersion: 1,
    sourceRevision,
    responseHash,
    observations: validateObservations(evidence.observations, sourceRevision, responseHash),
    dispositions: validateDispositions(evidence.dispositions, sourceRevision, responseHash),
  };
  const evidenceHash = `sha256:${createHash("sha256")
    .update(canonicalJson(normalizedEvidence))
    .digest("hex")}`;
  if (suppliedHash !== undefined && suppliedHash !== evidenceHash) fail("evidence hash mismatch");
  return { evidence: normalizedEvidence, evidenceHash };
}
