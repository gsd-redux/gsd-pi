import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shell-installed extension packages are written to the registry with update metadata", async (t) => {
  const previousGsdHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-"));
  process.env.GSD_HOME = home;
  t.after(() => {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(home, { recursive: true, force: true });
  });

  const packageDir = join(home, "agent", "npm", "node_modules", "@example", "demo-extension");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@example/demo-extension", pi: { extensions: ["index.js"] } }),
  );
  writeFileSync(
    join(packageDir, "extension-manifest.json"),
    JSON.stringify({
      id: "example.demo",
      name: "Demo Extension",
      version: "2.3.4",
      description: "test extension",
      tier: "community",
      requires: { platform: "node" },
    }),
  );
  writeFileSync(join(packageDir, "index.js"), "export default function () {}\n");

  const { registerInstalledExtensionPackage } = await import("../extension-registry.ts");
  assert.equal(
    registerInstalledExtensionPackage(packageDir, "npm:@example/demo-extension", "user"),
    "example.demo",
  );

  const registry = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
  assert.deepEqual(registry.entries["example.demo"], {
    id: "example.demo",
    enabled: true,
    source: "user",
    version: "2.3.4",
    installedFrom: "@example/demo-extension",
    installType: "npm",
  });

  registerInstalledExtensionPackage(packageDir, "npm:@example/demo-extension@2.3.4", "user");
  const pinnedRegistry = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
  assert.equal(pinnedRegistry.entries["example.demo"].installedFrom, "@example/demo-extension@2.3.4");
});
