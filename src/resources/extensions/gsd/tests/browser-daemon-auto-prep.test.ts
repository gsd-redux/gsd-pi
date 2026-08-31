import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBrowserDaemonStarted,
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

/**
 * Stand-in for the gsd-browser CLI, wired in through GSD_BROWSER_MCP_COMMAND, which
 * resolveGsdBrowserMcpLaunchConfig splits into command + prefix args and the daemon
 * invocation forwards ahead of `daemon <action>`.
 */
function writeFakeGsdBrowser(dir: string, lines: string[]): string {
  const scriptPath = join(dir, "fake-gsd-browser.mjs");
  writeFileSync(scriptPath, `${lines.join("\n")}\n`, "utf-8");
  return scriptPath;
}

function fakeCliEnv(scriptPath: string): NodeJS.ProcessEnv {
  // splitCommandLine() honours double quotes, so paths with spaces still resolve.
  return { GSD_BROWSER_MCP_COMMAND: `"${process.execPath}" "${scriptPath.replace(/\\/g, "/")}"` };
}

test("ensureBrowserDaemonStarted does not hang when the daemon leaves a child holding stdio", (t) => {
  // Regression guard for #2103: `daemon start` exits 0 but leaves a detached daemon that
  // inherits the parent's stdio. With a *pipe* the parent blocks on EOF - not on child exit -
  // and burns the whole timeout. The timeout here is deliberately far above the assertion
  // threshold so a slow runner cannot masquerade as the bug returning.
  const dir = mkdtempSync(join(tmpdir(), "gsd-daemon-hang-"));
  const pidPath = join(dir, "grandchild.pid").replace(/\\/g, "/");
  t.after(() => {
    try {
      process.kill(Number(readFileSync(pidPath, "utf-8").trim()));
    } catch {
      /* already exited, or never recorded */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const scriptPath = writeFakeGsdBrowser(dir, [
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync } from "node:fs";`,
    `process.stdout.write("Daemon started.\\n");`,
    `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {`,
    `  stdio: "inherit",`,
    `  detached: true,`,
    `});`,
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid), "utf-8");`,
    `child.unref();`,
    `process.exit(0);`,
  ]);

  const startedAt = Date.now();
  // dir doubles as projectRoot so the invocation gets a cwd that exists.
  const result = ensureBrowserDaemonStarted(dir, { env: fakeCliEnv(scriptPath), timeoutMs: 20_000 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, true, `expected a clean start, got ${JSON.stringify(result)}`);
  assert.ok(elapsedMs < 5_000, `warm-up should return promptly, took ${elapsedMs}ms`);
});

test("ensureBrowserDaemonStarted keeps daemon stderr in the failure detail", (t) => {
  // Guards the file-capture path added with runDaemonCommand rather than the original bug:
  // dropping the stdio pipes must not cost the actionable cause. This also passes against
  // the pre-fix code, where execFileSync folded piped stderr into error.message - it exists
  // to stop a future simplification to stdio "ignore", which would silently degrade the
  // user-facing message to a bare "Command failed: <cmd>".
  const dir = mkdtempSync(join(tmpdir(), "gsd-daemon-stderr-"));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const scriptPath = writeFakeGsdBrowser(dir, [
    `process.stderr.write("chrome not found: set GSD_BROWSER_PATH\\n");`,
    `process.exit(1);`,
  ]);

  const result = ensureBrowserDaemonStarted(dir, { env: fakeCliEnv(scriptPath), timeoutMs: 20_000 });

  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.error,
    /chrome not found/,
    "daemon stderr must survive into the actionable error message",
  );
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
