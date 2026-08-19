import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import mcpClientExtension, {
  _assertTrustedStdioServerForTest,
  _buildMcpChildEnvForTest,
  _buildMcpTrustConfirmOptionsForTest,
  _resetMcpClientStateForTest,
} from "../../mcp-client/index.ts";
import type { ManagedMcpServerConfig } from "../../mcp-client/manager.ts";
import { hasPersistedStdioTrust } from "../../mcp-client/stdio-trust-store.ts";

const originalGsdHome = process.env.GSD_HOME;
const isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-mcp-trust-home-"));
before(() => {
  process.env.GSD_HOME = isolatedGsdHome;
});
after(() => {
  if (originalGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = originalGsdHome;
  rmSync(isolatedGsdHome, { recursive: true, force: true });
});

// Note: four source-grep tests that scanned `mcp-client/index.ts` for
// Map<> shapes, catch-block structure, and closeAll body were removed
// under #4827. They encoded implementation shape rather than behaviour —
// any refactor (extracted helper, different Map key type, rearranged
// cleanup order) broke the greps without a real regression. Runtime
// coverage of connectServer/closeAll with a mocked failing transport
// is tracked as a follow-up.

function makeStdioConfig(name: string): ManagedMcpServerConfig {
  return {
    name,
    transport: "stdio",
    sourcePath: `/tmp/${name}.mcp.json`,
    sourceKind: "project-shared",
    disabled: false,
    command: "node",
    args: ["server.js"],
    envWarnings: [],
  };
}

type ConfirmOptions = { timeout?: number; signal?: AbortSignal };

interface CapturedPrompt {
  title: string;
  options?: ConfirmOptions;
  resolve: (approved: boolean) => void;
  reject: (err: unknown) => void;
}

function createConfirmHarness(): {
  ctx: unknown;
  prompts: CapturedPrompt[];
  activeCount: () => number;
  maxActiveCount: () => number;
} {
  const prompts: CapturedPrompt[] = [];
  let active = 0;
  let maxActive = 0;
  const ctx = {
    hasUI: true,
    ui: {
      confirm(title: string, _message: string, options?: ConfirmOptions) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<boolean>((resolve, reject) => {
          let settled = false;
          let onAbort = () => {};
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            options?.signal?.removeEventListener("abort", onAbort);
            active -= 1;
            fn();
          };
          onAbort = () => {
            finish(() => reject(options?.signal?.reason ?? new Error("aborted")));
          };
          if (options?.signal?.aborted) {
            onAbort();
            return;
          }
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          prompts.push({
            title,
            options,
            resolve: (approved: boolean) => finish(() => resolve(approved)),
            reject: (err: unknown) => finish(() => reject(err)),
          });
        });
      },
    },
  };
  return {
    ctx,
    prompts,
    activeCount: () => active,
    maxActiveCount: () => maxActive,
  };
}

async function waitForCondition(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function createMockPi(): { pi: unknown; tools: Map<string, any> } {
  const tools = new Map<string, any>();
  return {
    tools,
    pi: {
      on() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    },
  };
}

test("MCP stdio child env only includes safe inherited keys plus explicit config env", () => {
  const previousSecret = process.env.SECRET_MCP_TEST_TOKEN;
  const previousPath = process.env.PATH;
  try {
    process.env.SECRET_MCP_TEST_TOKEN = "should-not-leak";
    process.env.PATH = "/usr/bin";

    const env = _buildMcpChildEnvForTest({
      EXPLICIT_TOKEN: "${SECRET_MCP_TEST_TOKEN}",
      PLAIN_VALUE: "ok",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.SECRET_MCP_TEST_TOKEN, undefined);
    assert.equal(env.EXPLICIT_TOKEN, "should-not-leak");
    assert.equal(env.PLAIN_VALUE, "ok");
  } finally {
    if (previousSecret === undefined) delete process.env.SECRET_MCP_TEST_TOKEN;
    else process.env.SECRET_MCP_TEST_TOKEN = previousSecret;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("MCP stdio trust confirmation is abort-aware", () => {
  const controller = new AbortController();
  const options = _buildMcpTrustConfirmOptionsForTest(controller.signal);

  assert.equal(options.timeout, 120_000);
  assert.equal(options.signal, controller.signal);
});

test("MCP stdio trust confirmations are serialized across different servers", async () => {
  const harness = createConfirmHarness();
  try {
    const first = _assertTrustedStdioServerForTest(makeStdioConfig("server-a"), harness.ctx as any);
    const second = _assertTrustedStdioServerForTest(makeStdioConfig("server-b"), harness.ctx as any);

    await waitForCondition("first trust prompt", () => harness.prompts.length === 1);
    assert.equal(harness.activeCount(), 1);
    assert.equal(harness.maxActiveCount(), 1);
    assert.match(harness.prompts[0]?.title ?? "", /server-a/);

    harness.prompts[0]?.resolve(true);
    await waitForCondition("second trust prompt", () => harness.prompts.length === 2);
    assert.equal(harness.activeCount(), 1);
    assert.equal(harness.maxActiveCount(), 1);
    assert.match(harness.prompts[1]?.title ?? "", /server-b/);

    harness.prompts[1]?.resolve(true);
    const trustKeys = await Promise.all([first, second]);
    assert.match(trustKeys[0] ?? "", /server-a/);
    assert.match(trustKeys[1] ?? "", /server-b/);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio trust approval aborts while queued and releases the queue", async () => {
  const harness = createConfirmHarness();
  try {
    const first = _assertTrustedStdioServerForTest(makeStdioConfig("queued-a"), harness.ctx as any);
    await waitForCondition("active first trust prompt", () => harness.prompts.length === 1);

    const controller = new AbortController();
    const second = _assertTrustedStdioServerForTest(
      makeStdioConfig("queued-b"),
      harness.ctx as any,
      controller.signal,
    );

    controller.abort(new Error("caller aborted"));
    await assert.rejects(second, /caller aborted/);
    assert.equal(harness.prompts.length, 1, "aborted queued approval must not open a prompt");

    harness.prompts[0]?.resolve(true);
    await first;

    const third = _assertTrustedStdioServerForTest(makeStdioConfig("queued-c"), harness.ctx as any);
    await waitForCondition("third trust prompt after queued abort", () => harness.prompts.length === 2);
    harness.prompts[1]?.resolve(true);
    await third;
    assert.equal(harness.maxActiveCount(), 1);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio trust approval hard timeout rejects and releases the queue", async () => {
  let hangingPromptCount = 0;
  const hangingCtx = {
    hasUI: true,
    ui: {
      confirm() {
        hangingPromptCount += 1;
        return new Promise<boolean>(() => {});
      },
    },
  };

  try {
    const timedOut = _assertTrustedStdioServerForTest(
      makeStdioConfig("timeout-a"),
      hangingCtx as any,
      undefined,
      25,
    );
    await waitForCondition("hanging trust prompt", () => hangingPromptCount === 1);
    await assert.rejects(timedOut, /Timed out waiting for stdio MCP trust approval for "timeout-a"/);

    const harness = createConfirmHarness();
    const next = _assertTrustedStdioServerForTest(makeStdioConfig("timeout-b"), harness.ctx as any);
    await waitForCondition("trust prompt after timeout", () => harness.prompts.length === 1);
    harness.prompts[0]?.resolve(true);
    await next;
  } finally {
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio trust keeps serializing when a queued caller aborts mid-prompt", async () => {
  const harness = createConfirmHarness();
  try {
    const first = _assertTrustedStdioServerForTest(makeStdioConfig("parallel-a"), harness.ctx as any);
    await waitForCondition("active first trust prompt", () => harness.prompts.length === 1);

    const controller = new AbortController();
    const second = _assertTrustedStdioServerForTest(
      makeStdioConfig("parallel-b"),
      harness.ctx as any,
      controller.signal,
    );
    controller.abort(new Error("caller aborted"));
    await assert.rejects(second, /caller aborted/);

    // A third caller enters while the first prompt is STILL active. It must
    // queue behind it rather than open a concurrent prompt. Regression guard for
    // the queue-reset-allows-parallel-prompts bug: a queued caller aborting must
    // not collapse the queue and let a new caller run alongside the live prompt.
    const third = _assertTrustedStdioServerForTest(makeStdioConfig("parallel-c"), harness.ctx as any);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.prompts.length, 1, "third caller must not open a concurrent prompt");
    assert.equal(harness.maxActiveCount(), 1);

    harness.prompts[0]?.resolve(true);
    await first;
    await waitForCondition("third prompt after first resolves", () => harness.prompts.length === 2);
    assert.match(harness.prompts[1]?.title ?? "", /parallel-c/);
    harness.prompts[1]?.resolve(true);
    await third;
    assert.equal(harness.maxActiveCount(), 1);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio trust timeout does not run while queued behind another prompt", async () => {
  const harness = createConfirmHarness();
  try {
    const first = _assertTrustedStdioServerForTest(makeStdioConfig("timeout-queue-a"), harness.ctx as any);
    await waitForCondition("active first trust prompt", () => harness.prompts.length === 1);

    // Short timeout on the queued caller. It must NOT fire while queued behind A;
    // the hard timeout only covers the prompt, not time spent waiting in queue.
    const second = _assertTrustedStdioServerForTest(
      makeStdioConfig("timeout-queue-b"),
      harness.ctx as any,
      undefined,
      50,
    );

    // Hold A active well past B's timeout budget. B must still be queued, not timed out.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.prompts.length, 1, "queued caller must not open a prompt yet");

    harness.prompts[0]?.resolve(true);
    await first;
    // B now owns the prompt; only here does its timeout begin.
    await waitForCondition("second trust prompt after first resolves", () => harness.prompts.length === 2);
    assert.match(harness.prompts[1]?.title ?? "", /timeout-queue-b/);
    harness.prompts[1]?.resolve(true);
    await second;
    assert.equal(harness.maxActiveCount(), 1);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio closeAll aborts queued trust waiters, not just the active prompt", async () => {
  const harness = createConfirmHarness();
  try {
    const first = _assertTrustedStdioServerForTest(makeStdioConfig("close-a"), harness.ctx as any);
    await waitForCondition("active first trust prompt", () => harness.prompts.length === 1);
    const second = _assertTrustedStdioServerForTest(makeStdioConfig("close-b"), harness.ctx as any);

    // closeAll (via reset) must cancel BOTH the active prompt and the queued
    // waiter, so the queued waiter never reaches ui.confirm after shutdown.
    const firstRejects = assert.rejects(first, /MCP session closed/);
    const secondRejects = assert.rejects(second, /MCP session closed/);
    await _resetMcpClientStateForTest();
    await firstRejects;
    await secondRejects;

    assert.equal(harness.prompts.length, 1, "queued waiter must not reach ui.confirm after closeAll");
    assert.equal(harness.maxActiveCount(), 1);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("MCP stdio discover deduplicates concurrent first calls for the same server", async () => {
  const previousGsdHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  const projectDir = mkdtempSync(join(tmpdir(), "mcp-client-dedupe-project-"));
  const gsdHomeDir = mkdtempSync(join(tmpdir(), "mcp-client-dedupe-home-"));

  try {
    process.env.GSD_HOME = gsdHomeDir;
    process.chdir(projectDir);
    mkdirSync(join(projectDir, ".gsd"), { recursive: true });

    const require = createRequire(import.meta.url);
    const mcpModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
    const stdioModuleUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const startLogPath = join(projectDir, "starts.log");
    const serverPath = join(projectDir, "dedupe-mcp-server.mjs");
    writeFileSync(
      serverPath,
      [
        `const { McpServer } = await import(${JSON.stringify(mcpModuleUrl)});`,
        `const { StdioServerTransport } = await import(${JSON.stringify(stdioModuleUrl)});`,
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(startLogPath)}, "start\\n", "utf-8");`,
        'const server = new McpServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });',
        'server.tool("dedupe_tool", "Deduped tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));',
        'await server.connect(new StdioServerTransport());',
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "dedupe-server": { command: process.execPath, args: [serverPath] } } }),
      "utf-8",
    );

    const { pi, tools } = createMockPi();
    mcpClientExtension(pi as any);
    const discover = tools.get("mcp_discover");
    assert.ok(discover, "mcp_discover must be registered");

    let promptCount = 0;
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async () => {
          promptCount += 1;
          return true;
        },
      },
    };
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      discover.execute("call-1", { server: "dedupe-server" }, signal, () => {}, ctx),
      discover.execute("call-2", { server: "dedupe-server" }, signal, () => {}, ctx),
    ]);

    assert.equal(promptCount, 1);
    assert.match(first.content[0]?.text ?? "", /dedupe_tool/);
    assert.match(second.content[0]?.text ?? "", /dedupe_tool/);
    const starts = existsSync(startLogPath)
      ? readFileSync(startLogPath, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(starts.length, 1, "concurrent same-server discovery must create one stdio connection");
  } finally {
    await _resetMcpClientStateForTest();
    process.chdir(originalCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(gsdHomeDir, { recursive: true, force: true });
  }
});

test("headless stdio trust fails until persisted interactive approval (#1772)", async () => {
  process.env.GSD_HOME = isolatedGsdHome;
  const config = { ...makeStdioConfig("headless-trust"), env: { CUSTOM_KEY: "placeholder-value" } };
  await assert.rejects(
    _assertTrustedStdioServerForTest(config, { hasUI: false } as any),
    /project-shared stdio command.*run mcp_discover for "headless-trust" once in an interactive GSD session/s,
  );
  await assert.rejects(
    _assertTrustedStdioServerForTest({ ...config, sourceKind: "project-local" }, { hasUI: false } as any),
    /project-local stdio command.*run mcp_discover for "headless-trust" once in an interactive GSD session/s,
  );
  const harness = createConfirmHarness();
  try {
    const pending = _assertTrustedStdioServerForTest(config, harness.ctx as any);
    await waitForCondition("interactive trust", () => harness.prompts.length === 1);
    harness.prompts[0]?.resolve(true);
    await pending;
    assert.equal(hasPersistedStdioTrust(config), true);
    const store = readFileSync(join(isolatedGsdHome, "mcp-stdio-trust.json"), "utf-8");
    assert.equal(store.includes("placeholder-value"), false);
    assert.equal(store.includes("CUSTOM_KEY"), false);
    await _resetMcpClientStateForTest();
    await _assertTrustedStdioServerForTest(config, { hasUI: false } as any);
  } finally {
    for (const prompt of harness.prompts) prompt.reject(new Error("test cleanup"));
    await _resetMcpClientStateForTest();
  }
});

test("stdio trust never prompts in a subagent child (#1772)", async (t) => {
  const previousSubagentChild = process.env.GSD_SUBAGENT_CHILD;
  t.after(async () => {
    if (previousSubagentChild === undefined) delete process.env.GSD_SUBAGENT_CHILD;
    else process.env.GSD_SUBAGENT_CHILD = previousSubagentChild;
    await _resetMcpClientStateForTest();
  });
  process.env.GSD_SUBAGENT_CHILD = "1";
  let promptCount = 0;
  await assert.rejects(
    _assertTrustedStdioServerForTest({
      ...makeStdioConfig("untrusted-child"),
      sourceKind: "project-local",
    }, {
      hasUI: true,
      ui: {
        confirm: async () => {
          promptCount += 1;
          return true;
        },
      },
    } as any),
    /project-local stdio command.*Trust required/s,
  );
  assert.equal(promptCount, 0);
});
