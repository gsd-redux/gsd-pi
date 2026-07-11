// Project/App: Open GSD
// File Purpose: Contract tests for the token-free runtime telemetry consumed by desktop monitors.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeTelemetryStore } from "./runtime-telemetry.js";

test("runtime telemetry persists connection state and traffic without credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-telemetry-"));
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
    runtimeName: "MacBook",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry attributes requests and recent activity to advertised projects", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-project-telemetry-"));
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry bounds recent project activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-project-telemetry-"));
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry records reconnects and the latest failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-telemetry-"));
  const configPath = join(root, "daemon.yaml");
  const telemetryPath = join(root, "cloud-runtime-status.json");
  const store = new RuntimeTelemetryStore(configPath, {
    gatewayUrl: "https://cloud.example.com",
    runtimeId: "runtime-1",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry distinguishes projects with duplicate aliases by path", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-duplicate-alias-"));
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry keeps same-repository worktrees distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-worktree-telemetry-"));
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry removes credentials from remote labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-remote-label-"));
  const store = new RuntimeTelemetryStore(join(root, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry isolates persistence failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-cloud-persistence-failure-"));
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "fixture");
  const store = new RuntimeTelemetryStore(join(blocker, "daemon.yaml"), {
    gatewayUrl: "https://cloud.example.com",
  });

  try {
    store.connected();
    await store.flush();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
