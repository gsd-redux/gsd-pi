// gsd-2 / Worktree path injection regression tests (#5061)
//
// Locks in the three-layer fix that anchors subagent dispatch to the
// canonical milestone worktree path:
//   1. Dispatch layer: chdir(basePath) fires BEFORE newSession() captures cwd
//   2. Prompt builders inject `workingDirectory` and templates render it
//   3. Review/lint/test skills carry a working-directory-awareness directive
//
// If any of these regress (chdir moves back after newSession, a builder drops
// the workingDirectory key, a template loses its directive, a skill loses its
// awareness block), the corresponding test fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");
const promptsDir = join(gsdDir, "prompts");
const skillsDir = join(gsdDir, "..", "..", "skills");

function indexBefore(haystack: string, needle: string, after: number = 0): number {
  const idx = haystack.indexOf(needle, after);
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: Dispatch chdir must fire BEFORE newSession() captures cwd
// ─────────────────────────────────────────────────────────────────────────────

test("run-unit.ts: process.chdir(s.basePath) fires before s.cmdCtx!.newSession()", () => {
  const src = readFileSync(join(gsdDir, "auto/run-unit.ts"), "utf-8");
  const chdirIdx = indexBefore(src, "process.chdir(s.basePath)");
  const newSessionIdx = indexBefore(src, "s.cmdCtx!.newSession");
  assert.ok(chdirIdx >= 0, "process.chdir(s.basePath) call must exist in run-unit.ts");
  assert.ok(newSessionIdx >= 0, "s.cmdCtx!.newSession call must exist in run-unit.ts");
  assert.ok(
    chdirIdx < newSessionIdx,
    `chdir must precede newSession so the new session captures the worktree cwd. ` +
      `Found chdir at offset ${chdirIdx}, newSession at offset ${newSessionIdx}.`,
  );
});

test("auto.ts dispatchHookUnit: chdir fires before hook newSession", () => {
  const src = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
  const fnStart = src.indexOf("export async function dispatchHookUnit");
  assert.ok(fnStart > 0, "dispatchHookUnit not found in auto.ts");
  const fnEnd = src.indexOf("\nexport ", fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);

  const chdirIdx = fnBody.indexOf("process.chdir(s.basePath)");
  const newSessionIdx = fnBody.indexOf("s.cmdCtx!.newSession");
  assert.ok(chdirIdx >= 0, "process.chdir(s.basePath) must exist inside dispatchHookUnit");
  assert.ok(newSessionIdx >= 0, "s.cmdCtx!.newSession must exist inside dispatchHookUnit");
  assert.ok(
    chdirIdx < newSessionIdx,
    `chdir must precede newSession inside dispatchHookUnit. ` +
      `Found chdir at body offset ${chdirIdx}, newSession at body offset ${newSessionIdx}.`,
  );
});

test("auto-direct-dispatch.ts: resolves canonical worktree and chdirs before newSession", () => {
  const src = readFileSync(join(gsdDir, "auto-direct-dispatch.ts"), "utf-8");

  assert.ok(
    src.includes("resolveCanonicalMilestoneRoot"),
    "auto-direct-dispatch must import and call resolveCanonicalMilestoneRoot " +
      "to switch base to the canonical worktree path before dispatch",
  );

  const chdirIdx = src.indexOf("process.chdir(base)");
  const newSessionIdx = src.indexOf("ctx.newSession");
  assert.ok(chdirIdx >= 0, "process.chdir(base) must exist in auto-direct-dispatch.ts");
  assert.ok(newSessionIdx >= 0, "ctx.newSession must exist in auto-direct-dispatch.ts");
  assert.ok(
    chdirIdx < newSessionIdx,
    `chdir must precede newSession in dispatchDirectPhase. ` +
      `Found chdir at offset ${chdirIdx}, newSession at offset ${newSessionIdx}.`,
  );

  // The base reassignment must happen before the chdir so the worktree path
  // (not the project root) is the one we chdir to.
  const reassignIdx = src.indexOf("base = resolveCanonicalMilestoneRoot");
  assert.ok(reassignIdx >= 0, "base must be reassigned to the canonical worktree root");
  assert.ok(
    reassignIdx < chdirIdx,
    "base = resolveCanonicalMilestoneRoot(...) must run before process.chdir(base)",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: Prompt templates carry a {{workingDirectory}} directive
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES_REQUIRING_WORKING_DIRECTORY = [
  "rewrite-docs",
  "guided-discuss-milestone",
  "parallel-research-slices",
];

for (const name of TEMPLATES_REQUIRING_WORKING_DIRECTORY) {
  test(`prompts/${name}.md: includes {{workingDirectory}} placeholder`, () => {
    const content = readFileSync(join(promptsDir, `${name}.md`), "utf-8");
    assert.ok(
      content.includes("{{workingDirectory}}"),
      `${name}.md must reference {{workingDirectory}} so the spawned agent ` +
        `knows which directory to operate against`,
    );

    const rendered = content.replaceAll("{{workingDirectory}}", "/tmp/test-worktree");
    assert.ok(
      rendered.includes("/tmp/test-worktree"),
      `${name}.md must produce the substituted path in rendered output`,
    );
    assert.ok(
      !rendered.includes("{{workingDirectory}}"),
      `${name}.md must not leave any {{workingDirectory}} placeholders unrendered`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 (cont): Prompt builders pass workingDirectory to loadPrompt
// ─────────────────────────────────────────────────────────────────────────────

test("auto-prompts.ts: fixed builders inject workingDirectory into loadPrompt", () => {
  const src = readFileSync(join(gsdDir, "auto-prompts.ts"), "utf-8");

  const builders: Array<{ name: string; expectedKey: string }> = [
    { name: "buildRewriteDocsPrompt", expectedKey: "workingDirectory: base" },
    { name: "buildDiscussMilestonePrompt", expectedKey: "workingDirectory: base" },
    { name: "buildParallelResearchSlicesPrompt", expectedKey: "workingDirectory: basePath" },
  ];

  for (const { name, expectedKey } of builders) {
    const fnStart = src.indexOf(`export async function ${name}`);
    assert.ok(fnStart > 0, `${name} not found in auto-prompts.ts`);
    const fnEnd = src.indexOf("\nexport ", fnStart + 1);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);
    assert.ok(
      body.includes(expectedKey),
      `${name} must pass \`${expectedKey}\` to loadPrompt so the spawned ` +
        `agent receives an absolute working-directory anchor`,
    );
  }

  // buildGateEvaluatePrompt's per-gate inline subPrompt is a string literal,
  // not a template — it must embed the working directory text directly so
  // each spawned gate evaluator subagent has its own anchor.
  const gateFnStart = src.indexOf("export async function buildGateEvaluatePrompt");
  assert.ok(gateFnStart > 0, "buildGateEvaluatePrompt not found");
  const gateFnEnd = src.indexOf("\nexport ", gateFnStart + 1);
  const gateBody = src.slice(gateFnStart, gateFnEnd > 0 ? gateFnEnd : src.length);
  assert.ok(
    gateBody.includes("**Working directory:**"),
    "buildGateEvaluatePrompt's per-gate subPrompt must embed a " +
      "**Working directory:** line so each subagent anchors to the worktree",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Review/lint/test skills carry a working-directory-awareness directive
// ─────────────────────────────────────────────────────────────────────────────

const SKILLS_REQUIRING_AWARENESS = ["review", "lint", "test"];

for (const skill of SKILLS_REQUIRING_AWARENESS) {
  test(`skills/${skill}/SKILL.md: has working-directory awareness block`, () => {
    const content = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf-8");

    const hasAwarenessBlock =
      content.includes("working_directory_awareness") ||
      content.includes("Working directory check");
    assert.ok(
      hasAwarenessBlock,
      `${skill}/SKILL.md must include a working-directory-awareness directive ` +
        `so bare git commands are anchored to the worktree when cwd is wrong`,
    );

    assert.ok(
      content.includes("git -C") || content.includes("-C <"),
      `${skill}/SKILL.md must instruct agents to use \`git -C <path>\` when ` +
        `pwd doesn't match the dispatch context's working directory`,
    );
  });
}
