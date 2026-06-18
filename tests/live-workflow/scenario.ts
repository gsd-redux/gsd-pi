/**
 * Live-workflow scenario runner.
 *
 * Each scenario seeds an isolated project, dispatches one real workflow Unit,
 * and asserts durable outcomes. Scenario files stay small: they describe the
 * seed and proof, while this module owns the shared live-run interface.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { artifactsFor, createTmpProject, type TmpProject } from "../e2e/_shared/index.ts";
import {
  credentialNames,
  hasUsableCredentials,
  liveEnv,
  normalizeLiveWorkflowModel,
  runStreaming,
  runVerification,
} from "./harness.ts";

export interface LiveWorkflowScenario {
  slug: string;
  skipReason?: string | null;
  seed(project: TmpProject): LiveWorkflowSeed;
  dispatch?: {
    command?: "next";
    timeoutMs?: number;
    maxRestarts?: number;
  };
  expect?: {
    verification?: readonly string[];
    commits?: "increased" | "unchanged" | "any";
    toolEvents?: "required" | "optional";
    toolNames?: readonly string[];
  };
}

export interface LiveWorkflowSeed {
  verifyArgv?: readonly string[];
}

export interface LiveWorkflowRunResult {
  project: TmpProject;
  artifactsDir: string;
  transcript: string;
  stdout: string;
  stderr: string;
  events: readonly Record<string, unknown>[];
}

type LiveWorkflowOutputFormat = "text" | "stream-json";

function skip(reason: string): never {
  console.log(`SKIPPED: ${reason}`);
  process.exit(77);
}

function resolveOutputFormat(): LiveWorkflowOutputFormat {
  return process.env.GSD_LIVE_WORKFLOW_OUTPUT?.trim() === "stream-json" ? "stream-json" : "text";
}

function resolveTimeoutMs(scenario: LiveWorkflowScenario): number {
  return scenario.dispatch?.timeoutMs ?? Number(process.env.GSD_LIVE_WORKFLOW_TIMEOUT_MS ?? 300_000);
}

function parseJsonEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Text-mode output and progress preambles are intentionally ignored.
    }
  }
  return events;
}

function collectToolNames(events: readonly Record<string, unknown>[]): string[] {
  return events
    .filter((event) => event.type === "tool_execution_start")
    .map((event) => String(event.toolName ?? ""))
    .filter(Boolean);
}

function assertToolEvents(events: readonly Record<string, unknown>[]): void {
  assert.ok(
    events.some((event) => event.type === "tool_execution_start"),
    "expected stream-json output to include at least one tool_execution_start event",
  );
  assert.ok(
    events.some((event) => event.type === "tool_execution_end"),
    "expected stream-json output to include at least one tool_execution_end event",
  );
}

function assertToolNames(events: readonly Record<string, unknown>[], expectedNames: readonly string[]): void {
  const seen = collectToolNames(events);
  for (const expected of expectedNames) {
    assert.ok(seen.includes(expected), `expected live run to call ${expected}; saw: ${seen.join(", ") || "(none)"}`);
  }
}

export async function runLiveWorkflowScenario(scenario: LiveWorkflowScenario): Promise<LiveWorkflowRunResult> {
  if (process.env.GSD_LIVE_TESTS !== "1") skip("set GSD_LIVE_TESTS=1 to enable");
  if (scenario.skipReason) skip(scenario.skipReason);
  if (!hasUsableCredentials()) {
    skip("no provider credentials in env (export a *_API_KEY or *_OAUTH_TOKEN)");
  }
  console.log(`Credentials: ${credentialNames().join(", ")}`);

  const project = createTmpProject({ git: true });
  const artifacts = artifactsFor(scenario.slug);

  try {
    const seed = scenario.seed(project);
    const verifyArgv = scenario.expect?.verification ?? seed.verifyArgv;

    if (verifyArgv) {
      const before = runVerification(project, [...verifyArgv]);
      assert.equal(before.ok, false, `fixture should fail before the agent runs, but it passed:\n${before.output}`);
    }

    const commitsBefore = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: project.dir, encoding: "utf8" }).trim(),
    );

    const requestedModel = process.env.GSD_LIVE_WORKFLOW_MODEL?.trim();
    const model = normalizeLiveWorkflowModel(requestedModel);
    const timeoutMs = resolveTimeoutMs(scenario);
    const outputFormat = resolveOutputFormat();
    const dispatchArgs = [
      "headless",
      "--output-format",
      outputFormat,
      ...(outputFormat === "text" ? ["--verbose"] : []),
      "--timeout",
      String(timeoutMs),
      "--max-restarts",
      String(scenario.dispatch?.maxRestarts ?? 0),
      ...(model ? ["--model", model] : []),
      scenario.dispatch?.command ?? "next",
    ];

    if (requestedModel && model !== requestedModel) {
      console.log(`Model alias: ${requestedModel} -> ${model}`);
    }
    console.log(`Running: gsd ${dispatchArgs.join(" ")}${model ? "" : " (model auto-resolved from available credentials)"}`);
    console.log("─── live transcript ─────────────────────────────────────────");
    const result = await runStreaming(dispatchArgs, {
      cwd: project.dir,
      timeoutMs: timeoutMs + 30_000,
      env: liveEnv(),
    });
    console.log("─── end transcript ──────────────────────────────────────────");

    const transcript = [result.stdoutClean, result.stderrClean].filter((s) => s.trim()).join("\n");
    const events = parseJsonEvents(result.stdout);
    artifacts.write("transcript.txt", transcript);
    artifacts.write("dispatch.stdout.log", result.stdout);
    artifacts.write("dispatch.stderr.log", result.stderr);
    if (events.length > 0) artifacts.write("dispatch.events.json", `${JSON.stringify(events, null, 2)}\n`);
    console.log(`exit code: ${result.code} (0=success, 10=blocked, 1=error/timeout, 11=cancelled)`);
    console.log(`transcript: ${artifacts.dir}/transcript.txt`);

    assert.ok(!result.timedOut, "unit dispatch hit the harness timeout — raise GSD_LIVE_WORKFLOW_TIMEOUT_MS");
    assert.equal(
      result.code,
      0,
      `expected the dispatched unit to complete (exit 0), got ${result.code}. See ${artifacts.dir}/transcript.txt`,
    );
    assert.ok(transcript.trim().length > 0 || events.length > 0, "expected the unit dispatch to produce output");

    if (verifyArgv) {
      const after = runVerification(project, [...verifyArgv]);
      assert.ok(after.ok, `verification still fails — the agent did not complete the task:\n${after.output}`);
    }

    const commitsAfter = Number(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: project.dir, encoding: "utf8" }).trim(),
    );
    if ((scenario.expect?.commits ?? "increased") === "increased") {
      assert.ok(
        commitsAfter > commitsBefore,
        `expected the agent to add at least one commit (before=${commitsBefore}, after=${commitsAfter})`,
      );
    } else if (scenario.expect?.commits === "unchanged") {
      assert.equal(commitsAfter, commitsBefore, "expected the scenario to leave git history unchanged");
    }

    if (scenario.expect?.toolEvents === "required") {
      assertToolEvents(events);
    }

    if (scenario.expect?.toolNames?.length) {
      assertToolNames(events, scenario.expect.toolNames);
    }

    return {
      project,
      artifactsDir: artifacts.dir,
      transcript,
      stdout: result.stdout,
      stderr: result.stderr,
      events,
    };
  } catch (err) {
    project.cleanup();
    throw err;
  }
}
