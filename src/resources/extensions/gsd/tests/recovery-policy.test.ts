// Project/App: gsd-pi
// File Purpose: Contract tests for deterministic Task recovery and genuine blockers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFailureFingerprint,
  selectRecoveryDecision,
  type HumanBlockerKind,
} from "../recovery-policy.ts";

test("agent transient recovery is bounded and never becomes a human pause", () => {
  const classification = { failureKind: "tool-unavailable" } as const;

  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification,
    budgetUses: 1,
  }), {
    owner: "agent",
    action: "retry",
    budget: { policyClass: "transient-execution", maxUses: 2 },
    policyVersion: "task-recovery-v1",
  });

  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification,
    budgetUses: 2,
  }), {
    owner: "agent",
    action: "abort",
    budget: null,
    policyVersion: "task-recovery-v1",
  });
});

test("agent repair and remediation abort when their fixed budgets are exhausted", () => {
  const repair = { failureKind: "illegal-transition" } as const;
  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification: repair,
    budgetUses: 0,
  }).action, "repair");
  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification: repair,
    budgetUses: 1,
  }).action, "abort");

  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    budgetUses: 1,
  }), {
    owner: "agent",
    action: "remediate",
    budget: { policyClass: "remediation", maxUses: 2 },
    policyVersion: "task-recovery-v1",
  });
  assert.equal(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    budgetUses: 2,
  }).action, "abort");
});

test("schema correction and objective UAT match the fixed v34 budgets", () => {
  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "tool-schema" },
    budgetUses: 0,
  }), {
    owner: "agent",
    action: "repair",
    budget: { policyClass: "schema-correction", maxUses: 2 },
    policyVersion: "task-recovery-v1",
  });
  assert.deepEqual(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "objective-uat" },
    budgetUses: 1,
  }), {
    owner: "agent",
    action: "retry",
    budget: { policyClass: "objective-uat", maxUses: 2 },
    policyVersion: "task-recovery-v1",
  });
});

test("only a transient provider classification receives an agent retry", () => {
  const transient = { failureKind: "provider", action: "retry" } as const;
  const permanent = { failureKind: "provider", action: "escalate" } as const;
  assert.equal(selectRecoveryDecision({
    owner: "agent",
    classification: transient,
    budgetUses: 0,
  }).action, "retry");
  assert.equal(selectRecoveryDecision({
    owner: "agent",
    classification: permanent,
    budgetUses: 0,
  }).action, "abort");
});

test("invalid decomposition replans once and then aborts", () => {
  assert.equal(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "plan-invalid" },
    budgetUses: 0,
    replanUses: 0,
  }).action, "replan");
  assert.equal(selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "plan-invalid" },
    budgetUses: 0,
    replanUses: 1,
  }).action, "abort");
});

test("only genuine user boundaries clarify or pause", () => {
  assert.deepEqual(selectRecoveryDecision({
    owner: "user",
    blockerKind: "ambiguous_intent",
  }), {
    owner: "user",
    action: "clarify",
    blockerKind: "ambiguous_intent",
    policyVersion: "task-recovery-v1",
  });
  assert.deepEqual(selectRecoveryDecision({
    owner: "user",
    blockerKind: "missing_access",
  }), {
    owner: "user",
    action: "pause",
    blockerKind: "missing_access",
    policyVersion: "task-recovery-v1",
  });
});

test("external dependencies pause only the affected boundary", () => {
  assert.deepEqual(selectRecoveryDecision({
    owner: "external",
    blockerKind: "external_dependency",
  }), {
    owner: "external",
    action: "pause",
    blockerKind: "external_dependency",
    policyVersion: "task-recovery-v1",
  });
});

test("all canonical blocker kinds remain typed human or external boundaries", () => {
  const userKinds: Array<[HumanBlockerKind, "clarify" | "pause"]> = [
    ["missing_authority", "pause"],
    ["missing_access", "pause"],
    ["consent", "clarify"],
    ["ambiguous_intent", "clarify"],
    ["subjective_uat", "clarify"],
    ["user_limit", "pause"],
  ];
  for (const [blockerKind, action] of userKinds) {
    assert.equal(selectRecoveryDecision({ owner: "user", blockerKind }).action, action);
  }
  assert.throws(
    () => selectRecoveryDecision({ owner: "user", blockerKind: "external_dependency" }),
    /external owner/,
  );
  assert.throws(
    () => selectRecoveryDecision({ owner: "external", blockerKind: "missing_access" }),
    /external_dependency blocker/,
  );
});

test("invalid persisted counters fail loudly", () => {
  assert.throws(() => selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "tool-schema" },
    budgetUses: -1,
  }), /budgetUses must be a non-negative safe integer/);
  assert.throws(() => selectRecoveryDecision({
    owner: "agent",
    classification: { failureKind: "plan-invalid" },
    budgetUses: 0,
    replanUses: 0.5,
  }), /replanUses must be a non-negative safe integer/);
});

test("failure fingerprints use only policy-relevant structured classification", () => {
  const first = normalizeFailureFingerprint({ failureKind: "tool-unavailable" });
  const replay = normalizeFailureFingerprint({ failureKind: "tool-unavailable", action: "retry" });
  assert.equal(first, replay);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, normalizeFailureFingerprint({ failureKind: "tool-schema" }));
  assert.notEqual(
    normalizeFailureFingerprint({ failureKind: "provider", action: "retry" }),
    normalizeFailureFingerprint({ failureKind: "provider", action: "escalate" }),
  );
  assert.throws(
    () => normalizeFailureFingerprint({ failureKind: " " as "provider" }),
    /failureKind/,
  );
});
