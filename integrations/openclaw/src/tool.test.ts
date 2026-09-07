import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindStore } from "./binding.js";
import { handleGsdCommand, type ServiceState } from "./commands.js";
import { GsdCli } from "./gsd-cli.js";
import type { Notifier } from "./notify.js";
import { Supervisor } from "./supervisor.js";
import { TOOL_NAME, createGsdStatusTool } from "./tool.js";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./types.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const ENVELOPE = JSON.stringify({
  integration_version: 1,
  data: {
    activeMilestone: { id: "M001", title: "Hermes Integration" },
    activeSlice: null,
    activeTask: null,
    phase: "execute",
    milestones: { total: 1, done: 0, active: 1 },
    slices: { total: 0, done: 0 },
    tasks: { total: 0, done: 0 },
    requirements: null,
    blockers: ["waiting on API key"],
    nextAction: "Run contract tests",
  },
});

async function withService<T>(fn: (project: string, service: ServiceState) => Promise<T>, exec = async () => ({ stdout: ENVELOPE, stderr: "" })): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "open-gsd-tool-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  const service: ServiceState = {
    bindStore: new BindStore(join(root, "bindings.json")),
    cli: new GsdCli("gsd", exec),
    supervisor: new Supervisor({ cliPath: "gsd", logger, onEvent() {} }),
    notifier: { send() {} } as unknown as Notifier,
  };
  try {
    return await fn(project, service);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function tool(service: ServiceState | null, ctx: OpenClawPluginToolContext, defaultProject?: string): AnyAgentTool {
  const made = createGsdStatusTool({ config: { cliPath: "gsd", defaultProject }, getService: () => service })(ctx);
  assert.ok(made && !Array.isArray(made));
  return made;
}

const toolCtx: OpenClawPluginToolContext = {
  sessionKey: "agent:main:telegram:group:-100123:topic:7",
  deliveryContext: { channel: "telegram", to: "telegram:-100123:topic:7", accountId: "bot1", threadId: 7 },
};

describe("gsd_status tool", () => {
  it("is named gsd_status with a JSON-schema parameter block", () => {
    const t = tool(null, {});
    assert.equal(t.name, TOOL_NAME);
    assert.equal(t.label, "GSD status");
    assert.deepEqual(t.parameters, { type: "object", properties: { project: { type: "string", description: "absolute project path; optional" } }, additionalProperties: false });
  });

  it("resolves the binding made from a command context whose `to` lacks the topic suffix", async () => {
    await withService(async (project, service) => {
      const deps = { config: { cliPath: "gsd" }, logger, getService: () => service };
      const bound = await handleGsdCommand(deps, { channel: "telegram", to: "telegram:-100123", accountId: "bot1", messageThreadId: 7, isAuthorizedSender: true, commandBody: "/gsd", args: `bind ${project}` });
      assert.match(bound.text ?? "", /Bound/);
      const result = await tool(service, toolCtx).execute("call-1", {});
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /Active milestone: M001: Hermes Integration/);
      assert.match(result.content[0].text, /Project: `/);
      assert.match(result.content[0].text, /\nRun: none$/);
      assert.deepEqual(result.details, {
        projectDir: project,
        phase: "execute",
        activeMilestone: { id: "M001", title: "Hermes Integration" },
        activeSlice: null,
        activeTask: null,
        blockers: ["waiting on API key"],
        nextAction: "Run contract tests",
        run: null,
      });
    });
  });

  it("returns plain content when nothing is bound or the service is not ready, and throws on bad input", async () => {
    await withService(async (project, service) => {
      const unbound = await tool(service, toolCtx).execute("c", {});
      assert.match(unbound.content[0].text, /No GSD project bound/);
      assert.deepEqual(unbound.details, { projectDir: null, run: null });
      const notReady = await tool(null, toolCtx).execute("c", {});
      assert.match(notReady.content[0].text, /has not started/);
      await assert.rejects(() => tool(service, toolCtx).execute("c", { project: 42 }), /absolute path string/);
      await assert.rejects(() => tool(service, toolCtx).execute("c", { project: "relative" }), /must be absolute/);
      const explicit = await tool(service, {}).execute("c", { project });
      assert.match(explicit.content[0].text, /Phase: execute/);
      const viaDefault = await tool(service, {}, project).execute("c", undefined);
      assert.match(viaDefault.content[0].text, /Phase: execute/);
    });
  });

  it("throws when the CLI read fails", async () => {
    await withService(
      async (project, service) => {
        await assert.rejects(() => tool(service, {}, project).execute("c", {}), /cliPath/);
      },
      async () => {
        throw new Error('gsd CLI not found at "gsd"; set plugins.entries.open-gsd-openclaw.config.cliPath');
      },
    );
  });
});
