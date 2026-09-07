import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BindStore } from "./binding.js";
import { HELP_TEXT, createGsdCommand, handleGsdCommand, tokenize, type ServiceState } from "./commands.js";
import { GsdCli, type ExecFn } from "./gsd-cli.js";
import type { Notifier } from "./notify.js";
import { PLUGIN_ID, register } from "./plugin.js";
import { Supervisor, type ChildLike } from "./supervisor.js";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginCommandDefinition, OpenClawPluginServiceContext, OpenClawPluginToolFactory, PluginCommandContext, PluginRuntimeLifecycleRegistration } from "./types.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const PROGRESS_ENVELOPE = JSON.stringify({
  integration_version: 1,
  kind: "progress",
  projectDir: "/p",
  data: {
    activeMilestone: { id: "M001", title: "Hermes Integration" },
    activeSlice: { id: "S01", title: "Gateway MVP" },
    activeTask: { id: "T01", title: "Plugin scaffold" },
    phase: "execute",
    milestones: { total: 1, done: 0, active: 1 },
    slices: { total: 1, done: 0 },
    tasks: { total: 1, done: 0 },
    requirements: { active: 2, validated: 0 },
    blockers: [],
    nextAction: "Run contract tests",
  },
});

function ctx(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return { channel: "telegram", to: "-100123", isAuthorizedSender: true, commandBody: "/gsd", ...overrides };
}

async function withProject<T>(fn: (root: string, project: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "open-gsd-openclaw-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  try {
    return await fn(root, project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Minimal stub of the OpenClaw plugin API that records registrations (kitchen-sink harness pattern). */
function stubApi(pluginConfig: Record<string, unknown> = {}, registrationMode = "full") {
  const commands: OpenClawPluginCommandDefinition[] = [];
  const services: Array<{ id: string; start: (c: OpenClawPluginServiceContext) => void | Promise<void>; stop?: (c: OpenClawPluginServiceContext) => void | Promise<void> }> = [];
  const tools: Array<{ tool: AnyAgentTool | OpenClawPluginToolFactory; opts?: { name?: string } }> = [];
  const lifecycles: PluginRuntimeLifecycleRegistration[] = [];
  const api: OpenClawPluginApi = {
    id: PLUGIN_ID,
    name: "Open GSD",
    pluginConfig,
    logger: silentLogger,
    registrationMode,
    registerCommand: (definition) => void commands.push(definition),
    registerService: (service) => void services.push(service),
    registerTool: (tool, opts) => void tools.push({ tool, opts }),
    lifecycle: { registerRuntimeLifecycle: (registration) => void lifecycles.push(registration) },
  };
  return { api, commands, services, tools, lifecycles };
}

/** In-memory child so command tests can assert the spawned argv without a process. */
function fakeSpawn() {
  const spawned: Array<{ file: string; args: string[]; cwd: string; kills: string[]; stdout: PassThrough }> = [];
  const spawn = (file: string, args: string[], opts: { cwd: string }): ChildLike => {
    const emitter = new EventEmitter();
    const record = { file, args, cwd: opts.cwd, kills: [] as string[], stdout: new PassThrough() };
    spawned.push(record);
    return {
      pid: 4242,
      stdin: { writable: true, destroyed: false, write: () => true, on: () => undefined },
      stdout: record.stdout,
      stderr: new PassThrough(),
      on: emitter.on.bind(emitter) as ChildLike["on"],
      kill: (signal?: string) => {
        record.kills.push(signal ?? "");
        emitter.emit("exit", null, signal);
        emitter.emit("close", null, signal);
        return true;
      },
    };
  };
  return { spawn, spawned };
}

/** A gsd stand-in that only hangs until SIGTERM, for the default-spawn paths. */
function writeHangingCli(root: string): string {
  const cliPath = join(root, "fake-gsd");
  writeFileSync(cliPath, `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(11));\nsetInterval(() => {}, 1000);\n`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

describe("tokenize", () => {
  it("splits on whitespace and honours quotes", () => {
    assert.deepEqual(tokenize('bind "/Users/me/my app" extra'), ["bind", "/Users/me/my app", "extra"]);
    assert.deepEqual(tokenize("  status  "), ["status"]);
    assert.deepEqual(tokenize(undefined), []);
  });
});

describe("createGsdCommand", () => {
  it("delegates authorization to the host via requireAuth and operator.write", () => {
    const definition = createGsdCommand({ config: { cliPath: "gsd" }, logger: silentLogger, getService: () => null });
    assert.equal(definition.name, "gsd");
    assert.equal(definition.acceptsArgs, true);
    assert.equal(definition.requireAuth, true);
    assert.deepEqual(definition.requiredScopes, ["operator.write"]);
  });
});

describe("register", () => {
  it("registers the tool and lifecycle hook in every registration mode", () => {
    const { api, commands, services, tools, lifecycles } = stubApi({}, "tool-discovery");
    register(api);
    assert.deepEqual(commands.map((c) => c.name), ["gsd"]);
    assert.deepEqual(services.map((s) => s.id), [PLUGIN_ID]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].opts?.name, "gsd_status");
    const made = (tools[0].tool as OpenClawPluginToolFactory)({});
    assert.equal((made as AnyAgentTool).name, "gsd_status");
    assert.equal(lifecycles.length, 1);
    assert.equal(lifecycles[0].id, PLUGIN_ID);
    // Cleanup before the service starts is a no-op, not a crash.
    lifecycles[0].cleanup?.({ reason: "restart" });
  });

  it("survives a host that lacks registerTool and lifecycle", () => {
    const { api } = stubApi();
    delete api.registerTool;
    delete api.lifecycle;
    register(api);
  });

  it("scopes lifecycle cleanup to the named session and stops everything when none is named", async () => {
    await withProject(async (root, project) => {
      const { api, commands, services, lifecycles } = stubApi({ defaultProject: project, cliPath: writeHangingCli(root) });
      register(api);
      await services[0].start({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
      const sessionKey = "agent:main:telegram:1";
      const untilGone = async () => {
        const deadline = Date.now() + 10_000;
        let cancel = await commands[0].handler(ctx({ args: "cancel" }));
        while (!/No active run/.test(cancel.text ?? "") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
          cancel = await commands[0].handler(ctx({ args: "cancel" }));
        }
        assert.match(cancel.text ?? "", /No active run/);
      };
      const started = await commands[0].handler(ctx({ args: "auto", sessionKey }));
      assert.match(started.text ?? "", /^Started gsd auto in `.*` \(run gsd-\d+\)\. Progress will be posted here\.$/);
      // Another conversation's /reset must not touch this run.
      await lifecycles[0].cleanup?.({ reason: "reset", sessionKey: "agent:main:telegram:2" });
      assert.match((await commands[0].handler(ctx({ args: "auto", sessionKey }))).text ?? "", /is already active/);
      await lifecycles[0].cleanup?.({ reason: "reset", sessionKey });
      await untilGone();
      assert.match((await commands[0].handler(ctx({ args: "auto", sessionKey }))).text ?? "", /^Started/);
      await lifecycles[0].cleanup?.({ reason: "restart" });
      await untilGone();
      await services[0].stop?.({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
    });
  });

  it("registers the /gsd command and one service whose start wires the bind store", async () => {
    await withProject(async (root, project) => {
      const { api, commands, services } = stubApi({ defaultProject: project });
      register(api);
      assert.deepEqual(commands.map((c) => c.name), ["gsd"]);
      assert.deepEqual(services.map((s) => s.id), [PLUGIN_ID]);

      // Before the service starts, commands answer with a not-ready message instead of failing.
      const early = await commands[0].handler(ctx({ args: "status" }));
      assert.match(early.text ?? "", /has not started/);

      await services[0].start({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
      const bound = await commands[0].handler(ctx({ args: `bind ${project}` }));
      assert.match(bound.text ?? "", /Bound this conversation/);
      const unbound = await commands[0].handler(ctx({ args: "unbind" }));
      assert.equal(unbound.text, "Binding removed.");
      await services[0].stop?.({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
    });
  });
});

describe("handleGsdCommand", () => {
  function deps(service: ServiceState | null, defaultProject?: string) {
    return { config: { cliPath: "gsd", defaultProject }, logger: silentLogger, getService: () => service };
  }

  function service(root: string, exec: ExecFn, spawn = fakeSpawn().spawn): ServiceState {
    return {
      bindStore: new BindStore(join(root, "bindings.json")),
      cli: new GsdCli("gsd", exec),
      supervisor: new Supervisor({ cliPath: "/opt/gsd", logger: silentLogger, onEvent() {}, spawn }),
      notifier: { send() {} } as unknown as Notifier,
    };
  }

  const okExec: ExecFn = async () => ({ stdout: PROGRESS_ENVELOPE, stderr: "" });

  it("prints help for no subcommand and for unknown subcommands", async () => {
    assert.equal((await handleGsdCommand(deps(null), ctx())).text, HELP_TEXT);
    assert.match((await handleGsdCommand(deps(null), ctx({ args: "frobnicate" }))).text ?? "", /Unknown subcommand `frobnicate`/);
  });

  it("status fails closed with guidance when nothing is bound", async () => {
    await withProject(async (root) => {
      const result = await handleGsdCommand(deps(service(root, async () => ({ stdout: PROGRESS_ENVELOPE, stderr: "" }))), ctx({ args: "status" }));
      assert.match(result.text ?? "", /No GSD project bound/);
    });
  });

  it("status renders the snapshot for the bound project", async () => {
    await withProject(async (root, project) => {
      const seen: string[][] = [];
      const svc = service(root, async (_file, args) => {
        seen.push(args);
        return { stdout: PROGRESS_ENVELOPE, stderr: "" };
      });
      await handleGsdCommand(deps(svc), ctx({ args: `bind ${project}` }));
      const result = await handleGsdCommand(deps(svc), ctx({ args: "status" }));
      assert.deepEqual(seen, [["read", "progress", "--json", "--project", project]]);
      assert.match(result.text ?? "", /Active milestone: M001: Hermes Integration/);
      assert.match(result.text ?? "", /Project: `/);
    });
  });

  it("status uses defaultProject when the conversation is unbound and an explicit path when given", async () => {
    await withProject(async (root, project) => {
      const seen: string[][] = [];
      const svc = service(root, async (_file, args) => {
        seen.push(args);
        return { stdout: PROGRESS_ENVELOPE, stderr: "" };
      });
      await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      await handleGsdCommand(deps(svc), ctx({ args: `status ${project}` }));
      assert.equal(seen.length, 2);
      assert.equal(seen[0][4], project);
      assert.equal(seen[1][4], project);
    });
  });

  it("status reports read failures without leaking a stack", async () => {
    await withProject(async (root, project) => {
      const svc = service(root, async () => {
        throw new Error("unsupported gsd read envelope version 2 (expected 1)");
      });
      const result = await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      assert.equal(result.text, "GSD status unavailable: unsupported gsd read envelope version 2 (expected 1)\nRun: none");
    });
  });

  it("auto spawns a supervised run for the resolved project and refuses a second one", async () => {
    await withProject(async (root, project) => {
      const fake = fakeSpawn();
      const svc = service(root, okExec, fake.spawn);
      const started = await handleGsdCommand(deps(svc, project), ctx({ args: "auto --model claude-sonnet-4.5", sessionKey: "agent:main:telegram:1" }));
      assert.equal(started.text, `Started gsd auto in \`${project}\` (run gsd-4242). Progress will be posted here.`);
      assert.equal(fake.spawned.length, 1);
      assert.equal(fake.spawned[0].file, "/opt/gsd");
      assert.equal(fake.spawned[0].cwd, project);
      assert.deepEqual(fake.spawned[0].args, ["headless", "auto", "--supervised", "--output-format", "stream-json", "--max-restarts", "0", "--timeout", "0", "--response-timeout", "86400000", "--model", "claude-sonnet-4.5"]);
      assert.equal(svc.supervisor.get(project)?.sessionKey, "agent:main:telegram:1");
      const second = await handleGsdCommand(deps(svc, project), ctx({ args: "auto" }));
      assert.equal(second.text, `Run gsd-4242 (pid 4242) is already active for ${project}; /gsd cancel first`);
      const status = await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      assert.match(status.text ?? "", /\nRun: gsd-4242 running since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(auto\)$/);
      const cancelled = await handleGsdCommand(deps(svc, project), ctx({ args: "cancel" }));
      assert.equal(cancelled.text, `Cancelling run gsd-4242 in \`${project}\`.`);
      assert.deepEqual(fake.spawned[0].kills, ["SIGTERM"]);
      const after = await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      assert.match(after.text ?? "", /\nRun: GSD auto in `.*` \(run gsd-4242\) cancelled \(signal SIGTERM\)\.$/);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: "cancel" }))).text ?? "", /No active run/);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: "auto a b" }))).text ?? "", /Usage/);
    });
  });

  it("passes quick and new-milestone text as a single argument and chains --auto", async () => {
    await withProject(async (root, project) => {
      const fake = fakeSpawn();
      const svc = service(root, okExec, fake.spawn);
      await handleGsdCommand(deps(svc, project), ctx({ args: 'quick add a "hello" banner to the page' }));
      assert.deepEqual(fake.spawned[0].args.slice(0, 3), ["headless", "quick", 'add a "hello" banner to the page']);
      svc.supervisor.cancel(project);
      await handleGsdCommand(deps(svc, project), ctx({ args: "new-milestone Build the billing flow --auto" }));
      assert.deepEqual(fake.spawned[1].args.slice(0, 2), ["headless", "new-milestone"]);
      assert.deepEqual(fake.spawned[1].args.slice(-3), ["--context-text", "Build the billing flow", "--auto"]);
      svc.supervisor.cancel(project);
      const brief = join(root, "brief.md");
      writeFileSync(brief, "# brief");
      await handleGsdCommand(deps(svc, project), ctx({ args: `new-milestone --file ${brief}` }));
      assert.deepEqual(fake.spawned[2].args.slice(-2), ["--context", brief]);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: "quick" }))).text ?? "", /Usage/);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: "new-milestone" }))).text ?? "", /Usage/);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: `new-milestone text --file ${brief}` }))).text ?? "", /either a brief or/);
      assert.equal(fake.spawned.length, 3);
    });
  });

  it("rejects flag injection and invalid --model / --file values before spawning", async () => {
    await withProject(async (root, project) => {
      const fake = fakeSpawn();
      const svc = service(root, okExec, fake.spawn);
      const attempts = [
        ["quick --answers /etc/passwd", /Option `--answers` is not allowed here\./],
        ['quick "--answers /etc/passwd"', /Option `--answers \/etc\/passwd` is not allowed here/],
        ["quick fix it --events all", /Option `--events` is not allowed/],
        ["quick -v", /Option `-v` is not allowed/],
        ["new-milestone brief --resume x", /Option `--resume` is not allowed here \(allowed: --file, --auto\)/],
        ["new-milestone --model m brief", /Option `--model` is not allowed/],
        ["auto --auto", /Option `--auto` is not allowed here \(allowed: --model\)/],
        ["auto --model", /`--model` needs a model id/],
        ["auto --model 'bad id'", /`--model` needs a model id/],
        ["auto --model a;b", /`--model` needs a model id/],
        ["new-milestone --file relative.md", /`--file` needs an absolute path/],
        [`new-milestone --file ${join(root, "missing.md")}`, /does not exist/],
        [`new-milestone --file ${root}`, /is not a regular file/],
      ] as const;
      for (const [args, expected] of attempts) {
        const result = await handleGsdCommand(deps(svc, project), ctx({ args }));
        assert.match(result.text ?? "", expected, args);
      }
      assert.equal(fake.spawned.length, 0);
    });
  });

  it("reply and cancel report the missing run, route, or text", async () => {
    await withProject(async (root, project) => {
      const svc = service(root, okExec);
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ args: "reply" }))).text ?? "", /Usage/);
      assert.equal((await handleGsdCommand(deps(svc, project), ctx({ args: "reply 1" }))).text, `No active run for ${project}`);
      assert.equal((await handleGsdCommand(deps(svc), ctx({ args: "cancel" }))).text, "No GSD project bound. Use `/gsd bind <absolute path>` or set `plugins.entries.open-gsd-openclaw.config.defaultProject`.");
      assert.match((await handleGsdCommand(deps(svc, project), ctx({ to: undefined, args: "auto" }))).text ?? "", /no stable route/);
      assert.match((await handleGsdCommand(deps(null, project), ctx({ args: "auto" }))).text ?? "", /has not started/);
    });
  });

  it("reply reaches the run this conversation started with an explicit path", async () => {
    await withProject(async (root, project) => {
      const fake = fakeSpawn();
      const svc = service(root, okExec, fake.spawn);
      const started = await handleGsdCommand(deps(svc), ctx({ to: "-100555", args: `auto ${project}` }));
      assert.match(started.text ?? "", /^Started gsd auto/);
      fake.spawned[0].stdout.write(JSON.stringify({ type: "extension_ui_request", id: "q1", method: "select", title: "Pick a slice", options: ["S01 Gateway", "S02 Tools"] }) + "\n");
      await new Promise((r) => setImmediate(r));
      assert.equal(svc.supervisor.get(project)?.status, "blocked");
      // A different, unbound conversation still fails closed.
      assert.equal((await handleGsdCommand(deps(svc), ctx({ to: "-100999", args: "reply 1" }))).text, "No GSD project bound. Use `/gsd bind <absolute path>` or set `plugins.entries.open-gsd-openclaw.config.defaultProject`.");
      assert.equal((await handleGsdCommand(deps(svc), ctx({ to: "-100555", args: "reply 1" }))).text, 'Chose "S01 Gateway" for "Pick a slice"');
      svc.supervisor.cancel(project);
    });
  });

  it("bind validates the path and keys the binding by conversation route", async () => {
    await withProject(async (root, project) => {
      const svc = service(root, async () => ({ stdout: PROGRESS_ENVELOPE, stderr: "" }));
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "bind" }))).text ?? "", /Usage/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "bind relative" }))).text ?? "", /must be absolute/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: `bind ${root}` }))).text ?? "", /not a GSD project/);
      await handleGsdCommand(deps(svc), ctx({ args: `bind ${project}` }));
      assert.equal(svc.bindStore.get("telegram||-100123|"), project);
      // A different conversation on the same channel sees no binding.
      assert.match((await handleGsdCommand(deps(svc), ctx({ to: "-100999", args: "status" }))).text ?? "", /No GSD project bound/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "unbind" }))).text ?? "", /Binding removed/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "unbind" }))).text ?? "", /has no binding/);
    });
  });
});
