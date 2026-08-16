// gsd-pi — workflow-logger behavior regression tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  drainAndSummarize,
  formatForNotification,
  hasAnyIssues,
  logError,
  logWarning,
  peekLogs,
  _resetLogs,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";

test("drainAndSummarize summarizes and clears the workflow log buffer", () => {
  const previous = setStderrLoggingEnabled(false);
  try {
    _resetLogs();
    logWarning("projection", "STATE.md render failed", { file: "STATE.md" });
    logError("db", "WAL checkpoint failed");

    assert.equal(hasAnyIssues(), true);
    const drained = drainAndSummarize();

    assert.equal(drained.logs.length, 2);
    assert.match(drained.summary ?? "", /STATE\.md render failed/);
    assert.match(drained.summary ?? "", /WAL checkpoint failed/);
    assert.equal(peekLogs().length, 0);
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
});

test("formatForNotification includes component and useful context", () => {
  const text = formatForNotification([
    {
      ts: "2026-01-01T00:00:00.000Z",
      severity: "warn",
      component: "projection",
      message: "render failed",
      context: { file: "STATE.md", command: "derive" },
    },
  ]);

  assert.match(text, /\[projection\] render failed/);
  assert.match(text, /file: STATE\.md/);
  assert.match(text, /command: derive/);
});
