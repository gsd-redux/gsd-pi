// Project/App: GSD-2
// File Purpose: Regression tests for npm publish workflow channel policy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(
  readFileSync(".github/workflows/npm-publish.yml", "utf8"),
);

test("npm publish exposes only supported npm channels", () => {
  const channel = workflow.on.workflow_dispatch.inputs.channel;

  assert.equal(channel.required, true);
  assert.equal(channel.default, "dev");
  assert.deepEqual(channel.options, ["dev", "next", "latest"]);
});

test("prerelease publish gates through the selected GitHub Environment", () => {
  assert.equal(
    workflow.jobs["prerelease-publish"].environment,
    "${{ github.event.inputs.channel }}",
  );
});

test("production publish keeps the prod approval gate", () => {
  assert.equal(
    workflow.jobs["prod-release"].if,
    "${{ github.event.inputs.channel == 'latest' }}",
  );
  assert.equal(workflow.jobs["prod-release"].environment, "prod");
});

test("prerelease publish preserves channel-specific default refs", () => {
  const checkout = workflow.jobs["prerelease-publish"].steps.find(
    (step) => step.uses === "actions/checkout@v6",
  );

  assert.equal(workflow.on.workflow_dispatch.inputs.ref.default, "");
  assert.match(checkout.with.ref, /github\.event\.inputs\.channel == 'next'/);
  assert.match(checkout.with.ref, /'next'/);
  assert.match(checkout.with.ref, /'main'/);
});
