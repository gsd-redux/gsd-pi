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
  return names;
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
 * isolated, fresh agent home.
 */
export function liveEnv(extra: Record<string, string> = {}): Record<string, string> {
  const claudeCodeEnv: Record<string, string> = {};
  if (isClaudeCodeWorkflowModel() && process.env.HOME) {
    claudeCodeEnv.HOME = process.env.HOME;
  }
  return { ...detectCredentialEnv(), ...claudeCodeEnv, ...extra };
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

/**
 * Seed a deliberately tiny, unambiguous milestone: one slice, one task whose
 * verification is a runnable command. The fixture's test FAILS until the
 * agent does the work, so "did the live agent actually do something" is a
 * durable, prose-free assertion: re-run the verification command afterward.
 *
 * Returns the verification command (argv) the caller asserts on.
 */
export function seedTinyMilestone(project: TmpProject): { verifyArgv: string[] } {
  // Fixture under test: answer() returns the wrong value until the agent fixes it.
  // The `test` script matters: gsd's verification gate independently discovers a
  // host-owned check to run at task completion (package.json scripts are one of
  // its discovery sources). Without a discoverable check the gate fails with
  // "no runnable host-owned verification checks" and auto pauses.
  project.writeFile(
    "package.json",
    JSON.stringify(
      {
        name: "gsd-live-fixture",
        version: "0.0.0",
        private: true,
        scripts: { test: "node --test test/answer.test.js" },
      },
      null,
      2,
    ) + "\n",
  );
  project.writeFile(".gitignore", "node_modules\n");
  project.writeFile("src/answer.js", "function answer() {\n  return 0;\n}\n\nmodule.exports = { answer };\n");
  project.writeFile(
    "test/answer.test.js",
    [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'const { answer } = require("../src/answer.js");',
      "",
      'test("answer returns 42", () => {',
      "  assert.equal(answer(), 42);",
      "});",
      "",
    ].join("\n"),
  );

  // GSD milestone structure (mirrors the layout the fake-LLM headless tests seed).
  const milestoneDir = join(".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");

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
      "- [ ] **S01: Fix answer** `risk:low` `depends:[]`",
      "  > Demo: answer() returns 42 and the test passes.",
      "",
    ].join("\n"),
  );
  project.writeFile(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Fix answer",
      "",
      "**Goal:** Make `answer()` return 42 so the existing test passes.",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Make answer() return 42** `est:2m`",
      "",
      "### T01: Make answer() return 42",
      "",
      "Inputs:",
      "- `src/answer.js`",
      "- `test/answer.test.js`",
      "",
      "Expected Output:",
      "- `src/answer.js` — `answer()` returns `42`",
      "",
      "Verification:",
      "- `node --test test/answer.test.js`",
      "",
    ].join("\n"),
  );

  // Commit the fixture so recover starts from a clean tree.
  git(project.dir, ["add", "-A"]);
  git(project.dir, ["commit", "-m", "test: seed live-workflow answer fixture"]);

  // Rebuild the DB hierarchy from the on-disk markdown so auto can dispatch.
  const recover = gsdSync(["headless", "recover"], {
    cwd: project.dir,
    timeoutMs: 60_000,
    env: liveEnv(),
  });
  if (recover.code !== 0) {
    throw new Error(`headless recover failed (code=${recover.code}):\n${recover.stderrClean.slice(0, 1200)}`);
  }

  // recover rewrites the markdown projection (canonical formatting) and drops
  // the DB / backups, leaving the tree dirty — and gsd's pre-dispatch guard
  // runs `git diff --check`, which reads recover's own trailing whitespace as a
  // "product git conflict" and blocks auto before any agent runs. Commit the
  // recovered state so the tree is clean, exactly as real usage would.
  git(project.dir, ["add", "-A"]);
  git(project.dir, ["commit", "--allow-empty", "-m", "chore: absorb gsd recover state"]);

  return { verifyArgv: ["--test", "test/answer.test.js"] };
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
