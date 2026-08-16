/**
 * Forensics redactForGitHub tests — #1632
 *
 * Verifies that report redaction strips bare OS usernames (not just homedir
 * path prefixes) and workspace-declared repository IDs, so neither leaks into
 * a filed GitHub issue.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { redactForGitHub } from "../forensics.js";

const GENERIC = new Set(["root", "admin", "administrator", "user", "ubuntu", "runner", "node"]);
const username = (() => {
  try {
    const name = userInfo().username?.trim();
    if (!name || name.length < 3 || GENERIC.has(name.toLowerCase())) return null;
    return name;
  } catch {
    return null;
  }
})();

test("#1632 bare OS username occurrences are redacted", { skip: username ? false : "no identifying OS username" }, () => {
  const line = `drwxrwxr-x 1 ${username} ${username} 726 Jul  3 13:34 .`;
  const out = redactForGitHub(line, "/tmp/project");

  assert.equal(out.includes(username!), false, "username should not survive redaction");
  assert.match(out, /drwxrwxr-x 1 <user> <user> 726/);
});

test("#1632 workspace repository IDs are redacted in both bracket and bare form", () => {
  const text = [
    "[child-repo-name] test -f some/path/file.hcl && echo ok",
    "verification failed in child-repo-name",
  ].join("\n");

  const out = redactForGitHub(text, "/tmp/project", ["project", "child-repo-name", "other-service"]);

  assert.equal(out.includes("child-repo-name"), false, "repo id should not survive redaction");
  assert.match(out, /^\[child-repo-1\] test -f/m);
  assert.match(out, /verification failed in child-repo-1$/m);
});

test("#1632 the implicit 'project' repo id is left alone", () => {
  const out = redactForGitHub("project state is stale", "/tmp/base", ["project"]);
  assert.equal(out, "project state is stale");
});

test("#1632 redaction is a no-op when no repo ids are declared", () => {
  const out = redactForGitHub("nothing sensitive here", "/tmp/base");
  assert.equal(out, "nothing sensitive here");
});
