// Project/App: gsd-pi
// File Purpose: Regression coverage for GSD metadata applied to vendored Pi packages.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

test("apply-gsd-pi-package-json writes GSD runtime config for pi-coding-agent", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-apply-pkg-json-"));

  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(
      join(repoRoot, "scripts", "apply-gsd-pi-package-json.cjs"),
      join(root, "scripts", "apply-gsd-pi-package-json.cjs"),
    );

    for (const dir of ["pi-agent-core", "pi-ai", "pi-tui", "pi-coding-agent"]) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(
        join(root, "packages", dir, "package.json"),
        `${JSON.stringify({ name: dir, dependencies: {}, devDependencies: {} }, null, 2)}\n`,
      );
    }

    execFileSync(process.execPath, [join(root, "scripts", "apply-gsd-pi-package-json.cjs")], {
      cwd: root,
      stdio: "pipe",
    });

    const pkg = JSON.parse(readFileSync(join(root, "packages", "pi-coding-agent", "package.json"), "utf8"));
    assert.deepEqual(pkg.piConfig, { name: "gsd", configDir: ".gsd" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
