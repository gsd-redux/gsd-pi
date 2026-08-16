import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoSession } from "../auto-runtime-state.js";
import { registerHooks } from "../bootstrap/register-hooks.js";
import { shouldBlockWorktreeBash, shouldBlockWorktreeWrite } from "../bootstrap/write-gate.js";
import { invalidateAllCaches } from "../cache.js";

function makeWorktreeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "wt-write-gate-degraded-"));
  mkdirSync(join(root, ".gsd"), { recursive: true });
  writeFileSync(
    join(root, ".gsd", "PREFERENCES.md"),
    '---\ngit:\n  isolation: "worktree"\n---\n',
  );
  invalidateAllCaches();
  return root;
}

test("degraded branch-mode fallback permits project-root file writes", (t) => {
  const projectRoot = makeWorktreeProject();
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    invalidateAllCaches();
  });

  const result = shouldBlockWorktreeWrite(
    "write",
    join(projectRoot, "src", "app.ts"),
    projectRoot,
    true,
    "execute-task",
    "branch",
  );

  assert.equal(result.block, false);
});

test("live tool-call hook honors degraded branch-mode fallback", async (t) => {
  const projectRoot = makeWorktreeProject();
  const originalCwd = process.cwd();
  process.chdir(projectRoot);
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = projectRoot;
  autoSession.isolationDegraded = true;
  autoSession.setCurrentUnit({
    type: "execute-task",
    id: "M001/S01/T1",
    startedAt: Date.now(),
    workspaceRoot: projectRoot,
  });
  t.after(() => {
    autoSession.reset();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
    invalidateAllCaches();
  });

  const handlers = new Map<string, Array<(event: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any) => Promise<any> | any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as any;
  registerHooks(pi, []);

  const blocks = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolCallId: "degraded-write-1",
      toolName: "write",
      input: { path: join(projectRoot, "src", "app.ts"), content: "export {};\n" },
    });
    if (result?.block) blocks.push(result.reason ?? "unknown block");
  }

  assert.deepEqual(blocks, []);
});

test("degraded branch-mode fallback permits project-root shell commands", (t) => {
  const projectRoot = makeWorktreeProject();
  const worktreeRoot = join(projectRoot, ".gsd-worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    invalidateAllCaches();
  });

  const result = shouldBlockWorktreeBash(
    `cd ${projectRoot} && pnpm test`,
    worktreeRoot,
    true,
    "execute-task",
    "branch",
  );

  assert.equal(result.block, false);
});
