// Project/App: gsd-pi
// File Purpose: T032 — `/gsd db restore-backup` routing and catalog discoverability.
//
// The restore-backup machinery shipped in T014 but was unreachable: no route in
// commands/handlers/ops.ts and no catalog entry. These tests fail if either the
// dispatch arm or the catalog registration is removed.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleOpsCommand } from "../commands/handlers/ops.ts";
import { withCommandCwd } from "../commands/context.ts";
import {
  GSD_COMMAND_DESCRIPTION,
  TOP_LEVEL_SUBCOMMANDS,
  getGsdArgumentCompletions,
} from "../commands/catalog.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeProjectDir(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-restore-routing-"));
  tempDirs.add(base);
  return base;
}

function makeCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
  };
}

const mockPi = {
  registerCommand() {},
  registerTool() {},
  registerShortcut() {},
  on() {},
  sendMessage() {},
};

test("/gsd db restore-backup is handled and reaches handleDbRestoreBackup", async () => {
  const base = makeProjectDir();
  const ctx = makeCtx();

  const handled = await withCommandCwd(base, () =>
    handleOpsCommand("db restore-backup", ctx as any, mockPi as any));

  assert.equal(handled, true, "the ops dispatcher must claim `db restore-backup`");
  const info = ctx.notifications.find((note) => /gsd db restore-backup:/.test(note.message));
  assert.ok(info, `expected the handler's output, got ${JSON.stringify(ctx.notifications)}`);
  assert.match(info.message, /no gsd\.db\.backup-v\* candidates found/);
  assert.equal(info.level, "info");
});

test("/gsd db restore-backup passes its argument remainder to the handler", async () => {
  const base = makeProjectDir();
  const ctx = makeCtx();

  const handled = await withCommandCwd(base, () =>
    handleOpsCommand("db restore-backup --backup /nope.db --list", ctx as any, mockPi as any));

  assert.equal(handled, true);
  // --backup and --list together are rejected by the handler; seeing that error
  // proves both flags survived the route's prefix trim.
  const error = ctx.notifications.find((note) => note.level === "error");
  assert.ok(error, `expected the mutually-exclusive refusal, got ${JSON.stringify(ctx.notifications)}`);
  assert.match(error.message, /--backup and --list are mutually exclusive/);
});

test("an unrelated command is still not claimed by the db route", async () => {
  const ctx = makeCtx();
  const handled = await handleOpsCommand("db-restore-backup", ctx as any, mockPi as any);
  assert.equal(handled, false);
  assert.deepEqual(ctx.notifications, []);
});

test("db restore-backup is discoverable in the command catalog", () => {
  assert.ok(
    TOP_LEVEL_SUBCOMMANDS.some((entry) => entry.cmd === "db"),
    "the db family must be a top-level subcommand",
  );
  assert.match(GSD_COMMAND_DESCRIPTION, /\|db\|/);

  const nested = getGsdArgumentCompletions("db ");
  const restore = nested.find((entry: any) => entry.value === "db restore-backup");
  assert.ok(restore, `expected a db restore-backup completion, got ${JSON.stringify(nested)}`);
  assert.match(restore.description, /backup/i);
});
