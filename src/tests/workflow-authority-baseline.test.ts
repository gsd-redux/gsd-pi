import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const baselinePath = join(process.cwd(), "scripts/workflow-authority-baseline.mjs");
const baseline = await import(pathToFileURL(baselinePath).href);
const BASELINE_SPAWN_TIMEOUT_MS = 255_000;
const BASELINE_TEST_TIMEOUT_MS = 270_000;

test("workflow authority baseline reports four fixed invariants in stable order", () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let now = 0;
  const report = baseline.runWorkflowAuthorityBaseline({
    invariants: [{ id: "override", name: "Override", file: "override.test.ts" }],
    now: () => now += 5,
    spawnSyncImpl: (executable: string, args: string[]) => {
      calls.push({ executable, args });
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "pass");
  const expected = [
    ["db-authority-fixture", "workflow-authority-fixture.test.ts"],
    ["projection-conflict", "workflow-authority-projection-conflict.test.ts"],
    ["fault-harness-contract", "workflow-fault-harness.test.ts"],
    ["fault-boundary-matrix", "workflow-authority-faults.test.ts"],
  ].map(([id, filename]) => {
    const file = `src/resources/extensions/gsd/tests/${filename}`;
    const reportedArgs = [
      "--import",
      "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
      "--experimental-strip-types",
      "--test",
      file,
    ];
    return {
      id,
      executable: process.execPath,
      args: [
        "--import",
        join(baseline.REPO_ROOT, "src/resources/extensions/gsd/tests/resolve-ts.mjs"),
        "--experimental-strip-types",
        "--test",
        join(baseline.REPO_ROOT, file),
      ],
      command: ["node", ...reportedArgs].map((part) => JSON.stringify(part)).join(" "),
    };
  });

  assert.deepEqual(
    report.invariants.map((entry: { id: string; command: string }, index: number) => ({
      id: entry.id,
      executable: calls[index].executable,
      args: calls[index].args,
      command: entry.command,
    })),
    expected,
    "each accepted invariant must retain its exact ID, execution path, and reported command",
  );
  assert.equal(baseline.exitCodeForReport(report), 0);
});

test("workflow authority baseline preserves the first failing child status", () => {
  let call = 0;
  const report = baseline.runWorkflowAuthorityBaseline({
    now: () => 0,
    spawnSyncImpl: () => {
      call += 1;
      return { status: call === 2 ? 7 : 0, signal: null, stdout: "", stderr: "failed" };
    },
  });

  assert.equal(report.verdict, "fail");
  assert.equal(report.invariants[1].exitCode, 7);
  assert.equal(report.invariants[1].verdict, "fail");
  assert.equal(baseline.exitCodeForReport(report), 7);
  assert.match(baseline.renderWorkflowAuthoritySummary(report), /projection-conflict.*FAIL.*node/s);
});

test(
  "workflow authority baseline controlled sabotage exits nonzero",
  { timeout: BASELINE_TEST_TIMEOUT_MS },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "workflow-authority-baseline-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const sabotageModule = join(root, "controlled-sabotage.mjs");
    writeFileSync(
      sabotageModule,
      `if (process.argv.some((arg) => arg.endsWith("workflow-authority-projection-conflict.test.ts"))) {
  process.exit(7);
}
`,
    );

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(sabotageModule).href}`,
    ]
      .filter(Boolean)
      .join(" ");
    const child = spawnSync(
      pnpm,
      ["--silent", "run", "baseline:workflow-authority", "--", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
        timeout: BASELINE_SPAWN_TIMEOUT_MS,
      },
    );

    assert.equal(child.status, 1, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.verdict, "fail");
    assert.deepEqual(
      report.invariants.map((invariant: { id: string }) => invariant.id),
      baseline.WORKFLOW_AUTHORITY_INVARIANTS.map(
        (invariant: { id: string }) => invariant.id,
      ),
    );
    assert.equal(report.invariants[1].exitCode, 1);
    assert.equal(report.invariants[1].verdict, "fail");
    assert.equal(
      report.invariants.filter(
        (invariant: { verdict: string }) => invariant.verdict === "pass",
      ).length,
      3,
    );
  },
);

test("workflow authority baseline CLI emits the v1 JSON report", {
  timeout: BASELINE_TEST_TIMEOUT_MS,
}, () => {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawnSync(pnpm, ["--silent", "run", "baseline:workflow-authority", "--", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: BASELINE_SPAWN_TIMEOUT_MS,
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(report), ["schemaVersion", "verdict", "durationMs", "invariants"]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "pass");
  assert.equal(report.invariants.length, 4);
  for (const invariant of report.invariants) {
    assert.deepEqual(
      Object.keys(invariant),
      ["id", "name", "command", "verdict", "exitCode", "durationMs", "signal", "error"],
    );
  }
});
