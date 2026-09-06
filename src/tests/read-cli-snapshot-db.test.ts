/**
 * `gsd read snapshot` DB-only wiring (#2102).
 *
 * Unlike progress, the snapshot kind has no projection fallback: a present
 * and openable project DB must feed the envelope data through the injectable
 * DB snapshot reader, while a missing DB or a failed read refuses loudly
 * with exit 1 (fail closed — never a degraded payload). The reader is
 * exercised through its injectable seam — the same pattern as the
 * progress/snapshot wiring tests in read-cli-progress-db.test.ts — so these
 * cases pin the wiring and fail-closed decisions, not the snapshot payload
 * itself (pinned by tests/project-snapshot.test.ts in the extension).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runReadCli,
  type DbSnapshotModuleImporter,
  type DbSnapshotReader,
  type ReadCliSchemaPreflight,
} from "../read-cli.ts";
import { closeDatabase, openDatabase } from "../resources/extensions/gsd/gsd-db.ts";
import {
  openWorkflowDatabaseIsolated,
  resolveProjectRootDbPath,
} from "../resources/extensions/gsd/db-workspace.ts";
import { SCHEMA_VERSION, SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";

const realPreflight: ReadCliSchemaPreflight = {
  resolveProjectRootDbPath,
  openIsolatedDatabase: (path) => openWorkflowDatabaseIsolated(path),
  supportedSchemaVersion: SCHEMA_VERSION,
  createSchemaTooNewError: (currentVersion, supportedVersion) =>
    new SchemaTooNewError(currentVersion, supportedVersion),
};

interface CaptureOpts {
  preflight?: ReadCliSchemaPreflight;
  snapshotReader?: DbSnapshotReader;
  moduleImporter?: DbSnapshotModuleImporter;
}

async function captureReadCli(argv: string[], opts: CaptureOpts = {}) {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await runReadCli(
      argv,
      opts.preflight ?? realPreflight,
      undefined,
      undefined,
      opts.snapshotReader,
      opts.moduleImporter,
    );
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function readSnapshotArgv(base: string): string[] {
  return ["node", "gsd", "read", "snapshot", "--json", "--project", base];
}

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-read-cli-snapshot-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# Project State\n\n**Phase:** planning\n",
  );
  return base;
}

function makeSnapshotSentinel(): Record<string, unknown> {
  return {
    authority: { projectId: "proj", schemaVersion: 48, revision: 7, authorityEpoch: 0 },
    current: {
      activeMilestone: { id: "M001", title: "From DB" },
      activeSlice: null,
      activeTask: null,
      phase: "execute",
      nextAction: "Keep going",
    },
    progress: {
      milestones: { total: 1, done: 0, active: 1, pending: 0, parked: 0 },
      slices: { total: 0, done: 0, active: 0, pending: 0 },
      tasks: { total: 0, done: 0, pending: 0 },
    },
    blockers: [],
    openQuestions: [],
    verification: {
      assessments: { total: 0, pass: 0, fail: 0 },
      evidence: { total: 0, passed: 0, failed: 0 },
    },
    milestones: { items: [], truncated: false },
    capturedAt: "2026-09-05T00:00:00.000Z",
  };
}

test("gsd read snapshot serves the DB-backed envelope with the pinned snapshot key set when the DB is present", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const sentinel = makeSnapshotSentinel();
  let calls = 0;
  const run = await captureReadCli(readSnapshotArgv(base), {
    snapshotReader: async (projectDir) => {
      calls++;
      assert.equal(projectDir, base);
      return sentinel;
    },
  });

  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.integration_version, 1);
  assert.equal(envelope.kind, "snapshot");
  assert.equal(envelope.projectDir, base);
  assert.deepEqual(Object.keys(envelope.data).sort(), [
    "authority",
    "blockers",
    "capturedAt",
    "current",
    "milestones",
    "openQuestions",
    "progress",
    "verification",
  ]);
  assert.deepEqual(envelope.data, sentinel);
  assert.equal(calls, 1);
});

test("gsd read snapshot uses the project DB from a canonical milestone worktree", async (t) => {
  const base = makeProject();
  const worktree = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".gsd", "STATE.md"), "# Project State\n\n**Phase:** planning\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readSnapshotArgv(worktree), {
    snapshotReader: async (projectDir) => {
      assert.equal(projectDir, worktree);
      return makeSnapshotSentinel();
    },
  });

  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.kind, "snapshot");
  assert.equal(envelope.data.authority.projectId, "proj");
});

test("gsd read snapshot refuses loudly when the DB-backed read fails", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readSnapshotArgv(base), {
    snapshotReader: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.ok(
    run.stderr.includes("DB-backed snapshot read failed"),
    `stderr should explain the failure, got: ${run.stderr}`,
  );
  assert.ok(run.stderr.includes("boom"), `stderr should carry the cause, got: ${run.stderr}`);
});

test("gsd read snapshot refuses loudly when no DB exists (fail closed, no fallback)", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  let calls = 0;
  const run = await captureReadCli(readSnapshotArgv(base), {
    snapshotReader: async () => {
      calls++;
      return makeSnapshotSentinel();
    },
  });

  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.ok(
    run.stderr.includes("snapshot requires a GSD database"),
    `stderr should explain the missing DB, got: ${run.stderr}`,
  );
  assert.equal(calls, 0, "reader must not be invoked when the DB file is absent");
});

test("gsd read snapshot explains how to repair a stale extension bundle", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readSnapshotArgv(base), {
    moduleImporter: async () => {
      throw new Error("Cannot find module state/project-snapshot.ts");
    },
  });

  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /synchronize the extension bundle/);
});
