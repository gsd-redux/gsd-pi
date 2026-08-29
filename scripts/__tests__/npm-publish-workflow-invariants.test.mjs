// Project/App: gsd-pi
// File Purpose: Structural invariants for .github/workflows/npm-publish.yml —
// the release-critical workflow whose inline logic can otherwise only be
// exercised during a real production release (#2067). Pins the ordering and
// cross-step contracts the 1.17.0 fold race violated: engines are verified
// before the lockfile fold, the fold checks the regenerated lockfile through
// the unit-tested guard script, and the engine platform list never drifts
// between steps.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

import { ENGINE_PLATFORMS } from "../release-lockfile-guard.mjs";

const workflow = YAML.parse(
  readFileSync(".github/workflows/npm-publish.yml", "utf8"),
);

function findJobByName(name) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.name === name) return { id, job };
  }
  throw new Error(`job with name "${name}" not found`);
}

function findStep(job, name) {
  const index = (job.steps ?? []).findIndex((step) => step.name === name);
  if (index === -1) throw new Error(`step "${name}" not found`);
  return { step: job.steps[index], index };
}

test("the production release job is gated behind the prod environment", () => {
  const { job } = findJobByName("Production Release");
  assert.equal(job.environment, "prod");
});

test("the dev publish job is gated behind the dev environment", () => {
  // The job name/env are template expressions ("Publish @${{ ... 'dev' || channel }}"),
  // so match on the environment expression rather than a literal name.
  const devGated = Object.entries(workflow.jobs).filter(
    ([, job]) => typeof job.environment === "string" && job.environment.includes("'dev'"),
  );
  assert.ok(devGated.length > 0, "a job gated on the dev environment must exist");
  for (const [, job] of devGated) {
    assert.match(String(job.name), /^Publish @/);
  }
});

test("engine publish → verify → fold run in that order inside one job", () => {
  const { job } = findJobByName("Production Release");
  const publish = findStep(job, "Publish native platform packages for release version");
  const verify = findStep(job, "Verify native platform packages are published");
  const fold = findStep(job, "Fold native packages into release lockfile");
  assert.ok(publish.index < verify.index, "engines must be published before the visibility verify");
  assert.ok(verify.index < fold.index, "the lockfile fold must run after the visibility verify");
});

test("the visibility verify poll covers exactly the guard script's platform set", () => {
  const { job } = findJobByName("Production Release");
  const { step } = findStep(job, "Verify native platform packages are published");
  const run = String(step.run ?? "");
  // The inline poll iterates the platform list directly; the guard script owns
  // the canonical set. If either side drifts, this fails.
  const polled = [...run.matchAll(/for platform in (.+?); do/g)].flatMap(
    (match) => match[1].trim().split(/\s+/),
  );
  assert.ok(polled.length > 0, "verify step must poll a platform list");
  assert.deepEqual([...new Set(polled)].sort(), [...ENGINE_PLATFORMS].sort());
});

test("the fold verifies the regenerated lockfile through the guard script", () => {
  const { job } = findJobByName("Production Release");
  const { step } = findStep(job, "Fold native packages into release lockfile");
  const run = String(step.run ?? "");
  assert.match(run, /node scripts\/release-lockfile-guard\.mjs verify-lockfile --version "\$\{RELEASE_VERSION\}"/);
  assert.match(run, /pnpm install --lockfile-only/);
  assert.match(run, /git commit --amend --no-edit/);
  assert.match(run, /git tag -f/);
});

test("the fold retries and refuses to commit an incomplete lockfile", () => {
  const { job } = findJobByName("Production Release");
  const { step } = findStep(job, "Fold native packages into release lockfile");
  const run = String(step.run ?? "");
  assert.match(run, /seq 1 6/, "the fold must have a bounded retry loop");
  assert.match(run, /sleep 45/, "the fold must wait between retries for registry caches to expire");
  assert.match(run, /refusing to fold/, "the failure path must refuse the fold, not commit anyway");
});

test("the fold's RELEASE_VERSION is wired to the release plan output", () => {
  const { job } = findJobByName("Production Release");
  const { step } = findStep(job, "Fold native packages into release lockfile");
  assert.equal(
    step.env.RELEASE_VERSION,
    "${{ needs.prod-release-plan.outputs.version }}",
  );
});
