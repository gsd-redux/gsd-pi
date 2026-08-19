// Project/App: gsd-pi
// File Purpose: SQLite busy error classification regression tests (#1826).

import { test } from "node:test";
import assert from "node:assert/strict";

import { isSqliteBusyError } from "../sqlite-errors.ts";

test("isSqliteBusyError recognizes provider codes, errcode 5, and lock messages", () => {
  assert.equal(isSqliteBusyError({ code: "SQLITE_BUSY" }), true);
  assert.equal(isSqliteBusyError({ errcode: 5 }), true);
  assert.equal(isSqliteBusyError(new Error("database is locked")), true);
  assert.equal(isSqliteBusyError(new Error("database disk image is malformed")), false);
});
