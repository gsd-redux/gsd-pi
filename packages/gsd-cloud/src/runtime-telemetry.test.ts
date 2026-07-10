// Project/App: Open GSD
// File Purpose: Contract tests for the token-free runtime telemetry consumed by desktop monitors.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeTelemetryStore } from "./runtime-telemetry.js";

test("runtime telemetry persists connection state and traffic without credentials", () => {
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
      sentBytes: 58,
      durationMs: 25,
      outcome: "success",
    });

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

test("runtime telemetry attributes requests and recent activity to advertised projects", () => {
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
      sentBytes: 512,
      durationMs: 42,
      outcome: "success",
    });

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

test("runtime telemetry bounds recent project activity", () => {
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
        sentBytes: 20,
        durationMs: index,
        outcome: index === 54 ? "error" : "success",
        ...(index === 54 ? { error: "fixture failure" } : {}),
      });
    }

    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as {
      projects?: Array<{ error_count?: number }>;
      recent_activity?: Array<{ request_id?: string; error?: string }>;
    };
    assert.equal(status.recent_activity?.length, 50);
    assert.equal(status.recent_activity?.[0]?.request_id, "request-5");
    assert.equal(status.recent_activity?.at(-1)?.request_id, "request-54");
    assert.equal(status.recent_activity?.at(-1)?.error, "fixture failure");
    assert.equal(status.projects?.[0]?.error_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime telemetry records reconnects and the latest failure", () => {
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

    const status = JSON.parse(readFileSync(telemetryPath, "utf8")) as Record<string, unknown>;
    assert.equal(status.state, "reconnecting");
    assert.equal(status.connection_attempts, 2);
    assert.equal(status.reconnects, 1);
    assert.equal(status.last_error, "socket closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
