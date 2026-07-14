/**
 * Model UnitType Mapping — behavior tests for #2865 / #2900 / ADR-011.
 *
 * Verifies model routing, metrics/dashboard labels, and artifact resolution
 * through exported runtime APIs instead of inspecting source text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { unitPhaseLabel, unitVerb } from "../auto-dashboard.ts";
import { classifyUnitPhase } from "../metrics.ts";
import { resolveDefaultSessionModel, resolveModelWithFallbacksForUnit } from "../preferences-models.ts";
import { KNOWN_UNIT_LABELS } from "../preferences-types.ts";

function withModelPreferences<T>(fn: () => T): T {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "preferences.md"), [
      "---",
      "models:",
      "  research: research-model",
      "  planning: planning-model",
      "  discuss: discuss-model",
      "  execution: execution-model",
      "  execution_simple: simple-model",
      "  completion: completion-model",
      "  validation: validation-model",
      "  subagent: subagent-model",
      "  uat: uat-model",
      "---",
      "",
    ].join("\n"));
    return fn();
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("discuss unit types route to the discuss model bucket", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("discuss-milestone")?.primary, "discuss-model");
    assert.equal(resolveModelWithFallbacksForUnit("discuss-slice")?.primary, "discuss-model");
  });
});

test("validation unit types route to the validation model bucket", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("validate-milestone")?.primary, "validation-model");
    assert.equal(resolveModelWithFallbacksForUnit("gate-evaluate")?.primary, "validation-model");
  });
});

test("worktree-merge routes to completion and is recognized as a unit label", () => {
  withModelPreferences(() => {
    assert.ok(KNOWN_UNIT_LABELS.includes("worktree-merge"));
    assert.equal(resolveModelWithFallbacksForUnit("worktree-merge")?.primary, "completion-model");
  });
});

test("run-uat routes to uat model bucket when configured", () => {
  withModelPreferences(() => {
    assert.equal(resolveModelWithFallbacksForUnit("run-uat")?.primary, "uat-model");
  });
});

test("run-uat falls back to completion when uat bucket is not configured", () => {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-uat-fallback-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "preferences.md"), [
      "---",
      "models:",
      "  completion: completion-model",
      "---",
      "",
    ].join("\n"));
    assert.equal(resolveModelWithFallbacksForUnit("run-uat")?.primary, "completion-model");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("default session model resolves from the explicit project base path", () => {
  const oldHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-model-map-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-model-map-project-"));

  try {
    process.env.GSD_HOME = home;
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), [
      "---",
      "models:",
      "  execution: gpt-5.5",
      "---",
      "",
    ].join("\n"));
    process.chdir(home);

    assert.deepEqual(resolveDefaultSessionModel("openai-codex", base), {
      provider: "openai-codex",
      id: "gpt-5.5",
    });
  } finally {
    process.chdir(originalCwd);
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test("every known unit label with a dispatch phase resolves when all model buckets are configured", () => {
  withModelPreferences(() => {
    const missing = KNOWN_UNIT_LABELS.filter((unitType) => !resolveModelWithFallbacksForUnit(unitType));
    assert.deepEqual(missing, []);
  });
});

test("discuss-slice has discussion metrics and dashboard labels", () => {
  assert.equal(classifyUnitPhase("discuss-slice"), "discussion");
  assert.equal(unitVerb("discuss-slice"), "discussing");
  assert.equal(unitPhaseLabel("discuss-slice"), "DISCUSS");
});

test("discuss-slice resolves to the slice context artifact path", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-discuss-artifact-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const path = resolveExpectedArtifactPath("discuss-slice", "M001/S01", base);
    assert.ok(path);
    assert.equal(
      join(realpathSync(dirname(path)), basename(path)),
      join(realpathSync(base), ".gsd", "milestones", "M001", "slices", "S01", "S01-CONTEXT.md"),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
