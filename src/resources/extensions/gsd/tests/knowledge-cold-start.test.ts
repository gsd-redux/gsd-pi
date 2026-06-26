import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { ExtensionCommandContext, ExtensionContext } from "@gsd/pi-coding-agent";

import { buildBeforeAgentStartResult, _flushDeferredContextMaintenanceForTest } from "../bootstrap/system-context.ts";
import { handleKnowledge } from "../commands-handlers.ts";
import { withCommandCwd } from "../commands/context.ts";
import {
  _getAdapter,
  closeDatabase,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { createMemory } from "../memory-store.ts";
import { invalidateStateCache } from "../state.ts";

test("#830 startup opens the project DB before projecting KNOWLEDGE.md", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-startup-")));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const gsdDir = join(base, ".gsd");
  const knowledgePath = join(gsdDir, "KNOWLEDGE.md");
  mkdirSync(gsdDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");

  t.after(async () => {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
  });

  assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
  const memoryId = createMemory({
    category: "pattern",
    content: "Cold-start projections open the canonical DB first",
    scope: "project",
    confidence: 0.9,
    structuredFields: {
      sourceKnowledgeId: "P001",
      sourceKnowledgeTable: "patterns",
      pattern: "Cold-start projections open the canonical DB first",
      where: "bootstrap",
      notes: "regression coverage",
    },
  });
  assert.ok(memoryId);
  closeDatabase();
  assert.equal(isDbAvailable(), false);
  assert.equal(existsSync(knowledgePath), false);

  const ctx = {
    projectRoot: base,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  await buildBeforeAgentStartResult(
    { prompt: "Inspect project knowledge", systemPrompt: "base system prompt" },
    ctx,
  );

  assert.equal(isDbAvailable(), true, "startup should open the project DB");
  assert.equal(existsSync(knowledgePath), false, "startup should defer KNOWLEDGE.md projection off the prompt path");
  await _flushDeferredContextMaintenanceForTest(base);
  assert.equal(existsSync(knowledgePath), true, "deferred maintenance should write KNOWLEDGE.md");
  assert.match(
    readFileSync(knowledgePath, "utf-8"),
    /\| P001 \| Cold-start projections open the canonical DB first \| bootstrap \| regression coverage \|/,
  );
});

test("#896 startup maintenance skips repeated sentinel work in one session", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-startup-maintenance-once-")));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const gsdDir = join(base, ".gsd");
  const knowledgePath = join(gsdDir, "KNOWLEDGE.md");
  mkdirSync(gsdDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");

  t.after(async () => {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
  });

  writeFileSync(
    knowledgePath,
    [
      "# Project Knowledge",
      "",
      "## Rules",
      "",
      "| # | Scope | Rule | Why | Added |",
      "|---|-------|------|-----|-------|",
      "",
      "## Patterns",
      "",
      "| # | Pattern | Where | Notes |",
      "|---|---------|-------|-------|",
      "| P001 | Run startup maintenance once | bootstrap | first pass |",
      "",
      "## Lessons Learned",
      "",
      "| # | What Happened | Root Cause | Fix | Scope |",
      "|---|--------------|------------|-----|-------|",
      "",
    ].join("\n"),
    "utf-8",
  );

  assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
  closeDatabase();
  assert.equal(isDbAvailable(), false);

  const ctx = {
    projectRoot: base,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;

  await buildBeforeAgentStartResult(
    { prompt: "Inspect project knowledge", systemPrompt: "base system prompt" },
    ctx,
  );
  await _flushDeferredContextMaintenanceForTest(base);

  const adapter = _getAdapter();
  assert.ok(adapter);
  const firstPass = adapter
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE structured_fields LIKE '%\"sourceKnowledgeId\":\"P001\"%'")
    .get() as { count: number };
  assert.equal(firstPass.count, 1, "first startup should backfill existing KNOWLEDGE.md row");

  writeFileSync(
    knowledgePath,
    [
      "# Project Knowledge",
      "",
      "## Rules",
      "",
      "| # | Scope | Rule | Why | Added |",
      "|---|-------|------|-----|-------|",
      "",
      "## Patterns",
      "",
      "| # | Pattern | Where | Notes |",
      "|---|---------|-------|-------|",
      "| P001 | Run startup maintenance once | bootstrap | first pass |",
      "| P002 | Do not re-run startup sentinels | bootstrap | second pass |",
      "",
      "## Lessons Learned",
      "",
      "| # | What Happened | Root Cause | Fix | Scope |",
      "|---|--------------|------------|-----|-------|",
      "",
    ].join("\n"),
    "utf-8",
  );

  await buildBeforeAgentStartResult(
    { prompt: "Inspect project knowledge again", systemPrompt: "base system prompt" },
    ctx,
  );
  await _flushDeferredContextMaintenanceForTest(base);

  const secondPass = adapter
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE structured_fields LIKE '%\"sourceKnowledgeId\":\"P002\"%'")
    .get() as { count: number };
  assert.equal(secondPass.count, 0, "second startup in same session should not re-run KNOWLEDGE.md sentinel backfill");
});

test("#830 knowledge command opens the project DB before capturing patterns", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-knowledge-command-")));
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  t.after(() => {
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });

  assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
  closeDatabase();
  invalidateStateCache();
  assert.equal(isDbAvailable(), false);

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: base,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;

  await withCommandCwd(base, async () => {
    await handleKnowledge("pattern Capture works on a cold session", ctx);
  });

  assert.equal(isDbAvailable(), true, "knowledge command should open the project DB");
  const adapter = _getAdapter();
  assert.ok(adapter);
  const row = adapter
    .prepare(
      "SELECT category, content, structured_fields FROM memories WHERE superseded_by IS NULL ORDER BY seq DESC LIMIT 1",
    )
    .get() as { category: string; content: string; structured_fields: string } | undefined;
  assert.ok(row, "knowledge command should persist a memory");
  assert.equal(row.category, "pattern");
  assert.equal(row.content, "Capture works on a cold session");
  assert.equal(JSON.parse(row.structured_fields).sourceKnowledgeId, "P001");
  assert.deepEqual(notifications.at(-1), {
    message: "Captured pattern P001 to memories; KNOWLEDGE.md will render it on next session start.",
    level: "success",
  });
});
