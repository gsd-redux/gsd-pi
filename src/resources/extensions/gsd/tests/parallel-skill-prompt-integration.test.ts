/**
 * Worker × Skill × Subagent — prompt composition integration test.
 *
 * Covers two previously-untested seams:
 *
 *  P1. Worker × Skill — when a parallel worker's auto loop reaches a
 *      research/plan/execute unit, the prompt it receives must include the
 *      `<skill_activation>` block derived from the project's PREFERENCES.md.
 *      `buildSkillActivationBlock` is unit-tested in isolation; here we
 *      verify a dispatch-level builder actually plumbs it through.
 *
 *  P2. Subagent × Skill — when `buildParallelResearchSlicesPrompt` composes
 *      per-slice subagent prompts, each embedded prompt must also carry the
 *      `<skill_activation>` block so the dispatched subagent inherits it.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadSkills } from "@gsd/pi-coding-agent";
import {
  buildCompleteSlicePrompt,
  buildParallelResearchSlicesPrompt,
  buildResearchSlicePrompt,
} from "../auto-prompts.ts";

const SKILL_NAME = "testskill";
const COMPLETE_SLICE_SKILL_NAME = "complete-slice-policies";
const SKILL_ACTIVATION_SUBSTRING = `Read the installed '${SKILL_NAME}' skill file from <available_skills>`;
const COMPLETE_SLICE_SKILL_ACTIVATION_SUBSTRING = `Read the installed '${COMPLETE_SLICE_SKILL_NAME}' skill file from <available_skills>`;

const tmpDirs: string[] = [];
let savedCwd: string | undefined;

function setupProjectWithSkill(options: {
  skillName?: string;
  preferencesLines?: string[];
} = {}): string {
  const skillName = options.skillName ?? SKILL_NAME;
  const base = mkdtempSync(join(tmpdir(), "gsd-worker-skill-int-"));
  tmpDirs.push(base);

  // Milestone roadmap — buildResearchSlicePrompt inlines the roadmap excerpt.
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceOneDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(sliceOneDir, "tasks"), { recursive: true });
  mkdirSync(join(milestoneDir, "slices", "S02"), { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "**Vision:** Verify worker × skill prompt plumbing.",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
      "- [ ] **S02: Beta** `risk:low` `depends:[]`",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(sliceOneDir, "S01-PLAN.md"),
    [
      "# S01: Alpha",
      "",
      "**Goal:** Verify worker x skill prompt plumbing.",
      "**Demo:** Rendered prompts include the skill activation block.",
      "",
      "## Tasks",
      "- [x] **T01: Task** `est:10m`",
      "",
    ].join("\n"),
    "utf-8",
  );

  // Project preferences — buildSkillActivationBlock picks these up via
  // loadEffectiveGSDPreferences(), which reads from `${cwd}/.gsd/PREFERENCES.md`.
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", ...(options.preferencesLines ?? [`always_use_skills:`, `  - ${skillName}`]), "---", ""].join("\n"),
    "utf-8",
  );

  // Project-scoped skill — resolveSkillReference scans `${cwd}/.agents/skills/`.
  const skillDir = join(base, ".agents", "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      `description: Integration-test skill for worker × skill prompt plumbing.`,
      "---",
      "",
      `# ${skillName}`,
      "",
      "Test skill body.",
    ].join("\n"),
    "utf-8",
  );

  // Load this skill into the in-process skill registry so
  // buildSkillActivationBlock treats it as "installed".
  loadSkills({
    cwd: base,
    agentDir: join(base, ".agent"),
    includeDefaults: false,
    skillPaths: [join(base, ".agents", "skills")],
  });

  return base;
}

afterEach(() => {
  if (savedCwd !== undefined) {
    try { process.chdir(savedCwd); } catch { /* best-effort */ }
    savedCwd = undefined;
  }
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs.length = 0;
});

test("worker prompt (buildResearchSlicePrompt) includes <skill_activation> from PREFERENCES.md", async () => {
  const base = setupProjectWithSkill();
  savedCwd = process.cwd();
  process.chdir(base);

  const prompt = await buildResearchSlicePrompt("M001", "Test Milestone", "S01", "Alpha", base);

  assert.ok(
    prompt.includes("<skill_activation>"),
    "research-slice prompt should contain a <skill_activation> block",
  );
  assert.ok(
    prompt.includes(SKILL_ACTIVATION_SUBSTRING),
    `research-slice prompt should reference the always-used skill '${SKILL_NAME}'`,
  );
});

test("complete-slice prompt includes <skill_activation> from unit-specific skill_rules", async () => {
  const base = setupProjectWithSkill({
    skillName: COMPLETE_SLICE_SKILL_NAME,
    preferencesLines: [
      "skill_rules:",
      "  - when: complete-slice",
      "    use:",
      `      - ${COMPLETE_SLICE_SKILL_NAME}`,
    ],
  });
  savedCwd = process.cwd();
  process.chdir(base);

  const prompt = await buildCompleteSlicePrompt("M001", "Test Milestone", "S01", "Alpha", base, "minimal");

  assert.ok(
    prompt.includes("<skill_activation>"),
    "complete-slice prompt should contain a <skill_activation> block",
  );
  assert.ok(
    prompt.includes(COMPLETE_SLICE_SKILL_ACTIVATION_SUBSTRING),
    `complete-slice prompt should reference the skill-rule skill '${COMPLETE_SLICE_SKILL_NAME}'`,
  );
});

test("subagent dispatch prompt (buildParallelResearchSlicesPrompt) carries <skill_activation> into each embedded per-slice section", async () => {
  const base = setupProjectWithSkill();
  savedCwd = process.cwd();
  process.chdir(base);

  const prompt = await buildParallelResearchSlicesPrompt(
    "M001",
    "Test Milestone",
    [
      { id: "S01", title: "Alpha" },
      { id: "S02", title: "Beta" },
    ],
    base,
  );

  // The parallel dispatch prompt concatenates per-slice subagent prompts inside
  // fenced code blocks. Each block should carry the same skill activation.
  const blockCount = (prompt.match(/<skill_activation>/g) ?? []).length;
  assert.ok(
    blockCount >= 2,
    `expected at least 2 <skill_activation> blocks (one per slice), got ${blockCount}`,
  );
  assert.ok(
    prompt.includes(SKILL_ACTIVATION_SUBSTRING),
    `parallel-research-slices prompt should reference the always-used skill '${SKILL_NAME}'`,
  );
  assert.ok(
    prompt.includes("Context Mode (research lane):"),
    "embedded parallel research subagent prompts should use nested Context Mode guidance",
  );
  assert.ok(
    !prompt.includes("## Context Mode\n\nLane: **research lane**."),
    "embedded parallel research subagent prompts should not use standalone Context Mode heading",
  );
});
