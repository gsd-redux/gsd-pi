import test from "node:test";
import assert from "node:assert/strict";

import {
  prepareBrowserDaemonForUat,
  shouldWarmBrowserDaemonForUat,
  stopBrowserDaemon,
  teardownWarmedBrowserDaemons,
} from "../browser-daemon-auto-prep.ts";
import { commitBrowserEngineResolution } from "../../browser-tools/engine/selection.ts";

const GSD_BROWSER_ENGINE = {
  GSD_BROWSER_ENGINE: "gsd-browser",
  GSD_BROWSER_MCP_COMMAND: "/fixture/gsd-browser",
} as const;

test("shouldWarmBrowserDaemonForUat skips artifact-driven UAT", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "artifact-driven",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat enables Claude Code browser UAT when gsd-browser is configured", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      sessionAuthMode: "externalCli",
      projectRoot: "/tmp/project",
      env: GSD_BROWSER_ENGINE,
    }),
    true,
  );
});

test("shouldWarmBrowserDaemonForUat enables warm-up for Claude Code oauth/apiKey when engine is gsd-browser", () => {
  for (const sessionAuthMode of ["oauth", "apiKey"] as const) {
    assert.equal(
      shouldWarmBrowserDaemonForUat({
        uatType: "browser-executable",
        sessionProvider: "claude-code",
        sessionAuthMode,
        sessionBaseUrl: "https://api.anthropic.com",
        projectRoot: "/tmp/project",
        env: GSD_BROWSER_ENGINE,
      }),
      true,
      `expected warm-up for sessionAuthMode=${sessionAuthMode}`,
    );
  }
});

test("shouldWarmBrowserDaemonForUat skips legacy Playwright engine for Claude Code", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      sessionAuthMode: "oauth",
      projectRoot: "/tmp/project",
      env: { GSD_BROWSER_ENGINE: "legacy" },
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat uses session-committed ambient engine for non-Claude providers", () => {
  const projectRoot = "/tmp/ambient-engine-project";
  commitBrowserEngineResolution(projectRoot, {
    engine: "legacy",
    source: "probe",
    reason: "gsd-browser daemon connect failed (test); using legacy Playwright",
  });

  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "openai",
      projectRoot,
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat skips when browser MCP is disabled", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
      env: { GSD_BROWSER_MCP_ENABLED: "0" },
    }),
    false,
  );
});

test("shouldWarmBrowserDaemonForUat skips when warm-up is disabled", () => {
  assert.equal(
    shouldWarmBrowserDaemonForUat({
      uatType: "browser-executable",
      sessionProvider: "claude-code",
      projectRoot: "/tmp/project",
      env: { GSD_BROWSER_WARMUP: "0" },
    }),
    false,
  );
});

test("prepareBrowserDaemonForUat returns null when warm-up is not required", () => {
  assert.equal(
    prepareBrowserDaemonForUat({
      uatType: "artifact-driven",
      sessionProvider: "claude-code",
      sessionAuthMode: "externalCli",
      projectRoot: "/tmp/example-project",
    }),
    null,
  );
});

test("prepareBrowserDaemonForUat returns actionable error when daemon start fails", () => {
  const error = prepareBrowserDaemonForUat({
    uatType: "browser-executable",
    sessionProvider: "claude-code",
    sessionAuthMode: "externalCli",
    projectRoot: "/tmp/example-project",
    env: {
      ...GSD_BROWSER_ENGINE,
      GSD_BROWSER_MCP_COMMAND: "/definitely/missing/gsd-browser",
    },
  });

  assert.match(error ?? "", /gsd-browser daemon failed to start/i);
});

test("stopBrowserDaemon reports failure when the gsd-browser CLI is missing", () => {
  const result = stopBrowserDaemon("/tmp/example-project", {
    env: { GSD_BROWSER_MCP_COMMAND: "/definitely/missing/gsd-browser" },
  });

  assert.equal(result.ok, false);
});

test("teardownWarmedBrowserDaemons is a no-op when nothing was warmed", () => {
  // A failed warm-up must not register a project root for teardown.
  prepareBrowserDaemonForUat({
    uatType: "browser-executable",
    sessionProvider: "claude-code",
    sessionAuthMode: "externalCli",
    projectRoot: "/tmp/example-project",
    env: {
      ...GSD_BROWSER_ENGINE,
      GSD_BROWSER_MCP_COMMAND: "/definitely/missing/gsd-browser",
    },
  });

  assert.deepEqual(teardownWarmedBrowserDaemons(), []);
});
