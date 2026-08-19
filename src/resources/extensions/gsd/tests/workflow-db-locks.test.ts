// Project/App: gsd-pi
// File Purpose: Workflow DB lock-holder parsing regression tests (#1826).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isDormantWorkflowDbLockHolderSafeToTerminate,
  formatLockedWorkflowDatabaseNotice,
  parseElapsedSeconds,
  parseLsofProcessFields,
  terminateDormantWorkflowDbLockHolders,
  type WorkflowDbLockHolder,
} from "../workflow-db-locks.ts";

test("parseLsofProcessFields extracts holder PIDs, commands, and numeric users", () => {
  assert.deepEqual(parseLsofProcessFields("p123\ncnode\nu501\nf21\np456\ncgsd\nu501\nf22"), [
    { pid: 123, command: "node", uid: 501 },
    { pid: 456, command: "gsd", uid: 501 },
  ]);
});

test("parseElapsedSeconds handles day and clock forms", () => {
  assert.equal(parseElapsedSeconds("03:04"), 184);
  assert.equal(parseElapsedSeconds("02:03:04"), 7_384);
  assert.equal(parseElapsedSeconds("1-02:03:04"), 93_784);
});

test("automatic termination also requires a stale worker heartbeat", () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };

  assert.equal(isDormantWorkflowDbLockHolderSafeToTerminate(holder, new Map()), false);
  assert.equal(isDormantWorkflowDbLockHolderSafeToTerminate(holder, new Map([[123, 2_000]])), true);
  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate({ ...holder, sameUser: false }, new Map([[123, 2_000]])),
    false,
  );
  assert.equal(
    isDormantWorkflowDbLockHolderSafeToTerminate(
      { ...holder, processStartedAtMs: 100_000 },
      new Map([[123, 2_000]]),
    ),
    false,
  );
});

test("termination signals only a stale, same-instance GSD holder", async () => {
  const holder: WorkflowDbLockHolder = {
    pid: 123,
    command: "node /opt/@opengsd/gsd-pi/dist/loader.js",
    uid: 501,
    state: "S",
    elapsedSeconds: 600,
    sameUser: true,
    gsdProcess: true,
    dormant: true,
    processStartIdentity: "sha256:test-process",
    processStartedAtMs: 1_000,
  };
  const signaled: number[] = [];
  const result = await terminateDormantWorkflowDbLockHolders(
    [holder, { ...holder, pid: 456, processStartIdentity: "sha256:active" }],
    new Map([[123, 2_000], [456, 2_000]]),
    {
      signal: (pid) => { signaled.push(pid); },
      isAlive: () => false,
      wait: async () => {},
      processIdentity: (pid) => pid === 123 ? "sha256:test-process" : "sha256:reused",
    },
  );

  assert.deepEqual(signaled, [123]);
  assert.deepEqual(result, { signaled: [123], terminated: [123], remaining: [] });
});

test("locked auto notice includes discovered holder PIDs and remediation", () => {
  assert.match(formatLockedWorkflowDatabaseNotice([123, 456]), /PIDs 123, 456/);
  assert.match(formatLockedWorkflowDatabaseNotice([123, 456]), /doctor --fix/);
});
