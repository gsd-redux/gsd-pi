import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const baselinePath = join(process.cwd(), "scripts/workflow-authority-baseline.mjs");
const baseline = await import(pathToFileURL(baselinePath).href);

test("workflow authority baseline reports four fixed invariants in stable order", () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  let now = 0;
  const report = baseline.runWorkflowAuthorityBaseline({
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

test("workflow authority baseline controlled sabotage exits nonzero", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-authority-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const failingTest = join(root, "controlled-sabotage.test.mjs");
  writeFileSync(
    failingTest,
    'import test from "node:test"; import assert from "node:assert/strict"; test("controlled sabotage", () => assert.fail("invariant sabotage"));\n',
  );

  const report = baseline.runWorkflowAuthorityBaseline({
    invariants: [{ id: "controlled-sabotage", name: "Controlled sabotage", file: failingTest }],
  });

  assert.equal(report.verdict, "fail");
  assert.equal(report.invariants[0].exitCode, 1);
  assert.equal(baseline.exitCodeForReport(report), 1);
});

test("workflow authority baseline CLI emits the v1 JSON report", { timeout: 60_000 }, () => {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawnSync(pnpm, ["--silent", "run", "baseline:workflow-authority", "--", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 55_000,
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
