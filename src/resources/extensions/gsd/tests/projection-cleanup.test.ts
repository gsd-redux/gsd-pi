// Project/App: gsd-pi
// File Purpose: Operation-fenced projection cleanup preserves newer readable output.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setProjectionCleanupInterleaveForTest,
  removeProjectionIfCurrent,
} from "../projection-cleanup.ts";

test("operation-fenced cleanup removes a projection while the operation stays current", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-cleanup-current-"));
  const artifactPath = join(base, "SUMMARY.md");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(artifactPath, "# Superseded summary\n");

  const removed = removeProjectionIfCurrent({
    artifactPath,
    operationId: "operation-1",
    isCurrent: () => true,
  });

  assert.equal(removed, true);
  assert.equal(existsSync(artifactPath), false);
  assert.equal(existsSync(`${artifactPath}.reopen-operation-1.pending`), false);
});

test("operation-fenced cleanup preserves a newer projection when ownership changes mid-delete", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-cleanup-race-"));
  const artifactPath = join(base, "SUMMARY.md");
  let current = true;
  t.after(() => {
    _setProjectionCleanupInterleaveForTest(null);
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(artifactPath, "# Old summary\n");
  _setProjectionCleanupInterleaveForTest(() => {
    current = false;
    writeFileSync(artifactPath, "# New summary\n");
  });

  const removed = removeProjectionIfCurrent({
    artifactPath,
    operationId: "operation-1",
    isCurrent: () => current,
  });

  assert.equal(removed, false);
  assert.equal(readFileSync(artifactPath, "utf8"), "# New summary\n");
  assert.equal(existsSync(`${artifactPath}.reopen-operation-1.pending`), false);
});

test("superseded cleanup restores an interrupted tombstone", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-cleanup-restart-"));
  const artifactPath = join(base, "SUMMARY.md");
  const tombstonePath = `${artifactPath}.reopen-operation-1.pending`;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(tombstonePath, "# Preserved summary\n");

  const removed = removeProjectionIfCurrent({
    artifactPath,
    operationId: "operation-1",
    isCurrent: () => false,
  });

  assert.equal(removed, false);
  assert.equal(readFileSync(artifactPath, "utf8"), "# Preserved summary\n");
  assert.equal(existsSync(tombstonePath), false);
});
