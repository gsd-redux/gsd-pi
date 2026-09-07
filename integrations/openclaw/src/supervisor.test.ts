import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Route } from "./binding.js";
import { SECRET_PROMPT_NOTICE, Supervisor, describeRun, formatEvent, type ChildLike, type SupervisorEvent } from "./supervisor.js";

const route: Route = { channel: "telegram", conversationId: "telegram:1" };
const logs: string[] = [];
const logger = { debug() {}, info() {}, warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) };

/**
 * Fake gsd: a real node process. Reads `scenario.json` from cwd, records its
 * argv, prints the scripted lines, optionally waits for one stdin line (which
 * it appends to `replies.jsonl`), then writes `headless_result` as its last
 * line and exits with the scripted code.
 */
const FAKE_GSD = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scenario.json"), "utf8"));
fs.writeFileSync(path.join(process.cwd(), "argv.json"), JSON.stringify(process.argv.slice(2)));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
for (const l of s.lines ?? []) out(l);
if (s.stderr) process.stderr.write(s.stderr);
const finish = () => {
  const line = JSON.stringify({ type: "headless_result", exitCode: s.exitCode ?? 0, status: s.status ?? "success" }) + "\\n";
  process.stdout.write(line, () => process.exit(s.exitCode ?? 0));
};
if (s.hang) {
  process.on("SIGTERM", () => process.exit(11));
  setInterval(() => {}, 1000);
} else if (s.waitForStdin) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    const i = buf.indexOf("\\n");
    if (i < 0) return;
    fs.appendFileSync(path.join(process.cwd(), "replies.jsonl"), buf.slice(0, i + 1));
    for (const l of s.after ?? []) out(l);
    finish();
  });
} else {
  finish();
}
`;

interface Scenario {
  lines?: unknown[];
  after?: unknown[];
  waitForStdin?: boolean;
  hang?: boolean;
  exitCode?: number;
  status?: string;
  stderr?: string;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "open-gsd-supervisor-"));
  const cliPath = join(root, "fake-gsd");
  writeFileSync(cliPath, FAKE_GSD);
  chmodSync(cliPath, 0o755);
  const project = join(root, "project");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  const events: SupervisorEvent[] = [];
  const supervisor = new Supervisor({ cliPath, logger, onEvent: (e) => void events.push(e), now: () => 1_700_000_000_000 });
  const scenario = (s: Scenario) => writeFileSync(join(project, "scenario.json"), JSON.stringify(s));
  const start = (command: "auto" | "new-milestone" | "quick" = "auto", commandArgs: string[] = [], extraFlags: string[] = []) =>
    supervisor.start({ projectDir: project, command, commandArgs, extraFlags, route, sessionKey: "agent:main:telegram:1" });
  const waitFor = async <T extends SupervisorEvent["type"]>(type: T, after = 0): Promise<Extract<SupervisorEvent, { type: T }>> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = events.slice(after).find((e) => e.type === type);
      if (found) return found as Extract<SupervisorEvent, { type: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} event; saw ${events.map((e) => e.type).join(",")}`);
  };
  const replies = () =>
    readFileSync(join(project, "replies.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const argv = () => JSON.parse(readFileSync(join(project, "argv.json"), "utf8")) as string[];
  const lock = join(project, ".gsd", "runtime", "openclaw-run.json");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cliPath, project, events, supervisor, scenario, start, waitFor, replies, argv, lock, cleanup };
}

const select = { type: "extension_ui_request", id: "q1", method: "select", title: "Pick a slice", options: ["S01 Gateway", "S02 Tools"] };

describe("Supervisor", () => {
  it("spawns gsd headless with the supervised flags, records the lockfile, and finalizes on close with the result line", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [{ type: "extensions_ready" }, "not-an-object"], status: "success", exitCode: 0 });
      const started = h.start("auto", [], ["--model", "gpt-x"]);
      assert.ok(started.ok, JSON.stringify(started));
      const run = started.run;
      assert.match(run.runId, /^gsd-\d+$/);
      assert.equal(run.status, "running");
      assert.equal(h.supervisor.get(h.project), run);
      assert.deepEqual(h.supervisor.list(), [run]);
      assert.deepEqual(JSON.parse(readFileSync(h.lock, "utf8")), { pid: run.pid, runId: run.runId, startedAt: 1_700_000_000_000, command: "auto" });
      const finished = await h.waitFor("finished");
      assert.deepEqual(h.argv(), ["headless", "auto", "--supervised", "--output-format", "stream-json", "--max-restarts", "0", "--timeout", "0", "--response-timeout", "86400000", "--model", "gpt-x"]);
      assert.equal(finished.run.status, "complete");
      assert.equal(finished.run.exitCode, 0);
      assert.equal(finished.run.resultStatus, "success", "headless_result written right before exit is still seen");
      assert.match(finished.summary, /^GSD auto in `.*` \(run gsd-\d+\) complete \(exit 0\)\.$/);
      assert.equal(h.supervisor.get(h.project), undefined);
      assert.equal(h.supervisor.lastFinished(h.project), finished.run);
      assert.equal(existsSync(h.lock), false);
      assert.equal(describeRun(finished.run), `Run: ${finished.summary}`);
    } finally {
      h.cleanup();
    }
  });

  it("refuses to start while a live lockfile pid exists and cleans a stale one", async () => {
    const h = harness();
    try {
      mkdirSync(join(h.project, ".gsd", "runtime"), { recursive: true });
      writeFileSync(h.lock, JSON.stringify({ pid: process.pid, runId: "gsd-live", startedAt: Date.now(), command: "auto" }));
      h.scenario({});
      const refused = h.start();
      assert.deepEqual(refused, { ok: false, error: `Run gsd-live (pid ${process.pid}) is already active for ${h.project}; /gsd cancel first` });

      const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
      writeFileSync(h.lock, JSON.stringify({ pid: dead, runId: "gsd-stale", startedAt: 1, command: "auto" }));
      const started = h.start();
      assert.ok(started.ok);
      await h.waitFor("finished");

      writeFileSync(h.lock, "{malformed");
      const again = h.start();
      assert.ok(again.ok);
      const second = h.start();
      assert.equal(second.ok, false);
      assert.match((second as { error: string }).error, /already active/);
      await h.waitFor("finished", h.events.length);
    } finally {
      h.cleanup();
    }
  });

  it("ignores a lockfile written before the current boot even when its pid is alive", async () => {
    const h = harness();
    try {
      mkdirSync(join(h.project, ".gsd", "runtime"), { recursive: true });
      const preBoot = JSON.stringify({ pid: process.pid, runId: "gsd-reused-pid", startedAt: 1, command: "auto" });
      writeFileSync(h.lock, preBoot);
      // cancel must not SIGTERM the unrelated live process (this test runner).
      assert.deepEqual(h.supervisor.cancel(h.project), { ok: false, error: `No active run for ${h.project}` });
      assert.equal(existsSync(h.lock), false);
      writeFileSync(h.lock, preBoot);
      h.scenario({});
      const started = h.start();
      assert.ok(started.ok, JSON.stringify(started));
      await h.waitFor("finished");
    } finally {
      h.cleanup();
    }
  });

  it("parks on a select request, forwards a numbered reply, and finishes", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [select], waitForStdin: true, after: [{ type: "extension_ui_request", id: "n1", method: "notify", message: "done" }] });
      const started = h.start("quick", ["add a banner"]);
      assert.ok(started.ok);
      const blocked = await h.waitFor("blocked");
      assert.equal(blocked.blocker.title, "Pick a slice");
      assert.equal(started.run.status, "blocked");
      assert.match(describeRun(started.run), /^Waiting for input: Pick a slice — reply with \/gsd reply <n or text>$/);
      assert.deepEqual(h.supervisor.reply(h.project, "3"), { ok: false, error: "Reply with a number (1-2) or an option name:\n1. S01 Gateway\n2. S02 Tools" });
      assert.deepEqual(h.supervisor.reply(h.project, "2"), { ok: true, text: 'Chose "S02 Tools" for "Pick a slice"' });
      assert.equal(started.run.status, "running");
      assert.equal(started.run.blocker, undefined);
      assert.deepEqual(h.supervisor.reply(h.project, "1"), { ok: false, error: `No pending question for ${h.project}` });
      const finished = await h.waitFor("finished");
      assert.deepEqual(h.replies(), [{ type: "extension_ui_response", id: "q1", value: "S02 Tools" }]);
      assert.equal(h.argv()[2], "add a banner");
      assert.ok(h.events.some((e) => e.type === "notice" && e.text === "done"));
      assert.equal(finished.run.status, "complete");
    } finally {
      h.cleanup();
    }
  });

  it("accepts option names case-insensitively and the literal cancel", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [select], waitForStdin: true });
      h.start();
      await h.waitFor("blocked");
      assert.equal(h.supervisor.reply(h.project, "s01 gateway").ok, true);
      await h.waitFor("finished");
      assert.deepEqual(h.replies()[0], { type: "extension_ui_response", id: "q1", value: "S01 Gateway" });

      h.events.length = 0;
      h.scenario({ lines: [{ type: "extension_ui_request", id: "e1", method: "editor", title: "Edit brief", prefill: "x" }], waitForStdin: true });
      h.start();
      await h.waitFor("blocked");
      assert.deepEqual(h.supervisor.reply(h.project, "cancel"), { ok: true, text: 'Cancelled "Edit brief"' });
      await h.waitFor("finished");
      assert.deepEqual(h.replies().at(-1), { type: "extension_ui_response", id: "e1", cancelled: true });
    } finally {
      h.cleanup();
    }
  });

  it("maps confirm replies to confirmed true/false and rejects anything else", async () => {
    const h = harness();
    try {
      const confirm = { type: "extension_ui_request", id: "c1", method: "confirm", title: "Proceed?", message: "This edits files" };
      h.scenario({ lines: [confirm], waitForStdin: true });
      h.start();
      await h.waitFor("blocked");
      assert.deepEqual(h.supervisor.reply(h.project, "maybe"), { ok: false, error: 'Reply yes or no to "Proceed?"' });
      assert.deepEqual(h.supervisor.reply(h.project, "Y"), { ok: true, text: 'Answered yes to "Proceed?"' });
      await h.waitFor("finished");
      assert.deepEqual(h.replies()[0], { type: "extension_ui_response", id: "c1", confirmed: true });

      h.events.length = 0;
      h.scenario({ lines: [confirm], waitForStdin: true });
      h.start();
      await h.waitFor("blocked");
      assert.equal(h.supervisor.reply(h.project, "no").ok, true);
      await h.waitFor("finished");
      assert.deepEqual(h.replies().at(-1), { type: "extension_ui_response", id: "c1", confirmed: false });
    } finally {
      h.cleanup();
    }
  });

  it("cancels a secure input locally and never emits it as blocked", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [{ type: "extension_ui_request", id: "s1", method: "input", title: "API key", secure: true }], waitForStdin: true });
      const started = h.start();
      assert.ok(started.ok);
      const notice = await h.waitFor("notice");
      assert.equal(notice.text, SECRET_PROMPT_NOTICE);
      const finished = await h.waitFor("finished");
      assert.ok(!h.events.some((e) => e.type === "blocked"));
      assert.deepEqual(h.replies(), [{ type: "extension_ui_response", id: "s1", cancelled: true }]);
      assert.equal(finished.run.status, "complete");
    } finally {
      h.cleanup();
    }
  });

  it("forwards plain input verbatim", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [{ type: "extension_ui_request", id: "i1", method: "input", title: "Name", placeholder: "e.g. foo" }], waitForStdin: true });
      h.start();
      const blocked = await h.waitFor("blocked");
      assert.equal(blocked.blocker.placeholder, "e.g. foo");
      assert.equal(h.supervisor.reply(h.project, "  Foo Bar ").ok, true);
      await h.waitFor("finished");
      assert.deepEqual(h.replies()[0], { type: "extension_ui_response", id: "i1", value: "  Foo Bar " });
    } finally {
      h.cleanup();
    }
  });

  it("SIGTERMs on cancel and reports cancelled; a second start is then allowed", async () => {
    const h = harness();
    try {
      h.scenario({ hang: true });
      const started = h.start();
      assert.ok(started.ok);
      assert.equal(h.supervisor.cancel(join(h.root, "other")).ok, false);
      const cancel = h.supervisor.cancel(h.project);
      assert.deepEqual(cancel, { ok: true, runId: started.run.runId });
      assert.equal(started.run.status, "cancelling");
      const finished = await h.waitFor("finished");
      assert.equal(finished.run.status, "cancelled");
      assert.match(finished.summary, /cancelled \((exit 11|signal SIGTERM)\)/, "exit 11 when the handler ran, the raw signal when SIGTERM landed first");
      assert.equal(existsSync(h.lock), false);
    } finally {
      h.cleanup();
    }
  });

  it("reports a failure with the redacted stderr tail", async () => {
    const h = harness();
    try {
      const key = ["sk", "live", "abcdefghijklmnop"].join("-");
      h.scenario({ exitCode: 1, status: "error", stderr: `boom OPENAI_API_KEY=${key} end\n` });
      h.start("new-milestone", [], ["--context-text", "brief"]);
      const finished = await h.waitFor("finished");
      assert.equal(finished.run.status, "failed");
      assert.match(finished.summary, /failed \(exit 1\)\. stderr: boom OPENAI_API_KEY=\[redacted\] end$/);
      assert.ok(!finished.summary.includes(key));
    } finally {
      h.cleanup();
    }
  });

  it("marks exit 10 complete with the blocked note", async () => {
    const h = harness();
    try {
      h.scenario({ exitCode: 10, status: "blocked" });
      h.start();
      const finished = await h.waitFor("finished");
      assert.equal(finished.run.status, "complete");
      assert.match(finished.summary, /complete \(exit 10, blocked\)/);
    } finally {
      h.cleanup();
    }
  });

  it("evicts the run and reports the cliPath when the binary cannot be spawned", async () => {
    const h = harness();
    try {
      const missing = join(h.root, "missing-gsd");
      const supervisor = new Supervisor({ cliPath: missing, logger, onEvent: (e) => void h.events.push(e) });
      const started = supervisor.start({ projectDir: h.project, command: "auto", commandArgs: [], extraFlags: [], route });
      assert.ok(started.ok);
      assert.equal(started.run.status, "starting");
      const finished = await h.waitFor("finished");
      assert.equal(finished.run.status, "failed");
      assert.equal(finished.summary, `gsd CLI not found at "${missing}"; set plugins.entries.open-gsd-openclaw.config.cliPath`);
      assert.equal(supervisor.get(h.project), undefined);
      assert.equal(existsSync(h.lock), false);
    } finally {
      h.cleanup();
    }
  });

  it("dedupes consecutive identical notify messages", async () => {
    const h = harness();
    try {
      const notify = (message: string, id: string) => ({ type: "extension_ui_request", id, method: "notify", message });
      h.scenario({ lines: [notify("a", "1"), notify("a", "2"), notify("b", "3"), notify("a", "4"), { type: "extension_ui_request", id: "5", method: "setStatus", statusKey: "x" }] });
      h.start();
      await h.waitFor("finished");
      assert.deepEqual(h.events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text), ["a", "b", "a"]);
    } finally {
      h.cleanup();
    }
  });

  it("clears the blocker on supervised_timeout", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [select, { type: "supervised_timeout", id: "q1", method: "select" }] });
      const started = h.start();
      assert.ok(started.ok);
      await h.waitFor("blocked");
      const notice = await h.waitFor("notice");
      assert.equal(notice.text, "GSD answered select itself after the response timeout.");
      assert.equal(notice.run.blocker, undefined);
      await h.waitFor("finished");
    } finally {
      h.cleanup();
    }
  });

  it("answers reply and cancel with an error once the child is gone", async () => {
    const h = harness();
    try {
      h.scenario({ lines: [select], waitForStdin: true });
      const started = h.start();
      assert.ok(started.ok);
      await h.waitFor("blocked");
      process.kill(started.run.pid!, "SIGKILL");
      const finished = await h.waitFor("finished");
      assert.equal(finished.run.status, "failed");
      assert.match(finished.summary, /signal SIGKILL/);
      assert.deepEqual(h.supervisor.reply(h.project, "1"), { ok: false, error: `No active run for ${h.project}` });
      assert.deepEqual(h.supervisor.cancel(h.project), { ok: false, error: `No active run for ${h.project}` });
    } finally {
      h.cleanup();
    }
  });

  it("stopAll SIGTERMs every active child", async () => {
    const h = harness();
    try {
      const second = join(h.root, "second");
      mkdirSync(join(second, ".gsd"), { recursive: true });
      writeFileSync(join(second, "scenario.json"), JSON.stringify({ hang: true }));
      h.scenario({ hang: true });
      assert.ok(h.start().ok);
      assert.ok(h.supervisor.start({ projectDir: second, command: "auto", commandArgs: [], extraFlags: [], route }).ok);
      assert.equal(h.supervisor.list().length, 2);
      h.supervisor.stopAll();
      await h.waitFor("finished");
      await h.waitFor("finished", h.events.findIndex((e) => e.type === "finished") + 1);
      assert.deepEqual(h.supervisor.list(), []);
      assert.ok(h.events.filter((e) => e.type === "finished").every((e) => e.run.status === "cancelled"));
    } finally {
      h.cleanup();
    }
  });
});

/** In-memory child for stdin edge cases that a real process cannot trigger deterministically. */
function fakeChild(pid = 4242) {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const stdinEmitter = new EventEmitter();
  const stdin = {
    writable: true,
    destroyed: false,
    write(chunk: string, cb?: (err?: Error | null) => void) {
      writes.push(chunk);
      cb?.(null);
      return true;
    },
    on: (event: "error", cb: (err: Error) => void) => stdinEmitter.on(event, cb),
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ChildLike = {
    pid,
    stdin,
    stdout,
    stderr,
    on: emitter.on.bind(emitter) as ChildLike["on"],
    kill: () => {
      emitter.emit("exit", null, "SIGTERM");
      emitter.emit("close", null, "SIGTERM");
      return true;
    },
  };
  return { child, writes, stdin, stdout, stderr, emitter, stdinEmitter };
}

describe("Supervisor stdin guards", () => {
  it("refuses to write to a dead stdin and marks the run failed on a stdin error", () => {
    const root = mkdtempSync(join(tmpdir(), "open-gsd-supervisor-"));
    try {
      mkdirSync(join(root, ".gsd"), { recursive: true });
      const fake = fakeChild();
      const events: SupervisorEvent[] = [];
      const supervisor = new Supervisor({ cliPath: "gsd", logger, onEvent: (e) => void events.push(e), spawn: () => fake.child });
      const started = supervisor.start({ projectDir: root, command: "auto", commandArgs: [], extraFlags: [], route });
      assert.ok(started.ok);
      fake.stdout.write(JSON.stringify(select) + "\n");
      assert.equal(events[0]?.type, "blocked");
      fake.stdin.writable = false;
      assert.deepEqual(supervisor.reply(root, "1"), { ok: false, error: "Run gsd-4242 is no longer accepting input" });
      assert.equal(started.run.status, "blocked", "the question stays pending");
      fake.stdin.writable = true;
      logs.length = 0;
      fake.stdinEmitter.emit("error", new Error("EPIPE"));
      assert.equal(started.run.status, "failed");
      assert.match(logs[0], /stdin write failed: EPIPE/);
      fake.emitter.emit("exit", 1, null);
      fake.emitter.emit("close", 1, null);
      assert.equal(events.at(-1)?.type, "finished");
      assert.equal(started.run.status, "failed");
      assert.match((events.at(-1) as { summary: string }).summary, /failed \(exit 1\)\. stdin: EPIPE$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Supervisor stream and child errors", () => {
  it("survives stdout/stderr stream errors and a child error after spawn, finalizing on close", () => {
    const root = mkdtempSync(join(tmpdir(), "open-gsd-supervisor-"));
    try {
      mkdirSync(join(root, ".gsd"), { recursive: true });
      const fake = fakeChild();
      const events: SupervisorEvent[] = [];
      const supervisor = new Supervisor({ cliPath: "gsd", logger, onEvent: (e) => void events.push(e), spawn: () => fake.child });
      const started = supervisor.start({ projectDir: root, command: "auto", commandArgs: [], extraFlags: [], route });
      assert.ok(started.ok);
      const lock = join(root, ".gsd", "runtime", "openclaw-run.json");
      logs.length = 0;
      fake.stdout.emit("error", new Error("EPIPE on stdout"));
      fake.stderr.emit("error", new Error("ECONNRESET on stderr"));
      // A live child's `error` (e.g. kill EPERM) is not a spawn failure: the run stays tracked and locked.
      fake.emitter.emit("error", new Error("kill EPERM"));
      assert.equal(started.run.status, "running");
      assert.equal(supervisor.get(root), started.run);
      assert.equal(existsSync(lock), true);
      assert.equal(events.length, 0);
      assert.match(logs[0], /stdout stream error: EPIPE on stdout/);
      assert.match(logs[1], /stderr stream error: ECONNRESET on stderr/);
      assert.match(logs[2], /child error: kill EPERM/);
      fake.emitter.emit("exit", 0, null);
      fake.emitter.emit("close", 0, null);
      assert.equal(events.at(-1)?.type, "finished");
      assert.equal(started.run.status, "complete");
      assert.equal(supervisor.get(root), undefined);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts the run when the child errors before it has a pid", () => {
    const fake = fakeChild(undefined as unknown as number);
    fake.child.pid = undefined;
    const events: SupervisorEvent[] = [];
    const supervisor = new Supervisor({ cliPath: "/nope/gsd", logger, onEvent: (e) => void events.push(e), spawn: () => fake.child });
    const started = supervisor.start({ projectDir: "/tmp/never-used", command: "auto", commandArgs: [], extraFlags: [], route });
    assert.ok(started.ok);
    fake.emitter.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    assert.equal(started.run.status, "failed");
    assert.equal(supervisor.get("/tmp/never-used"), undefined);
    assert.equal(events.at(-1)?.type, "finished");
  });
});

describe("formatEvent", () => {
  const run = { runId: "gsd-7", projectDir: "/p", command: "auto" as const, status: "blocked" as const, startedAt: 0, route };

  it("renders a multi-select question with the single-choice note", () => {
    const blocker = { id: "q", method: "select" as const, title: "Pick", message: "Choose wisely", options: ["a", "b"], allowMultiple: true };
    assert.equal(
      formatEvent({ type: "blocked", run, blocker }),
      ["**GSD needs input** (run gsd-7)", "Pick", "Choose wisely", "1. a", "2. b", "[Only one option can be chosen from chat.]", "Reply with `/gsd reply <number or text>`", "`/gsd reply cancel` skips the question."].join("\n"),
    );
  });

  it("renders confirm and input prompts and passes notices and summaries through", () => {
    assert.match(formatEvent({ type: "blocked", run, blocker: { id: "q", method: "confirm", title: "Go?" } }), /reply yes` or `\/gsd reply no`/);
    assert.match(formatEvent({ type: "blocked", run, blocker: { id: "q", method: "input", title: "Name", placeholder: "hint" } }), /\(hint\)\nReply with `\/gsd reply <text>`/);
    assert.equal(formatEvent({ type: "notice", run, text: "hi" }), "hi");
    assert.equal(formatEvent({ type: "finished", run, summary: "done" }), "done");
    assert.equal(describeRun(undefined), "Run: none");
    assert.equal(describeRun({ ...run, status: "running", startedAt: 1_700_000_000_000 }), "Run: gsd-7 running since 2023-11-14T22:13:20Z (auto)");
  });
});
