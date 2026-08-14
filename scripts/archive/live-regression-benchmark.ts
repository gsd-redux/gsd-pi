/**
 * Quick-Command Resolution Benchmark — Headless Idle-Completion Path
 *
 * Guards the fix for the spurious-exit-11 regression on quick commands
 * (`/gsd status`, `history`, `help`, `config`). These commands are handled
 * entirely in the GSD extension layer and never enter the LLM agent loop,
 * so they emit no `execution_complete` / `agent_end` and make zero tool
 * calls. Completion is therefore detected by the headless idle timer
 * (`IDLE_TIMEOUT_MS = 15_000`), which `shouldArmHeadlessIdleTimeout` only
 * arms for quick commands after the fix.
 *
 * Before the fix: the idle timer never armed → the completion promise never
 * resolved → the event loop drained → the process exited with a spurious
 * code 11 ("cancelled") at ~2s, indistinguishable from a real SIGINT.
 *
 * This benchmark measures wall-clock resolution time for each quick command
 * and asserts BOTH:
 *   1. exit 0 (correctness — not the spurious cancelled-11), AND
 *   2. resolution under RESOLUTION_BUDGET_MS (proves the idle timer fired
 *      and the run did not hang past the overall timeout). The budget is
 *      set well above `IDLE_TIMEOUT_MS + cold-start` to stay non-flaky on
 *      slow CI, and well below the default 300s overall headless timeout
 *      so a genuine hang (idle timer fails to arm again) fails this gate.
 *
 * Run:
 *   GSD_SMOKE_BINARY="$(pwd)/dist/loader.js" \
 *     node --experimental-strip-types scripts/archive/live-regression-benchmark.ts
 */
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const binary = process.env.GSD_SMOKE_BINARY;
if (!binary) {
  console.error("benchmark: GSD_SMOKE_BINARY required (absolute path to dist/loader.js)");
  process.exit(2);
}

// IDLE_TIMEOUT_MS is 15s; cold start + extension sync adds a few seconds.
// 45s is ~3x the observed resolution (~18s on a warm macOS arm64 host),
// leaving ample headroom for slow CI runners while still catching a real
// hang (the default overall headless timeout is 300s).
const RESOLUTION_BUDGET_MS = 45_000;
// The old spurious-11 bug exited at ~2s with the WRONG code. A correct run
// must take meaningfully longer than that because completion is gated on
// the 15s idle timer. Anything resolving in well under IDLE_TIMEOUT_MS with
// exit 0 would indicate the idle path was bypassed. We don't assert a hard
// lower bound (startup variance), but we record min for the report.
const IDLE_TIMEOUT_MS = 15_000;

const gitInit = (dir: string) => {
  const run = (args: string[]) => {
    try { execFileSync("git", args, { cwd: dir, stdio: "pipe" }); } catch { /* best-effort */ }
  };
  run(["init"]);
  run(["config", "user.email", "test@test.com"]);
  run(["config", "user.name", "Test"]);
  run(["commit", "--allow-empty", "-m", "init"]);
};

function gsd(args: string[], cwd: string): { ms: number; code: number; stderr: string } {
  const t0 = Date.now();
  const res = spawnSync("node", [binary as string, ...args], {
    cwd, encoding: "utf-8", timeout: 90_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GSD_NON_INTERACTIVE: "1" },
  });
  const ms = Date.now() - t0;
  return { ms, code: res.status ?? -1, stderr: res.stderr || "" };
}

function buildMinimalRoadmap(slices: Array<{ id: string; title: string; done: boolean }>): string {
  const lines = ["# M001: Test Milestone", "", "## Slices", ""];
  for (const s of slices) {
    const cb = s.done ? "x" : " ";
    lines.push(`- [${cb}] **${s.id}: ${s.title}** \`risk:low\` \`depends:[]\``);
    lines.push(`  > Demo for ${s.id}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildMinimalPlan(tasks: Array<{ id: string; title: string; done: boolean }>): string {
  const lines = ["# S01: Test Slice", "", "**Goal:** test", "", "## Tasks", ""];
  for (const t of tasks) {
    const cb = t.done ? "x" : " ";
    lines.push(`- [${cb}] **${t.id}: ${t.title}** \`est:5m\``);
  }
  return lines.join("\n");
}

function seedProject(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gsd-bench-${name}-`));
  gitInit(dir);
  const mDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(join(mDir, "slices", "S01"), { recursive: true });
  writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
  writeFileSync(
    join(mDir, "M001-ROADMAP.md"),
    buildMinimalRoadmap([{ id: "S01", title: "First Slice", done: false }]),
  );
  writeFileSync(
    join(mDir, "slices", "S01", "S01-PLAN.md"),
    buildMinimalPlan([{ id: "T01", title: "Task One", done: false }]),
  );
  const recover = gsd(["headless", "recover"], dir);
  if (recover.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`benchmark seed recover failed (exit ${recover.code}): ${recover.stderr.slice(0, 200)}`);
  }
  return dir;
}

// ─── Benchmark runner ────────────────────────────────────────────────────

interface Sample { cmd: string; ms: number; code: number; stderr: string }
const samples: Sample[] = [];
let failures = 0;

function bench(label: string, cmd: string): void {
  const dir = seedProject(`bench-${cmd}`);
  try {
    const result = gsd(["headless", cmd], dir);
    samples.push({ cmd, ms: result.ms, code: result.code, stderr: result.stderr });

    // 1. Correctness: must exit 0, never the spurious 11.
    if (result.code !== 0) {
      failures++;
      console.error(`  FAIL  ${label}: expected exit 0, got ${result.code} in ${result.ms}ms`);
      console.error(`        stderr: ${result.stderr.slice(0, 300)}`);
      return;
    }

    // 2. Resolution budget: must resolve well under a true hang. A run that
    //    exceeds the budget indicates the idle timer failed to fire (the
    //    regression) and the process is drifting toward the overall timeout.
    if (result.ms > RESOLUTION_BUDGET_MS) {
      failures++;
      console.error(`  FAIL  ${label}: resolved in ${result.ms}ms, over ${RESOLUTION_BUDGET_MS}ms budget (idle timer did not fire)`);
      return;
    }

    // Report. Resolution ≈ IDLE_TIMEOUT_MS + startup confirms the idle path
    // (not the old ~2s spurious-11 drain) drove completion.
    const ratio = (result.ms / IDLE_TIMEOUT_MS).toFixed(2);
    console.log(`  OK    ${label}: ${result.ms}ms (exit 0, ${ratio}× IDLE_TIMEOUT, budget ${RESOLUTION_BUDGET_MS}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`Quick-command resolution benchmark (budget ${RESOLUTION_BUDGET_MS}ms, idle ${IDLE_TIMEOUT_MS}ms)`);
console.log("");
bench("headless status resolves via idle timer", "status");
bench("headless history resolves via idle timer", "history");
bench("headless help resolves via idle timer", "help");
bench("headless config resolves via idle timer", "config");

// ─── Summary ─────────────────────────────────────────────────────────────

console.log("");
if (samples.length > 0) {
  const min = Math.min(...samples.map((s) => s.ms));
  const max = Math.max(...samples.map((s) => s.ms));
  const avg = Math.round(samples.reduce((a, s) => a + s.ms, 0) / samples.length);
  console.log(`Benchmark summary: ${samples.length} commands, min=${min}ms avg=${avg}ms max=${max}ms`);
}
console.log(`Quick-command benchmark: ${samples.length - failures} ok, ${failures} failed`);
if (failures > 0) process.exit(1);
