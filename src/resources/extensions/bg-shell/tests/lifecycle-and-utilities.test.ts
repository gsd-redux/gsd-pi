import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BgProcess } from "../types.ts";
import { detectProcessType } from "../process-manager.ts";
import { waitForReady } from "../readiness-detector.ts";
import {
  formatTimeAgo,
  getBgShellLiveCwd,
  resolveBgShellPersistenceCwd,
} from "../utilities.ts";

function makeBg(overrides: Partial<BgProcess> = {}): BgProcess {
  return {
    id: "bg-1",
    label: "test",
    command: "npm test",
    cwd: "/tmp",
    ownerSessionFile: null,
    persistAcrossSessions: false,
    startedAt: Date.now() - 1000,
    proc: {} as BgProcess["proc"],
    output: [],
    exitCode: null,
    signal: null,
    alive: true,
    lastReadIndex: 0,
    processType: "server",
    status: "starting",
    ports: [],
    urls: [],
    recentErrors: [],
    recentWarnings: [],
    events: [],
    lastErrorCount: 0,
    lastWarningCount: 0,
    readyPattern: null,
    readyPort: null,
    wasReady: false,
    group: null,
    stdoutLineCount: 0,
    stderrLineCount: 0,
    restartCount: 0,
    startConfig: {
      command: "npm test",
      cwd: "/tmp",
      label: "test",
      processType: "server",
      ownerSessionFile: null,
      persistAcrossSessions: false,
      readyPattern: null,
      readyPort: null,
      group: null,
    },
    ...overrides,
  };
}

describe("bg-shell detectProcessType", () => {
  const cases: Array<[string, BgProcess["processType"]]> = [
    ["npm run dev", "server"],
    ["pnpm next start", "server"],
    ["uvicorn main:app", "server"],
    ["http-server ./public", "server"],
    ["pnpm build", "build"],
    ["tsc --noEmit", "build"],
    ["tsc --watch", "watcher"],
    ["webpack --watch", "watcher"],
    ["npm test", "test"],
    ["vitest run", "test"],
    ["pytest tests/", "test"],
    ["nodemon app.js", "watcher"],
    ["fswatch src", "watcher"],
    ["cat file.txt", "generic"],
    ["echo hello", "generic"],
  ];

  for (const [command, expected] of cases) {
    test(`classifies "${command}" as ${expected}`, () => {
      assert.equal(detectProcessType(command), expected);
    });
  }

  test("classification is case-insensitive", () => {
    assert.equal(detectProcessType("NPM RUN DEV"), "server");
  });
});

describe("bg-shell waitForReady", () => {
  test("resolves ready immediately when status is already ready", async () => {
    const bg = makeBg({
      status: "ready",
      events: [{ type: "ready", timestamp: Date.now(), detail: "listening on 3000" }],
    });
    const result = await waitForReady(bg, 1000);
    assert.equal(result.ready, true);
    assert.equal(result.detail, "listening on 3000");
  });

  test("reports failure with exit code when the process died before ready", async () => {
    const bg = makeBg({
      alive: false,
      exitCode: 137,
      output: [{ stream: "stderr", line: "killed", ts: Date.now() }],
    });
    const result = await waitForReady(bg, 1000);
    assert.equal(result.ready, false);
    assert.match(result.detail, /exited before becoming ready/);
    assert.match(result.detail, /137/);
  });

  test("reports failure when the process entered an error state", async () => {
    const bg = makeBg({ status: "error", readyPort: 5173 });
    const result = await waitForReady(bg, 1000);
    assert.equal(result.ready, false);
    assert.match(result.detail, /error state/);
  });

  test("honors an already-aborted signal", async () => {
    const bg = makeBg();
    const result = await waitForReady(bg, 1000, AbortSignal.abort());
    assert.equal(result.ready, false);
    assert.equal(result.detail, "Cancelled");
  });

  test("times out while the process stays in starting", async () => {
    const bg = makeBg({ status: "starting" });
    const result = await waitForReady(bg, 10);
    assert.equal(result.ready, false);
    assert.match(result.detail, /Timed out after 10ms/);
  });
});

describe("bg-shell formatTimeAgo", () => {
  test("appends ' ago' to a formatted duration", () => {
    const out = formatTimeAgo(Date.now() - 5000);
    assert.equal(typeof out, "string");
    assert.ok(out.endsWith(" ago"), `expected "${out}" to end with " ago"`);
  });
});

describe("bg-shell getBgShellLiveCwd", () => {
  test("returns process.cwd() when it is available", () => {
    const result = getBgShellLiveCwd(
      undefined,
      () => true,
      () => "/live/cwd",
    );
    assert.equal(result, "/live/cwd");
  });

  test("falls back to the project root derived from an auto-worktree path", () => {
    const chdirCalls: string[] = [];
    const result = getBgShellLiveCwd(
      "/proj/.gsd/worktrees/abc/sub",
      (p) => p === "/proj",
      () => {
        throw new Error("getcwd: no such file or directory");
      },
      (p) => chdirCalls.push(p),
    );
    assert.equal(result, "/proj");
    assert.deepEqual(chdirCalls, ["/proj"]);
  });

  test("falls back to root when no candidate directory exists", () => {
    const result = getBgShellLiveCwd(
      undefined,
      () => false,
      () => {
        throw new Error("getcwd failed");
      },
      () => {},
    );
    assert.equal(result, "/");
  });
});

describe("bg-shell resolveBgShellPersistenceCwd", () => {
  const exists = () => true;

  test("keeps the cached cwd when it is not an auto-worktree", () => {
    const result = resolveBgShellPersistenceCwd("/home/user/project", "/somewhere/else", exists);
    assert.equal(result, "/home/user/project");
  });

  test("keeps the cached worktree when it matches the live cwd and still exists", () => {
    const worktree = "/proj/.gsd/worktrees/feature-a";
    const result = resolveBgShellPersistenceCwd(worktree, worktree, exists);
    assert.equal(result, worktree);
  });

  test("falls back to the live cwd when the cached worktree no longer exists", () => {
    const worktree = "/proj/.gsd/worktrees/feature-a";
    const result = resolveBgShellPersistenceCwd(worktree, "/proj", (p) => p !== worktree);
    assert.equal(result, "/proj");
  });

  test("prefers the live cwd when it diverges from an existing cached worktree", () => {
    const result = resolveBgShellPersistenceCwd(
      "/proj/.gsd/worktrees/feature-a",
      "/proj/.gsd/worktrees/feature-b",
      exists,
    );
    assert.equal(result, "/proj/.gsd/worktrees/feature-b");
  });
});
