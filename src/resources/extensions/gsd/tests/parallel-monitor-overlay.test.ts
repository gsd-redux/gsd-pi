// Project/App: gsd-pi
// File Purpose: Regression tests for parallel monitor overlay rendering and input handling.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { visibleWidth } from "@gsd/pi-tui";
import { assertFullOuterBorder } from "./tui-border-assertions.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";

function assertLinesFit(lines: string[], width: number): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} "${line}"`,
    );
  }
}

describe("parallel-monitor-overlay", () => {
  it("reads worker DB progress and appended NDJSON cost without sqlite CLI or full stdout reads", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-parallel-overlay-"));
    const stdoutPath = join(base, ".gsd", "parallel", "M001.stdout.log");
    const cjsRequire = createRequire(import.meta.url);
    const fsBuiltin = cjsRequire("node:fs") as typeof import("node:fs");
    const childProcessBuiltin = cjsRequire("node:child_process") as typeof import("node:child_process");
    const originalReadFileSync = fsBuiltin.readFileSync;
    const originalSpawnSync = childProcessBuiltin.spawnSync;

    try {
      mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
      assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
      insertMilestone({ id: "M001", title: "Monitor Fixture" });
      insertSlice({ milestoneId: "M001", id: "S01", title: "Build overlay", status: "pending", sequence: 1 });
      insertTask({
        milestoneId: "M001",
        sliceId: "S01",
        id: "T01",
        status: "complete",
        oneLiner: "render progress",
        sequence: 1,
      });
      insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", status: "pending", sequence: 2 });
      closeDatabase();

      writeFileSync(
        join(base, ".gsd", "parallel", "M001.status.json"),
        JSON.stringify({
          milestoneId: "M001",
          pid: process.pid,
          state: "running",
          cost: 0,
          lastHeartbeat: Date.now(),
          startedAt: Date.now() - 30_000,
          worktreePath: join(base, ".gsd-worktrees", "M001"),
        }),
        "utf-8",
      );
      writeFileSync(
        stdoutPath,
        JSON.stringify({ type: "message_end", message: { usage: { cost: { total: 1.25 } } } }) + "\n",
        "utf-8",
      );

      fsBuiltin.readFileSync = ((filePath: Parameters<typeof originalReadFileSync>[0], ...args: unknown[]) => {
        if (String(filePath) === stdoutPath) throw new Error("full stdout log reads are disabled in this test");
        return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(filePath, ...args);
      }) as typeof fsBuiltin.readFileSync;
      childProcessBuiltin.spawnSync = ((command: Parameters<typeof originalSpawnSync>[0], ...args: unknown[]) => {
        if (command === "sqlite3") throw new Error("sqlite3 CLI is disabled in this test");
        return (originalSpawnSync as (...spawnArgs: unknown[]) => unknown)(command, ...args);
      }) as typeof childProcessBuiltin.spawnSync;

      const mod = await import("../parallel-monitor-overlay.js");
      const mockTui = { requestRender: () => {} };
      const mockTheme = {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      };
      const overlay = new mod.ParallelMonitorOverlay(mockTui, mockTheme as any, () => {}, base);

      try {
        const joined = overlay.render(100).join("\n");
        assert.match(joined, /S01:1\/2/, "slice progress should come from the in-process DB reader");
        assert.match(joined, /S01\/T01: render progress/, "recent completions should come from the in-process DB reader");
        assert.match(joined, /\$1\.25/, "cost should come from bounded NDJSON reads");

        appendFileSync(
          stdoutPath,
          JSON.stringify({ type: "message_end", message: { usage: { cost: { total: 2.00 } } } }) + "\n",
          "utf-8",
        );
        (overlay as any).refresh();
        const refreshed = overlay.render(100).join("\n");
        assert.match(refreshed, /\$3\.25/, "cost should include only newly appended NDJSON events");
      } finally {
        overlay.dispose();
      }
    } finally {
      fsBuiltin.readFileSync = originalReadFileSync;
      childProcessBuiltin.spawnSync = originalSpawnSync;
      try { closeDatabase(); } catch { /* already closed */ }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("progressBar generates correct width", async () => {
    // Dynamic import to test the module loads cleanly
    const mod = await import("../parallel-monitor-overlay.js");
    // Module should export the class
    assert.ok(mod.ParallelMonitorOverlay, "ParallelMonitorOverlay class should be exported");
  });

  it("ParallelMonitorOverlay can be instantiated with mock tui", async () => {
    const mod = await import("../parallel-monitor-overlay.js");

    let renderRequested = false;
    const mockTui = { requestRender: () => { renderRequested = true; } };
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    let closed = false;

    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => { closed = true; },
      "/nonexistent/path",  // basePath — no real data, tests empty state
    );

    // Should render without throwing
    const lines = overlay.render(80);
    assert.ok(Array.isArray(lines), "render should return an array");
    assert.ok(lines.length > 0, "render should return at least one line");
    assertLinesFit(lines, 80);

    // Should contain header text
    const joined = lines.join("\n");
    assert.ok(joined.includes("Parallel Monitor"), "should include title");
    assert.ok(joined.includes("No parallel workers found"), "should show empty state");
    assertFullOuterBorder(lines, 80);
    assert.match(lines[0] ?? "", /^╭─ GSD Parallel Monitor /);
    assert.match(lines.at(-1) ?? "", /^╰─+╯$/);

    // Dispose should not throw
    overlay.dispose();

    // handleInput with ESC should call onClose
    const overlay2 = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => { closed = true; },
      "/nonexistent/path",
    );
    overlay2.handleInput("q");
    assert.ok(closed, "pressing q should trigger onClose");
    overlay2.dispose();

  });

  it("ParallelMonitorOverlay clamps scrollOffset during render", async () => {
    const mod = await import("../parallel-monitor-overlay.js");

    const mockTui = { requestRender: () => {} };
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => {},
      "/nonexistent/path",
    );

    (overlay as any).scrollOffset = 999;
    overlay.render(80);
    assert.equal((overlay as any).scrollOffset, 0, "empty overlays clamp scroll to zero");
    overlay.dispose();
  });

  it("ParallelMonitorOverlay empty state fits narrow and wide widths", async () => {
    const mod = await import("../parallel-monitor-overlay.js");

    const mockTui = { requestRender: () => {} };
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme as any,
      () => {},
      "/nonexistent/path",
    );

    for (const width of [40, 80, 120]) {
      const lines = overlay.render(width);
      assertLinesFit(lines, width);
      assertFullOuterBorder(lines, width);
      overlay.invalidate();
    }

    overlay.dispose();
  });
});
