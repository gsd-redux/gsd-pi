// Project/App: gsd-pi
// File Purpose: rename-failure fallback classification for projection preservation (#1762).

import assert from "node:assert/strict";
import test from "node:test";

import { shouldCopyDeleteOnRenameFailure } from "../projection-observation.ts";

test("EXDEV rename failures fall back to copy+delete", () => {
  const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  assert.equal(shouldCopyDeleteOnRenameFailure(exdev), true);
});

test("a Windows sharing violation on rename falls back to copy+delete", () => {
  const sharing = new Error("projection root operation failed: file in use (os error 32)");
  assert.equal(shouldCopyDeleteOnRenameFailure(sharing), true);
  const wrapped = new Error("replay failed", { cause: sharing });
  assert.equal(shouldCopyDeleteOnRenameFailure(wrapped), true);
});

test("unrelated rename failures still throw", () => {
  const perm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  assert.equal(shouldCopyDeleteOnRenameFailure(perm), false);
  assert.equal(shouldCopyDeleteOnRenameFailure(new Error("plain failure")), false);
});
