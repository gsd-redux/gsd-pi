import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listInstalledExtensions,
  registerPackageExtensions,
  unregisterPackageExtensions,
} from "../extension-registry.ts";

test("registerPackageExtensions records shell-installed extension manifests", (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-package-extension-registry-"));
  const extensionDir = join(home, "agent", "npm", "node_modules", "@demo", "extension");
  const entryDir = join(extensionDir, "dist");
  const registryPath = join(home, "extensions", "registry.json");
  mkdirSync(entryDir, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  writeFileSync(join(entryDir, "index.js"), "export default function extension() {}\n");
  writeFileSync(join(extensionDir, "extension-manifest.json"), JSON.stringify({
    id: "demo.extension",
    name: "Demo Extension",
    version: "1.2.3",
    description: "test extension",
    tier: "community",
    requires: { platform: "node" },
  }));

  registerPackageExtensions(
    "npm:@demo/extension",
    "user",
    home,
    [{ path: join(entryDir, "index.js"), packageRoot: extensionDir }],
    registryPath,
  );

  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  assert.deepEqual(registry.entries["demo.extension"], {
    id: "demo.extension",
    enabled: true,
    source: "user",
    version: "1.2.3",
    installedFrom: "@demo/extension",
    installType: "npm",
    extensionDir,
  });
  assert.deepEqual(listInstalledExtensions(home, registry), [registry.entries["demo.extension"]]);

  const projectOne = join(home, "project-one");
  const projectTwo = join(home, "project-two");
  registerPackageExtensions(
    "npm:@demo/extension",
    "project",
    projectOne,
    [{ path: join(entryDir, "index.js"), packageRoot: extensionDir }],
    registryPath,
  );
  registerPackageExtensions(
    "npm:@demo/extension",
    "project",
    projectTwo,
    [{ path: join(entryDir, "index.js"), packageRoot: extensionDir }],
    registryPath,
  );

  const scopedRegistry = JSON.parse(readFileSync(registryPath, "utf-8"));
  assert.equal(Object.keys(scopedRegistry.entries).length, 3);
  assert.deepEqual(
    listInstalledExtensions(projectOne, scopedRegistry).map((entry) => entry.source).sort(),
    ["project", "user"],
  );

  unregisterPackageExtensions("npm:@demo/extension", "user", home, registryPath);
  unregisterPackageExtensions("npm:@demo/extension", "project", projectOne, registryPath);
  const partiallyUnregistered = JSON.parse(readFileSync(registryPath, "utf-8"));
  assert.equal(Object.keys(partiallyUnregistered.entries).length, 1);
  assert.deepEqual(listInstalledExtensions(projectOne, partiallyUnregistered), []);

  unregisterPackageExtensions("npm:@demo/extension", "project", projectTwo, registryPath);
  const unregistered = JSON.parse(readFileSync(registryPath, "utf-8"));
  assert.deepEqual(unregistered.entries, {});
});
