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

async function executeWorkflow(reportedVersion) {
  const comments = [];
  const labels = [];
  const outputs = [];
  const context = {
    payload: { issue: { body: `### GSD version\n\n${reportedVersion}\n`, number: 2189 } },
    repo: { owner: "open-gsd", repo: "gsd-pi" },
  };
  const core = {
    info() {},
    warning() {},
    setFailed(message) { assert.fail(message); },
    setOutput(name, value) { outputs.push({ name, value }); },
  };
  const github = {
    rest: {
      issues: {
        async listComments() { return { data: [] }; },
        async createComment(payload) { comments.push(payload); },
        async addLabels(payload) { labels.push(payload); },
      },
    },
  };
  async function fetchLatest(url) {
    assert.equal(url, "https://registry.npmjs.org/@opengsd%2fgsd-pi/latest");
    return { ok: true, async json() { return { version: "1.18.0" }; } };
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("context", "core", "github", "fetch", "process", script);
  await run(context, core, github, fetchLatest, { cwd: () => repoRoot });
  return { comments, labels, outputs };
}

test("workflow does not write upgrade prompts for current or invalid versions", async () => {
  for (const version of ["1.18.0", "`1.18.0`", "GSD v1.18.0", "latest", "GSD", "unknown"]) {
    assert.deepEqual(
      await executeWorkflow(version),
      { comments: [], labels: [], outputs: [] },
      `input: ${JSON.stringify(version)}`,
    );
  }
});

test("workflow posts the upgrade comment and label for older versions", async () => {
  for (const version of ["1.17.0", "GSD v1.17.0"]) {
    const { comments, labels } = await executeWorkflow(version);
    assert.equal(comments.length, 1);
    const { body, ...destination } = comments[0];
    assert.deepEqual(destination, { owner: "open-gsd", repo: "gsd-pi", issue_number: 2189 });
    assert.ok(body.startsWith("<!-- gsd-version-check -->\n"));
    assert.ok(body.includes("**GSD v1.17.0**"));
    assert.ok(body.includes("**v1.18.0**"));
    assert.deepEqual(labels, [{
      owner: "open-gsd",
      repo: "gsd-pi",
      issue_number: 2189,
      labels: ["needs-upgrade"],
    }]);
  }
});
