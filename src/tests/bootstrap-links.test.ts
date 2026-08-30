/**
 * Unit tests for the bin bootstrap's workspace-link self-repair (#2061).
 * Installs made with --ignore-scripts never run the postinstall link step;
 * dist/bootstrap.js recreates the @gsd/* links on first invocation. These
 * tests inject a throwing symlink so the directory-copy fallback runs
 * deterministically on every platform (the native symlink path aborts on
 * some macOS + Node combinations when invoked repeatedly in one process).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, lstatSync, rmSync, symlinkSync as fsSymlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const bootstrapPath = join(process.cwd(), "dist", "bootstrap.js");
const bootstrap = await import(pathToFileURL(bootstrapPath).href);

function makeSafeCopy(): (from: string, to: string, options: { recursive: true }) => void {
  return (from, to) => {
    const copyDir = (src: string, dest: string): void => {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src)) {
        const s = join(src, entry);
        const d = join(dest, entry);
        if (existsSync(s) && lstatSync(s).isDirectory()) copyDir(s, d);
        else writeFileSync(d, readFileSync(s));
      }
    };
    rmSync(to, { force: true });
    copyDir(from, to);
  };
}

function makeInstallTree(t: import("node:test").TestContext): { root: string; scopeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "gsd-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"), { recursive: true });
  const packagesDir = join(root, "packages");
  for (const [dir, name] of [
    ["pi-coding-agent", "@gsd/pi-coding-agent"],
    ["pi-tui", "@gsd/pi-tui"],
  ] as const) {
    mkdirSync(join(packagesDir, dir), { recursive: true });
    writeFileSync(
      join(packagesDir, dir, "package.json"),
      JSON.stringify({ name, version: "1.17.0", main: "./dist/index.js" }),
    );
    mkdirSync(join(packagesDir, dir, "dist"), { recursive: true });
    writeFileSync(join(packagesDir, dir, "dist", "index.js"), "export {};\n");
  }
  return { root, scopeDir: join(root, "node_modules", "@gsd") };
}

test("ensureWorkspaceLinks repairs via directory copy when symlinks are unavailable", (t) => {
  const { root, scopeDir } = makeInstallTree(t);
  const { repaired, failed } = bootstrap.ensureWorkspaceLinks(root, {
    symlinkImpl: () => {
      throw new Error("EPERM: operation not permitted, symlink");
    },
    cpSyncImpl: makeSafeCopy(),
  });
  assert.deepEqual(failed, []);
  assert.deepEqual([...repaired].sort(), ["@gsd/pi-coding-agent", "@gsd/pi-tui"]);
  assert.ok(existsSync(join(scopeDir, "pi-coding-agent", "dist", "index.js")));
  assert.ok(existsSync(join(scopeDir, "pi-tui", "package.json")));
});

test("ensureWorkspaceLinks leaves healthy links and real directories untouched", (t) => {
  const { root, scopeDir } = makeInstallTree(t);
  mkdirSync(join(scopeDir, "pi-coding-agent", "dist"), { recursive: true });
  writeFileSync(join(scopeDir, "pi-coding-agent", "dist", "index.js"), "export {};\n");
  mkdirSync(join(scopeDir, "pi-tui"), { recursive: true });

  let symlinkCalls = 0;
  const { repaired } = bootstrap.ensureWorkspaceLinks(root, {
    symlinkImpl: () => {
      symlinkCalls++;
      throw new Error("should not be reached");
    },
  });
  assert.deepEqual(repaired, []);
  assert.equal(symlinkCalls, 0);
  assert.ok(existsSync(join(scopeDir, "pi-coding-agent", "dist", "index.js")));
  assert.ok(existsSync(join(scopeDir, "pi-tui")));
});

test("ensureWorkspaceLinks reports packages it could not repair", (t) => {
  const { root } = makeInstallTree(t);
  const { repaired, failed } = bootstrap.ensureWorkspaceLinks(root, {
    symlinkImpl: () => {
      throw new Error("EPERM: operation not permitted, symlink");
    },
    cpSyncImpl: () => {
      throw new Error("EACCES: permission denied, copy file");
    },
  });
  assert.deepEqual(repaired, []);
  assert.equal(failed.length, 2);
  assert.match(failed[0], /pi-coding-agent/);
  assert.match(failed[0], /EACCES/);
});
