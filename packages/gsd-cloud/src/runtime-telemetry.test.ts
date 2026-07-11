// Project/App: Open GSD
// File Purpose: Contract tests for the token-free runtime telemetry consumed by desktop monitors.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clearRuntimeTelemetry, readRuntimeTelemetry, RuntimeTelemetryStore } from "./runtime-telemetry.js";

test("runtime telemetry persists connection state and traffic without credentials", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-telemetry-");
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
    runtimeName: "MacBook",
  });

    store.connecting();
    store.connected();
    store.received('{"type":"tool_call","requestId":"request-1"}');
    store.requestStarted({
      requestId: "request-1",
      projectAlias: "project-one",
      toolName: "gsd_status",
      receivedBytes: 48,
    });
    store.sent('{"type":"tool_result","requestId":"request-1","result":{}}');
    store.requestFinished({
      requestId: "request-1",
      projectAlias: "project-one",
      toolName: "gsd_status",
      durationMs: 25,
      outcome: "success",
    });
    await store.flush();

    const raw = readFileSync(telemetryPath, "utf8");
    const status = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(status.version, 1);
    assert.equal(status.state, "connected");
    assert.equal(status.gateway_url, "https://cloud.example.com");
    assert.equal(status.runtime_id, "runtime-1");
    assert.equal(status.runtime_name, "MacBook");
    assert.equal(status.connection_attempts, 1);
    assert.equal(status.received_messages, 1);
    assert.equal(status.sent_messages, 1);
    assert.equal(status.received_bytes, Buffer.byteLength('{"type":"tool_call","requestId":"request-1"}'));
    assert.equal(status.sent_bytes, Buffer.byteLength('{"type":"tool_result","requestId":"request-1","result":{}}'));
    assert.equal(status.active_requests, 0);
    assert.equal(raw.includes("device_token"), false);
    assert.equal(statSync(telemetryPath).mode & 0o777, 0o600);
});

test("runtime telemetry removes credentials from gateway metadata", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-gateway-metadata-");
  const telemetryPath = join(root, "cloud-runtime-status.json");

    const credentialed = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
      gatewayUrl: "https://user:password@cloud.example.com/runtime?access_token=secret#private",
    });
    await credentialed.flush();
    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as { gateway_url: string };
    assert.equal(status.gateway_url, "https://cloud.example.com/runtime");

    const malformed = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
      gatewayUrl: "not a URL?access_token=secret#private",
    });
    await malformed.flush();
    const raw = readFileSync(telemetryPath, "utf8");
    assert.equal((JSON.parse(raw) as { gateway_url: string }).gateway_url, "invalid gateway");
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("private"), false);

    const opaque = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
      gatewayUrl: "javascript:access_token=opaque-secret",
    });
    await opaque.flush();
    const opaqueRaw = readFileSync(telemetryPath, "utf8");
    assert.equal((JSON.parse(opaqueRaw) as { gateway_url: string }).gateway_url, "invalid gateway");
    assert.equal(opaqueRaw.includes("opaque-secret"), false);
});

test("runtime telemetry publishes idle liveness until the runtime stops", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-idle-liveness-");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });
  t.after(async () => {
    store.stopped();
    await store.flush();
  });

    store.connecting();
    store.connected();
    await store.flush();
    const initial = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
      updated_at: string;
      received_messages: number;
      sent_messages: number;
      recent_activity: unknown[];
    };

    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const idle = JSON.parse(readFileSync(telemetryPath, "utf8")) as typeof initial;
    assert.ok(new Date(idle.updated_at) > new Date(initial.updated_at));
    assert.equal(idle.received_messages, initial.received_messages);
    assert.equal(idle.sent_messages, initial.sent_messages);
    assert.deepEqual(idle.recent_activity, initial.recent_activity);

    store.stopped();
    await store.flush();
    const stopped = JSON.parse(readFileSync(telemetryPath, "utf8")) as typeof initial;
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const afterStop = JSON.parse(readFileSync(telemetryPath, "utf8")) as typeof initial;
    assert.equal(afterStop.updated_at, stopped.updated_at);
});

test("runtime telemetry stops liveness after terminal startup failure", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-failed-liveness-");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "invalid gateway",
  });
  t.after(async () => {
    store.stopped();
    await store.flush();
  });

  store.connecting();
    store.socketError("invalid gateway");
    store.failed();
    await store.flush();
    const failed = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
      state: string;
      updated_at: string;
      last_error: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const afterFailure = JSON.parse(readFileSync(telemetryPath, "utf8")) as typeof failed;

    assert.equal(failed.state, "error");
    assert.equal(failed.last_error, "invalid gateway");
  assert.equal(afterFailure.updated_at, failed.updated_at);
});

test("runtime telemetry attributes requests and recent activity to advertised projects", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-project-telemetry-");
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
  });

  store.projectsAdvertised([
      {
        alias: "project-one",
        path: "/work/project-one",
        repoIdentity: "repo-one",
        remoteLabel: "open-gsd/project-one",
        markers: [".gsd"],
      },
      {
        alias: "project-two",
        path: "/work/project-two",
        repoIdentity: "repo-two",
        markers: [".gsd"],
      },
    ]);
    store.requestStarted({
      requestId: "request-1",
      projectAlias: "project-one",
      toolName: "gsd_execute",
      receivedBytes: 128,
    });
    store.requestFinished({
      requestId: "request-1",
      projectAlias: "project-one",
      toolName: "gsd_execute",
      durationMs: 42,
      outcome: "success",
    });
    store.sent("x".repeat(512), "/work/project-one");
    store.sent("global");
    await store.flush();

    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
      projects?: Array<Record<string, unknown>>;
      recent_activity?: Array<Record<string, unknown>>;
    };
    assert.equal(status.projects?.length, 2);
    assert.deepEqual(status.projects?.[0], {
      alias: "project-one",
      path: "/work/project-one",
      repo_identity: "repo-one",
      remote_label: "open-gsd/project-one",
      state: "idle",
      active_requests: 0,
      active_tools: [],
      request_count: 1,
      error_count: 0,
      received_bytes: 128,
      sent_bytes: 512,
      last_tool: "gsd_execute",
      last_activity_at: status.projects?.[0]?.last_activity_at,
    });
    assert.deepEqual(status.projects?.[1], {
      alias: "project-two",
      path: "/work/project-two",
      repo_identity: "repo-two",
      state: "idle",
      active_requests: 0,
      active_tools: [],
      request_count: 0,
      error_count: 0,
      received_bytes: 0,
      sent_bytes: 0,
      last_tool: null,
      last_activity_at: null,
    });
    assert.equal(status.recent_activity?.length, 1);
    assert.equal(status.recent_activity?.[0]?.project_alias, "project-one");
    assert.equal(status.recent_activity?.[0]?.tool_name, "gsd_execute");
    assert.equal(status.recent_activity?.[0]?.outcome, "success");
    assert.equal(status.recent_activity?.[0]?.duration_ms, 42);
});

test("runtime telemetry tracks concurrent in-flight tool names", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-active-tools-");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });
  store.projectsAdvertised([{
    alias: "project-one",
    path: "/work/project-one",
    repoIdentity: "repo-one",
    markers: [".gsd"],
  }]);

  store.requestStarted({
    requestId: "request-1",
    projectPath: "/work/project-one",
    toolName: "gsd_execute",
    receivedBytes: 10,
  });
  store.requestStarted({
    requestId: "request-2",
    projectPath: "/work/project-one",
    toolName: "gsd_status",
    receivedBytes: 10,
  });
  await store.flush();

  let status = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
    projects: Array<{ active_requests: number; active_tools: string[] }>;
  };
  assert.equal(status.projects[0]?.active_requests, 2);
  assert.deepEqual(status.projects[0]?.active_tools, ["gsd_execute", "gsd_status"]);

  store.requestFinished({
    requestId: "request-1",
    projectPath: "/work/project-one",
    toolName: "gsd_execute",
    durationMs: 5,
    outcome: "success",
  });
  await store.flush();
  status = JSON.parse(readFileSync(telemetryPath, "utf8")) as typeof status;
  assert.deepEqual(status.projects[0]?.active_tools, ["gsd_status"]);
});

test("runtime telemetry bounds recent project activity", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-project-telemetry-");
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
  });

    store.projectsAdvertised([{
      alias: "project-one",
      path: "/work/project-one",
      repoIdentity: "repo-one",
      markers: [".gsd"],
    }]);
    for (let index = 0; index < 55; index += 1) {
      const requestId = `request-${index}`;
      store.requestStarted({
        requestId,
        projectAlias: "project-one",
        toolName: "gsd_status",
        receivedBytes: 10,
      });
      store.requestFinished({
        requestId,
        projectAlias: "project-one",
        toolName: "gsd_status",
        durationMs: index,
        outcome: index === 54 ? "error" : "success",
        ...(index === 54 ? { error: "fixture failure" } : {}),
      });
    }
    store.sent("global");
    await store.flush();

    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
      projects?: Array<{ error_count?: number; sent_bytes?: number }>;
      recent_activity?: Array<{ request_id?: string; error?: string }>;
    };
    assert.equal(status.recent_activity?.length, 50);
    assert.equal(status.recent_activity?.[0]?.request_id, "request-5");
    assert.equal(status.recent_activity?.at(-1)?.request_id, "request-54");
    assert.equal(status.recent_activity?.at(-1)?.error, "fixture failure");
    assert.equal(status.projects?.[0]?.error_count, 1);
    assert.equal(status.projects?.[0]?.sent_bytes, 0);
});

test("runtime telemetry records reconnects and the latest failure", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-telemetry-");
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
  });

    store.connecting();
    store.connected();
    store.disconnected("socket closed");
    store.connecting();
    await store.flush();

    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as Record<string, unknown>;
    assert.equal(status.state, "reconnecting");
    assert.equal(status.connection_attempts, 2);
    assert.equal(status.reconnects, 1);
    assert.equal(status.last_error, "socket closed");
});

test("runtime telemetry distinguishes projects with duplicate aliases by path", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-duplicate-alias-");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

    store.projectsAdvertised([
      { alias: "app", path: "/work/one/app", repoIdentity: "repo-one", markers: [".gsd"] },
      { alias: "app", path: "/work/two/app", repoIdentity: "repo-two", markers: [".gsd"] },
    ]);
    store.requestStarted({
      requestId: "request-2",
      projectAlias: "app",
      projectPath: "/work/two/app",
      toolName: "gsd_status",
      receivedBytes: 25,
    });
    store.requestFinished({
      requestId: "request-2",
      projectAlias: "app",
      projectPath: "/work/two/app",
      toolName: "gsd_status",
      durationMs: 10,
      outcome: "success",
    });
    store.sent("result", "/work/two/app");
    await store.flush();

    const status = JSON.parse(readFileSync(join(root, "cloud-runtime-status.json"), "utf8")) as {
      projects: Array<{ path: string; request_count: number; received_bytes: number; sent_bytes: number }>;
      recent_activity: Array<Record<string, unknown>>;
    };
    assert.deepEqual(status.projects.map(({ path, request_count, received_bytes, sent_bytes }) => ({
      path, request_count, received_bytes, sent_bytes,
    })), [
      { path: "/work/one/app", request_count: 0, received_bytes: 0, sent_bytes: 0 },
      { path: "/work/two/app", request_count: 1, received_bytes: 25, sent_bytes: 6 },
    ]);
    assert.deepEqual(status.recent_activity, [{
      request_id: "request-2",
      project_alias: "app",
      project_path: "/work/two/app",
      tool_name: "gsd_status",
      outcome: "success",
      duration_ms: 10,
      at: status.recent_activity[0]?.at,
    }]);
});

test("runtime telemetry keeps same-repository worktrees distinct", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-worktree-telemetry-");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

    store.projectsAdvertised([
      { alias: "app", path: "/work/one/app", repoIdentity: "shared-repo", markers: [".gsd"] },
      { alias: "app-copy", path: "/work/two/app", repoIdentity: "shared-repo", markers: [".gsd"] },
    ]);
    store.requestStarted({
      requestId: "request-1",
      projectPath: "/work/one/app",
      toolName: "gsd_status",
      receivedBytes: 10,
    });
    store.requestFinished({
      requestId: "request-1",
      projectPath: "/work/one/app",
      toolName: "gsd_status",
      durationMs: 1,
      outcome: "success",
    });
    store.projectsAdvertised([
      { alias: "app", path: "/work/one/app", repoIdentity: "shared-repo", markers: [".gsd"] },
      { alias: "app-copy", path: "/work/two/app", repoIdentity: "shared-repo", markers: [".gsd"] },
    ]);
    await store.flush();

    const status = JSON.parse(readFileSync(join(root, "cloud-runtime-status.json"), "utf8")) as {
      projects: Array<{ path: string; request_count: number }>;
    };
    assert.deepEqual(
      status.projects.map(({ path, request_count }) => ({ path, request_count })),
      [
        { path: "/work/one/app", request_count: 1 },
        { path: "/work/two/app", request_count: 0 },
      ],
    );
});

test("runtime telemetry removes credentials from remote labels", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-remote-label-");
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

    store.projectsAdvertised([
      {
        alias: "project-one",
        path: "/work/project-one",
        repoIdentity: "repo-one",
        remoteLabel: "https://token:secret@github.com/open-gsd/project-one.git?access_token=query-secret#fragment-secret",
        markers: [".gsd"],
      },
      {
        alias: "project-two",
        path: "/work/project-two",
        repoIdentity: "repo-two",
        remoteLabel: "git@github.com:open-gsd/project-two.git?token=scp-secret#scp-fragment",
        markers: [".gsd"],
      },
    ]);
    await store.flush();

    const raw = readFileSync(join(root, "cloud-runtime-status.json"), "utf8");
    const status = JSON.parse(raw) as { projects: Array<{ remote_label?: string }> };
    assert.equal(status.projects[0]?.remote_label, "https://github.com/open-gsd/project-one.git");
    assert.equal(status.projects[1]?.remote_label, "github.com:open-gsd/project-two.git");
    assert.equal(raw.includes("token"), false);
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("fragment"), false);
});

test("runtime telemetry isolates persistence failures", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-persistence-failure-");
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "fixture");
  const store = new RuntimeTelemetryStore(join(blocker, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

    store.connected();
    await store.flush();
});

test("clearRuntimeTelemetry removes the persisted snapshot for the config namespace", async (t) => {
  const root = makeTempDir(t, "gsd-cloud-clear-telemetry-");
  const configPath = join(root, "daemon.yaml");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
  });
  store.connected();
  await store.flush();
  assert.notEqual(readRuntimeTelemetry(configPath), null);

  clearRuntimeTelemetry(configPath);

  assert.equal(readRuntimeTelemetry(configPath), null);
  clearRuntimeTelemetry(configPath);
});

function makeTempDir(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
