import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playQuestionBell } from "../../ask-user-questions.js";
import { stopAuto } from "../auto.js";
import { autoSession } from "../auto-runtime-state.js";
import {
  buildDesktopNotificationCommand,
  shouldSendDesktopNotification,
  formatNotificationTitle,
  playNotificationBell,
  shouldPlayNotificationBell,
} from "../notifications.js";
import type { NotificationPreferences } from "../types.js";

test("shouldSendDesktopNotification honors granular preferences", () => {
  const prefs: NotificationPreferences = {
    enabled: true,
    on_complete: false,
    on_error: true,
    on_budget: false,
    on_milestone: true,
    on_attention: false,
  };

  assert.equal(shouldSendDesktopNotification("complete", prefs), false);
  assert.equal(shouldSendDesktopNotification("error", prefs), true);
  assert.equal(shouldSendDesktopNotification("budget", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), true);
  assert.equal(shouldSendDesktopNotification("attention", prefs), false);
});

test("shouldSendDesktopNotification disables all categories when notifications are disabled", () => {
  const prefs: NotificationPreferences = { enabled: false, on_error: true, on_milestone: true };

  assert.equal(shouldSendDesktopNotification("error", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), false);
});

test("shouldPlayNotificationBell requires explicit local_bell opt-in", () => {
  assert.equal(shouldPlayNotificationBell("question", { enabled: true }), false);
  assert.equal(shouldPlayNotificationBell("question", { enabled: true, local_bell: true }), true);
  assert.equal(shouldPlayNotificationBell("stop", { enabled: true, local_bell: true, on_attention: false }), false);
  assert.equal(shouldPlayNotificationBell("stop", { enabled: false, local_bell: true, on_attention: true }), false);
});

test("playNotificationBell writes a terminal bell when enabled", () => {
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  assert.equal(playNotificationBell("question", { enabled: true, local_bell: true }, stream), true);
  assert.equal(output, "\u0007");
});

test("playNotificationBell is silent when disabled", () => {
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  assert.equal(playNotificationBell("question", { enabled: true, local_bell: false }, stream), false);
  assert.equal(output, "");
});

test("playQuestionBell writes a terminal bell when local bell is enabled", async () => {
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  await playQuestionBell({ enabled: true, local_bell: true }, stream);

  assert.equal(output, "\u0007");
});

test("playQuestionBell is silent when local bell is disabled", async () => {
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  await playQuestionBell({ enabled: true, local_bell: false }, stream);

  assert.equal(output, "");
});

test("stopAuto plays local bell for auto-mode stop notifications", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stop-bell-"));
  const previousCwd = process.cwd();
  const previousStderrWrite = process.stderr.write;
  const previousStderrIsTTY = process.stderr.isTTY;
  let bellOutput = "";

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;

  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nnotifications:\n  enabled: true\n  local_bell: true\n---\n",
    "utf-8",
  );

  process.stderr.isTTY = true;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      bellOutput += chunk;
    }
    return true;
  }) as typeof process.stderr.write;

  try {
    await stopAuto(
      { hasUI: false, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setHeader: () => {} } } as any,
      undefined,
      "test stop",
    );

    assert.ok(
      bellOutput.includes("\u0007"),
      "stopAuto must write a terminal bell to stderr when the local bell preference is enabled",
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    process.stderr.isTTY = previousStderrIsTTY;
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("buildDesktopNotificationCommand falls back to osascript on macOS when terminal-notifier is absent", () => {
  // When terminal-notifier is not on PATH, falls back to osascript.
  // This test runs in CI where terminal-notifier is typically not installed.
  // If terminal-notifier IS installed, we verify it returns that instead.
  const command = buildDesktopNotificationCommand(
    "darwin",
    `Bob's "Milestone"`,
    `Budget!\nPath: C:\\temp`,
    "error",
  );

  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    // terminal-notifier path — verify args structure
    assert.ok(command.args.includes("-title"));
    assert.ok(command.args.includes("-message"));
    assert.ok(command.args.includes("-sound"));
    assert.ok(command.args.includes("Basso")); // error level
  } else {
    // osascript fallback path
    assert.equal(command.file, "osascript");
    assert.deepEqual(command.args.slice(0, 1), ["-e"]);
    assert.match(command.args[1], /Bob's \\"Milestone\\"/);
    assert.match(command.args[1], /Budget! Path: C:\\\\temp/);
    assert.doesNotMatch(command.args[1], /\n/);
  }
});

test("buildDesktopNotificationCommand uses Glass sound for non-error on macOS", () => {
  const command = buildDesktopNotificationCommand("darwin", "Title", "Message", "info");
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    assert.ok(command.args.includes("Glass"));
  } else {
    assert.match(command.args[1], /sound name "Glass"/);
  }
});

test("buildDesktopNotificationCommand preserves literal shell characters on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    `Bob's $PATH !`,
    "line 1\nline 2",
    "warning",
  );

  assert.ok(command);
  assert.deepEqual(command, {
    file: "notify-send",
    args: ["-u", "normal", `Bob's $PATH !`, "line 1 line 2"],
  });
});

test("buildDesktopNotificationCommand skips unsupported platforms", () => {
  assert.equal(buildDesktopNotificationCommand("win32", "Title", "Message"), null);
});

// ─── formatNotificationTitle — project context in notifications (#2708) ──────

test("formatNotificationTitle returns 'GSD' when no project name is given", () => {
  assert.equal(formatNotificationTitle(), "GSD");
  assert.equal(formatNotificationTitle(undefined), "GSD");
  assert.equal(formatNotificationTitle(""), "GSD");
});

test("formatNotificationTitle includes project name when provided", () => {
  assert.equal(formatNotificationTitle("my-app"), "GSD — my-app");
});

test("formatNotificationTitle trims whitespace from project name", () => {
  assert.equal(formatNotificationTitle("  spaced  "), "GSD — spaced");
});

test("buildDesktopNotificationCommand includes project name in title on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    formatNotificationTitle("my-project"),
    "All milestones complete!",
    "success",
  );
  assert.ok(command);
  assert.equal(command.args[2], "GSD — my-project");
  assert.equal(command.args[3], "All milestones complete!");
});

test("buildDesktopNotificationCommand includes project name in title on macOS", () => {
  const command = buildDesktopNotificationCommand(
    "darwin",
    formatNotificationTitle("my-project"),
    "Budget 90%",
    "warning",
  );
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    const titleIdx = command.args.indexOf("-title");
    assert.equal(command.args[titleIdx + 1], "GSD — my-project");
  } else {
    assert.match(command.args[1], /GSD — my-project/);
  }
});
