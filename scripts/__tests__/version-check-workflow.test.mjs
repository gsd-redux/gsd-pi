// Project/App: gsd-pi
// File Purpose: Tests for the version-check workflow normalization logic and workflow wiring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  isOutdated,
  isVersionLike,
  normalizeReportedVersion,
} from "../lib/version-check-core.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const workflow = YAML.parse(
  readFileSync(join(repoRoot, ".github/workflows/version-check.yml"), "utf8"),
);
const scriptStep = workflow.jobs["check-version"].steps.find((step) =>
  step.uses?.startsWith("actions/github-script@"),
);
const script = scriptStep.with.script;

test("issue #2191 version forms all normalize to the bare version", () => {
  const cases = [
    "1.18.0",
    "v1.18.0",
    "V1.18.0",
    "`1.18.0`",
    "`v1.18.0`",
    "GSD v1.18.0",
    "GSD V1.18.0",
    "gsd v1.18.0",
    "GSD 1.18.0",
    "GSDv1.18.0",
    "  1.18.0  ",
    "  `1.18.0`  ",
  ];
  for (const raw of cases) {
    assert.equal(normalizeReportedVersion(raw), "1.18.0", `input: ${JSON.stringify(raw)}`);
  }
});

test("normalizeReportedVersion preserves a genuinely older version", () => {
  assert.equal(normalizeReportedVersion("`1.17.0`"), "1.17.0");
});

test("comparison still flags old versions and accepts current or newer ones", () => {
  assert.equal(isOutdated("1.17.0", "1.18.0"), true);
  assert.equal(isOutdated("1.18.0", "1.18.0"), false);
  assert.equal(isOutdated("1.18.0", "1.18.1"), true);
  assert.equal(isOutdated("2.0.0", "1.18.0"), false);
});

test("markdown-formatted current version no longer compares as outdated", () => {
  // Regression from issue #2191: `1.18.0` parsed as 0.18.0 and was flagged.
  assert.equal(isOutdated(normalizeReportedVersion("`1.18.0`"), "1.18.0"), false);
});

test("non-version garbage is not treated as a version", () => {
  for (const garbage of ["", "latest", "unknown", "not sure", "GSD"]) {
    assert.equal(isVersionLike(garbage), false, `input: ${JSON.stringify(garbage)}`);
  }
  assert.equal(isVersionLike("1.18.0"), true);
});

test("workflow extraction captures GSD-prefixed and formatted values whole", () => {
  const literal = script.match(/body\.match\((\/.*\/i)\)/)?.[1];
  assert.ok(literal, "extraction regex literal must exist in the script");
  const parsed = literal.match(/^\/(.*)\/([a-z]*)$/s);
  const extractor = new RegExp(parsed[1], parsed[2]);
  const cases = [
    ["1.18.0", "### GSD version\n\n1.18.0\n"],
    ["`1.18.0`", "### GSD version\n\n`1.18.0`\n"],
    ["`v1.18.0`", "### GSD version\n\n`v1.18.0`\n"],
    ["GSD v1.18.0", "### GSD version\n\nGSD v1.18.0\n"],
    ["GSD 1.18.0", "### GSD version\n\nGSD 1.18.0\n"],
    ["GSDv1.18.0", "### GSD version\n\nGSDv1.18.0\n"],
  ];
  for (const [value, body] of cases) {
    const captured = body.match(extractor)?.[1];
    assert.ok(captured, `must capture a value for: ${value}`);
    assert.equal(
      normalizeReportedVersion(captured),
      "1.18.0",
      `captured ${JSON.stringify(captured)} for: ${value}`,
    );
  }
});

test("workflow extraction keeps a genuinely old GSD-prefixed version flaggable", () => {
  const literal = script.match(/body\.match\((\/.*\/i)\)/)?.[1];
  const extractor = new RegExp(literal.match(/^\/(.*)\/([a-z]*)$/s)[1], "i");
  const captured = "### GSD version\n\nGSD v1.17.0\n".match(extractor)?.[1];
  assert.equal(normalizeReportedVersion(captured), "1.17.0");
  assert.equal(isOutdated(normalizeReportedVersion(captured), "1.18.0"), true);
});

test("workflow checks out the repo before running the inline script", () => {
  const steps = workflow.jobs["check-version"].steps;
  const scriptStepIndex = steps.indexOf(scriptStep);
  assert.ok(scriptStepIndex > 0, "github-script step must exist");
  const checkout = steps
    .slice(0, scriptStepIndex)
    .find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "a checkout step must run before the github-script step");
});

test("workflow uses the shared module instead of inline comparison logic", () => {
  assert.match(script, /scripts\/lib\/version-check-core\.mjs/);
  assert.match(script, /normalizeReportedVersion\(/);
  assert.match(script, /isVersionLike\(/);
  assert.match(script, /isOutdated\(/);
  assert.doesNotMatch(script, /function parseVersion/);
});

test("workflow keeps the bot marker and needs-upgrade label", () => {
  assert.match(script, /gsd-version-check/);
  assert.match(script, /needs-upgrade/);
});
