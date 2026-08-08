import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateFileChanges, effectiveFileChangeAllowlist } from "../safety/file-change-validator.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

test("validateFileChanges works on repos with a single commit (no HEAD~1)", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "foo.ts"), "export const x = 1;\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  // With only one commit, HEAD~1 doesn't exist — this must not throw
  const audit = validateFileChanges(base, ["foo.ts"], []);

  assert.ok(audit, "audit should be produced for single-commit repo");
  assert.deepEqual(audit.unexpectedFiles, []);
  assert.deepEqual(audit.missingFiles, []);
});

test("validateFileChanges excludes allowlisted files from unexpected-change warnings", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, "tracking", "history"), { recursive: true });
  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "src.ts"), "initial\n");
  writeFileSync(join(base, "tracking", "history", "2026-04-20-snapshot.md"), "initial\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(join(base, "src.ts"), "updated\n");
  writeFileSync(join(base, "tracking", "history", "2026-04-20-snapshot.md"), "updated\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "update");

  // Without allowlist: tracking/history snapshot is unexpected
  const auditWithout = validateFileChanges(base, ["src.ts"], []);
  assert.ok(auditWithout, "audit should be produced");
  assert.ok(
    auditWithout.unexpectedFiles.includes("tracking/history/2026-04-20-snapshot.md"),
    "snapshot should be unexpected without allowlist",
  );

  // With glob allowlist: snapshot is excluded
  const auditWith = validateFileChanges(base, ["src.ts"], [], ["tracking/history/**"]);
  assert.ok(auditWith, "audit should be produced with allowlist");
  assert.deepEqual(auditWith.unexpectedFiles, [], "no unexpected files when snapshot is allowlisted");
  assert.equal(
    auditWith.violations.filter(v => v.severity === "warning").length,
    0,
    "no warnings when all unexpected files are allowlisted",
  );
});

test("validateFileChanges ignores inline descriptions in expected output paths", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, "definitions"), { recursive: true });
  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  const target = join(base, "definitions", "ac-audit.md");
  writeFileSync(target, "initial\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(target, "updated\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "update");

  const audit = validateFileChanges(
    base,
    ["definitions/ac-audit.md — current state of AC CRM, tags, pipelines, automations"],
    [],
  );

  assert.ok(audit, "audit should be produced when expected output exists");
  assert.deepEqual(audit.unexpectedFiles, []);
  assert.deepEqual(audit.missingFiles, []);
  assert.equal(
    audit.violations.some((v) => v.severity === "warning"),
    false,
    "described expected output should not trigger unexpected-file warnings",
  );
});

test("effectiveFileChangeAllowlist includes .gitignore when GSD manages it", () => {
  assert.deepEqual(effectiveFileChangeAllowlist([], undefined), [".gitignore"]);
  assert.deepEqual(effectiveFileChangeAllowlist(["docs/**"], true), ["docs/**", ".gitignore"]);
});

test("effectiveFileChangeAllowlist keeps .gitignore auditable when management is disabled", () => {
  assert.deepEqual(effectiveFileChangeAllowlist(["docs/**"], false), ["docs/**"]);
});

test("validateFileChanges excludes .gsd-backups/ migration snapshots from unexpected-change warnings", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const backupFile = join(
    base,
    ".gsd-backups",
    "migrate-1782703701330",
    "M010",
    "slices",
    "S01",
    "S01-ASSESSMENT.md",
  );
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(backupFile, ".."), { recursive: true });

  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "src", "app.ts"), "initial\n");
  writeFileSync(backupFile, "legacy assessment\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(join(base, "src", "app.ts"), "updated\n");
  writeFileSync(backupFile, "legacy assessment touched\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "task commit");

  const audit = validateFileChanges(base, ["src/app.ts"], []);
  assert.ok(audit, "audit should be produced");
  assert.deepEqual(audit!.unexpectedFiles, [], ".gsd-backups/ must not trigger warnings");
  assert.equal(
    audit!.violations.filter(v => v.severity === "warning").length,
    0,
    "no warnings when only source and migration backup files changed",
  );
});

test("validateFileChanges excludes the configured in-repo GSD state directory", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  const originalStateDir = process.env.GSD_STATE_DIR;
  process.env.GSD_STATE_DIR = join(base, ".gsd-state");
  t.after(() => {
    if (originalStateDir === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = originalStateDir;
    rmSync(base, { recursive: true, force: true });
  });

  const managedFile = join(
    base,
    ".gsd-state",
    "projects",
    "abc123",
    "phases",
    "02-new-milestone",
    "S01-replan-T02-VERIFY.json",
  );
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(managedFile, ".."), { recursive: true });

  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");

  writeFileSync(join(base, "src", "app.ts"), "initial\n");
  writeFileSync(managedFile, "{}\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "initial");

  writeFileSync(join(base, "src", "app.ts"), "updated\n");
  writeFileSync(managedFile, '{"updated":true}\n');
  git(base, "add", ".");
  git(base, "commit", "-m", "task commit");

  const audit = validateFileChanges(base, ["src/app.ts"], []);
  assert.ok(audit, "audit should be produced");
  assert.deepEqual(audit.unexpectedFiles, [], "configured GSD state must not trigger warnings");
  assert.deepEqual(audit.actualFiles, ["src/app.ts"]);
});

test("GSD-managed .gitignore edit swept into a task commit is not flagged", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-file-change-validator-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  git(base, "init");
  git(base, "config", "user.email", "test@example.com");
  git(base, "config", "user.name", "Test User");
  writeFileSync(join(base, "index.html"), "<main></main>\n");
  writeFileSync(join(base, ".gitignore"), "# ── GSD baseline (auto-generated) ──\n.gsd\n");
  git(base, "add", ".");
  git(base, "commit", "-m", "task commit with swept gitignore");

  const audit = validateFileChanges(
    base,
    ["index.html"],
    [],
    effectiveFileChangeAllowlist([], undefined),
  );

  assert.ok(audit, "audit should be produced");
  assert.deepEqual(audit.unexpectedFiles, [], ".gitignore must not be flagged when GSD manages it");
});
