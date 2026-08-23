/**
 * Live-workflow harness helpers.
 *
 * Credentials come from the ENVIRONMENT only. The harness forwards any
 * provider key/token it finds (`*_API_KEY`, `*_OAUTH_TOKEN`) into the spawned
 * child and never touches your real ~/.gsd — the child keeps the e2e harness's
 * isolated, fresh agent home, so nothing leaks into your config and the test
 * runs the same way locally and in CI. This is provider-agnostic: it never
 * names a vendor; whatever key you export is what the agent authenticates with.
 *
 * Opt-in exception: GSD_LIVE_WORKFLOW_USE_HOME=1 forwards the real HOME so the
 * child reads the operator's ~/.gsd/agent/auth.json (and prefs) exactly like
 * a user would. Use it on a machine whose credentials live in auth.json
 * rather than in env vars.
 *
 * Model selection is left to gsd's resolver: with no `--model`, a fresh home
 * auto-picks the default model for whichever provider has a valid credential
 * present (see packages/pi-coding-agent/src/core/model-resolver.ts). Set
 * GSD_LIVE_WORKFLOW_MODEL=<id> to force a specific model. Project state lives
 * in the isolated tmp cwd.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { gsdAsync, gsdSync, stripAnsi, type SpawnSyncResult, type TmpProject } from "../e2e/_shared/index.ts";

const CRED_RE = /_API_KEY$|_OAUTH_TOKEN$/;
const USE_HOME_ENV = "GSD_LIVE_WORKFLOW_USE_HOME";
const CLAUDE_CODE_PROVIDER = "claude-code";
const CLAUDE_CODE_CLI_ALIAS = "claude-code-cli";

export function normalizeLiveWorkflowModel(model = process.env.GSD_LIVE_WORKFLOW_MODEL): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (lower === CLAUDE_CODE_CLI_ALIAS) return CLAUDE_CODE_PROVIDER;
  if (lower.startsWith(`${CLAUDE_CODE_CLI_ALIAS}/`)) {
    return `${CLAUDE_CODE_PROVIDER}/${trimmed.slice(CLAUDE_CODE_CLI_ALIAS.length + 1)}`;
  }

  return trimmed;
}

export function isClaudeCodeWorkflowModel(model = process.env.GSD_LIVE_WORKFLOW_MODEL): boolean {
  const normalized = normalizeLiveWorkflowModel(model)?.toLowerCase();
  if (!normalized) return false;
  return normalized === CLAUDE_CODE_PROVIDER || normalized.startsWith(`${CLAUDE_CODE_PROVIDER}/`);
}

function isClaudeCodeCliAuthenticated(): boolean {
  try {
    const raw = execFileSync("claude", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

/** Provider credential env vars present in the current environment. */
export function detectCredentialEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v && CRED_RE.test(k)) out[k] = v;
  }
  return out;
}

/** Names of the credential env vars found (for diagnostics/skip messages). */
export function credentialNames(): string[] {
  const names = Object.keys(detectCredentialEnv()).sort();
  if (isClaudeCodeWorkflowModel() && isClaudeCodeCliAuthenticated()) {
    names.push("CLAUDE_CODE_CLI");
  }
  if (usesOperatorHome()) names.push(USE_HOME_ENV);
  return names;
}

/** True when the operator opted in to forwarding the real HOME (auth.json). */
export function usesOperatorHome(): boolean {
  return process.env[USE_HOME_ENV] === "1";
}

/**
 * True when at least one provider credential is present in the environment.
 * Used to skip (exit 77) rather than fail when nothing is exported.
 */
export function hasUsableCredentials(): boolean {
  return credentialNames().length > 0;
}

/**
 * Env overrides for a live `gsd` child: forward provider credentials from the
 * current environment. buildE2eEnv() in gsdSync already forwards non-GSD_ vars,
 * but we re-pass them explicitly so credential delivery is self-documenting and
 * resilient to future harness changes. No GSD_HOME bridge — the child uses its
 * isolated, fresh agent home — unless GSD_LIVE_WORKFLOW_USE_HOME=1 (or a
 * Claude Code CLI model) asks for the operator's real HOME.
 */
export function liveEnv(extra: Record<string, string> = {}): Record<string, string> {
  const homeEnv: Record<string, string> = {};
  if ((isClaudeCodeWorkflowModel() || usesOperatorHome()) && process.env.HOME) {
    homeEnv.HOME = process.env.HOME;
  }
  return { ...detectCredentialEnv(), ...homeEnv, ...extra };
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

/**
 * `gsd headless recover` is two-step: the first call prints an import preview
 * (`re-run with --preview=sha256:<hash>`) and exits non-zero; the second call
 * with that hash applies it. Same dance as tests/acceptance-bed.
 */
function recoverWithApproval(dir: string): void {
  const preview = gsdSync(["headless", "recover"], { cwd: dir, timeoutMs: 60_000, env: liveEnv() });
  const previewHash = /re-run with --preview=(sha256:[0-9a-f]{64})/u.exec(preview.stderrClean)?.[1];
  if (!previewHash) {
    throw new Error(
      `headless recover printed no preview hash (code=${preview.code}):\n${preview.stderrClean.slice(0, 1200)}`,
    );
  }
  const approved = gsdSync(["headless", "recover", `--preview=${previewHash}`], {
    cwd: dir,
    timeoutMs: 60_000,
    env: liveEnv(),
  });
  if (approved.code !== 0) {
    throw new Error(`headless recover approval failed (code=${approved.code}):\n${approved.stderrClean.slice(0, 1200)}`);
  }
}

/** One task of a seeded fixture: a source file the agent must write/fix and a node:test file that fails until it does. */
export interface FixtureTask {
  id: string;
  title: string;
  /** Source file the task produces. */
  file: string;
  /** Initial (wrong) content; omit to leave the file absent until the agent creates it. */
  stub?: string;
  /** Exact expected behaviour, quoted in the plan as the task's Expected Output. */
  expected: string;
  testFile: string;
  testSource: string;
  /** Verification command argv (after `node`). */
  verifyArgv: string[];
}

export interface FixtureSlice {
  id: string;
  title: string;
  depends: string[];
  demo: string;
  tasks: FixtureTask[];
}

function nodeTest(source: string, name: string, body: string): string {
  return [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    `const ${source}`,
    "",
    `test(${JSON.stringify(name)}, () => {`,
    `  ${body}`,
    "});",
    "",
  ].join("\n");
}

const ANSWER_TASK: FixtureTask = {
  id: "T01",
  title: "Make answer() return 42",
  file: "src/answer.js",
  stub: "function answer() {\n  return 0;\n}\n\nmodule.exports = { answer };\n",
  expected: "`answer()` returns `42`",
  testFile: "test/answer.test.js",
  testSource: nodeTest('{ answer } = require("../src/answer.js");', "answer returns 42", "assert.equal(answer(), 42);"),
  verifyArgv: ["--test", "test/answer.test.js"],
};

/** One slice, one task — the cheapest real dispatch. */
const TINY_SLICES: FixtureSlice[] = [
  { id: "S01", title: "Fix answer", depends: [], demo: "answer() returns 42 and the test passes.", tasks: [ANSWER_TASK] },
];

/** Three dependent slices, five tasks — enough to exercise slice progression and closeout. */
const MULTI_SLICES: FixtureSlice[] = [
  {
    id: "S01",
    title: "Answer and double",
    depends: [],
    demo: "answer() returns 42 and double(n) returns 2n; both tests pass.",
    tasks: [
      ANSWER_TASK,
      {
        id: "T02",
        title: "Add double(n)",
        file: "src/double.js",
        expected: "`double(n)` returns `n * 2`, exported as `module.exports = { double }`",
        testFile: "test/double.test.js",
        testSource: nodeTest('{ double } = require("../src/double.js");', "double doubles", "assert.equal(double(21), 42);"),
        verifyArgv: ["--test", "test/double.test.js"],
      },
    ],
  },
  {
    id: "S02",
    title: "Sum and format",
    depends: ["S01"],
    demo: "sum(a, b) adds and formatAnswer() renders \"answer: 42\" using answer() and sum().",
    tasks: [
      {
        id: "T01",
        title: "Add sum(a, b)",
        file: "src/sum.js",
        expected: "`sum(a, b)` returns `a + b`, exported as `module.exports = { sum }`",
        testFile: "test/sum.test.js",
        testSource: nodeTest('{ sum } = require("../src/sum.js");', "sum adds", "assert.equal(sum(40, 2), 42);"),
        verifyArgv: ["--test", "test/sum.test.js"],
      },
      {
        id: "T02",
        title: "Add formatAnswer()",
        file: "src/format.js",
        expected:
          '`formatAnswer()` returns the string `"answer: 42"` built from `answer()` (src/answer.js) and `sum()` (src/sum.js), exported as `module.exports = { formatAnswer }`',
        testFile: "test/format.test.js",
        testSource: nodeTest(
          '{ formatAnswer } = require("../src/format.js");',
          "formatAnswer renders the answer",
          'assert.equal(formatAnswer(), "answer: 42");',
        ),
        verifyArgv: ["--test", "test/format.test.js"],
      },
    ],
  },
  {
    id: "S03",
    title: "Public index",
    depends: ["S02"],
    demo: "src/index.js re-exports answer, double, sum and formatAnswer; the whole suite passes.",
    tasks: [
      {
        id: "T01",
        title: "Add src/index.js exporting all four functions",
        file: "src/index.js",
        expected: "`src/index.js` exports `{ answer, double, sum, formatAnswer }` from the four modules",
        testFile: "test/index.test.js",
        testSource: nodeTest(
          'api = require("../src/index.js");',
          "index exports all four functions",
          'assert.deepEqual(Object.keys(api).sort(), ["answer", "double", "formatAnswer", "sum"]);\n  assert.equal(api.formatAnswer(), "answer: 42");',
        ),
        verifyArgv: ["--test"],
      },
    ],
  },
];

function planMarkdown(slice: FixtureSlice): string {
  const lines = [`# ${slice.id}: ${slice.title}`, "", `**Goal:** ${slice.demo}`, "", "## Tasks", ""];
  for (const task of slice.tasks) lines.push(`- [ ] **${task.id}: ${task.title}** \`est:2m\``);
  for (const task of slice.tasks) {
    lines.push(
      "",
      `### ${task.id}: ${task.title}`,
      "",
      "Inputs:",
      `- \`${task.file}\``,
      `- \`${task.testFile}\``,
      "",
      "Expected Output:",
      `- \`${task.file}\` — ${task.expected}`,
      "",
      "Verification:",
      `- \`node ${task.verifyArgv.join(" ")}\``,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the fixture + GSD milestone markdown, commit, run the two-step recover
 * and commit again so the tree is clean for auto's pre-dispatch guard.
 *
 * The package.json `test` script matters: gsd's verification gate independently
 * discovers a host-owned check to run at task completion (package.json scripts
 * are one of its discovery sources). Without a discoverable check the gate
 * fails with "no runnable host-owned verification checks" and auto pauses.
 *
 * Every fixture test FAILS until the agent does the work, so "did the live
 * agent actually do something" is a durable, prose-free assertion: re-run the
 * verification commands afterward.
 */
function seedMilestone(project: TmpProject, slices: FixtureSlice[], testScript: string): void {
  project.writeFile(
    "package.json",
    JSON.stringify({ name: "gsd-live-fixture", version: "0.0.0", private: true, scripts: { test: testScript } }, null, 2) +
      "\n",
  );
  project.writeFile(".gitignore", "node_modules\n");
  for (const task of slices.flatMap((s) => s.tasks)) {
    if (task.stub !== undefined) project.writeFile(task.file, task.stub);
    project.writeFile(task.testFile, task.testSource);
  }

  // GSD milestone structure (mirrors the layout the fake-LLM headless tests seed).
  const milestoneDir = join(".gsd", "milestones", "M001");
  project.writeFile(
    join(milestoneDir, "M001-CONTEXT.md"),
    ["# M001: Answer Fixture", "", "## Purpose", "Live end-to-end smoke of the auto-orchestration loop.", ""].join("\n"),
  );
  project.writeFile(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Answer Fixture",
      "",
      "## Slices",
      "",
      ...slices.flatMap((s) => [
        `- [ ] **${s.id}: ${s.title}** \`risk:low\` \`depends:[${s.depends.join(",")}]\``,
        `  > Demo: ${s.demo}`,
        "",
      ]),
    ].join("\n"),
  );
  for (const slice of slices) {
    project.writeFile(join(milestoneDir, "slices", slice.id, `${slice.id}-PLAN.md`), planMarkdown(slice));
  }

  // Commit the fixture so recover starts from a clean tree.
  git(project.dir, ["add", "-A"]);
  git(project.dir, ["commit", "-m", "test: seed live-workflow answer fixture"]);

  // Rebuild the DB hierarchy from the on-disk markdown so auto can dispatch.
  recoverWithApproval(project.dir);

  // recover rewrites the markdown projection (canonical formatting) and drops
  // the DB / backups, leaving the tree dirty — and gsd's pre-dispatch guard
  // runs `git diff --check`, which reads recover's own trailing whitespace as a
  // "product git conflict" and blocks auto before any agent runs. Commit the
  // recovered state so the tree is clean, exactly as real usage would.
  git(project.dir, ["add", "-A"]);
  git(project.dir, ["commit", "--allow-empty", "-m", "chore: absorb gsd recover state"]);
}

/**
 * Seed a deliberately tiny, unambiguous milestone: one slice, one task whose
 * verification is a runnable command. Returns the verification argv the
 * caller asserts on.
 */
export function seedTinyMilestone(project: TmpProject): { verifyArgv: string[] } {
  seedMilestone(project, TINY_SLICES, "node --test test/answer.test.js");
  return { verifyArgv: ANSWER_TASK.verifyArgv };
}

/**
 * Seed a three-slice milestone (S01 → S02 → S03, five tasks) so a full `auto`
 * run must progress through dependent slices before closeout. Returns the
 * seeded slices (for per-task verification and ordering assertions) and the
 * whole-suite verification argv.
 */
export function seedMultiSliceMilestone(project: TmpProject): { verifyArgv: string[]; slices: FixtureSlice[] } {
  seedMilestone(project, MULTI_SLICES, "node --test");
  return { verifyArgv: ["--test"], slices: MULTI_SLICES };
}

/** Run the seeded task's verification command in the project dir. */
export function runVerification(project: TmpProject, verifyArgv: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync(process.execPath, verifyArgv, {
      cwd: project.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { ok: true, output: out };
  } catch (err: any) {
    return { ok: false, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

/**
 * Run a long `gsd` command and TEE its stdout/stderr to this process's
 * terminal in real time, while still capturing everything for assertions and
 * artifacts. Unlike gsdSync (which buffers and only returns at the end), this
 * lets you watch the agent work live. Enforces `timeoutMs` by killing the
 * child (SIGTERM → SIGKILL); a killed run reports `timedOut: true`.
 *
 * Returns the same shape as gsdSync so callers can swap them freely.
 */
export async function runStreaming(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<SpawnSyncResult> {
  const child = gsdAsync(argv, { cwd: opts.cwd, env: opts.env });
  let lastOutputAt = Date.now();
  const onData = (stream: NodeJS.WriteStream) => (chunk: string) => {
    lastOutputAt = Date.now();
    stream.write(chunk);
  };
  child.child.stdout?.on("data", onData(process.stdout));
  child.child.stderr?.on("data", onData(process.stderr));

  // Heartbeat: surface silence so a hang is distinguishable from slow work.
  const heartbeat = setInterval(() => {
    const idleMs = Date.now() - lastOutputAt;
    if (idleMs >= 25_000) {
      process.stderr.write(`\n  ⏳ still running — no output for ${Math.round(idleMs / 1000)}s\n`);
    }
  }, 15_000);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stderr.write(`\n  ⛔ wall-clock budget (${Math.round(opts.timeoutMs / 1000)}s) exceeded — killing gsd\n`);
    void child.kill();
  }, opts.timeoutMs);

  const { code, signal } = await child.done();
  clearTimeout(timer);
  clearInterval(heartbeat);

  const stdout = child.stdout();
  const stderr = child.stderr();
  return {
    stdout,
    stderr,
    stdoutClean: stripAnsi(stdout),
    stderrClean: stripAnsi(stderr),
    code,
    signal,
    timedOut,
  };
}

export type { SpawnSyncResult };
