// Project/App: GSD-2
// File Purpose: Regression tests for CI builder image workflow configuration.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const BUILDER_IMAGE = "ghcr.io/open-gsd/gsd-ci-builder";

test("publish workflows use the builder image produced by pipeline", () => {
  const devPublish = readWorkflow("dev-publish.yml");
  const nextPublish = readWorkflow("next-publish.yml");
  const pipeline = readWorkflow("pipeline.yml");

  assert.equal(devPublish.jobs["dev-publish"].container.image, `${BUILDER_IMAGE}:latest`);
  assert.equal(nextPublish.jobs["next-publish"].container.image, `${BUILDER_IMAGE}:latest`);

  const buildStep = pipeline.jobs["update-builder"].steps.find((step: { name?: string }) => (
    step.name === "Build and push CI builder image"
  ));
  assert.ok(buildStep, "pipeline should include a CI builder publish step");
  assert.match(buildStep.run, new RegExp(`docker build --target builder[\\s\\S]*-t ${escapeRegExp(BUILDER_IMAGE)}:latest`));
  assert.match(buildStep.run, new RegExp(`docker push ${escapeRegExp(BUILDER_IMAGE)}:latest`));
});

test("package builder script targets the same image namespace", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8"));

  assert.equal(packageJson.scripts["docker:build-builder"], `docker build --target builder -t ${BUILDER_IMAGE} .`);
});

function readWorkflow(fileName: string): any {
  return parse(readFileSync(join(repoRoot(), ".github", "workflows", fileName), "utf8"));
}

function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".github", "workflows"))) return current;
    current = dirname(current);
  }
  throw new Error("Could not locate repository root");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
