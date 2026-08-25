import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleExtensions } from "../commands-extensions.ts";

test("extensions list discovers manifests registered by shell package installs", async (t) => {
  const previousHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-list-"));
  const extensionDir = join(home, "agent", "npm", "node_modules", "@demo", "extension");
  const notices: string[] = [];
  process.env.GSD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(join(home, "extensions"), { recursive: true });
  writeFileSync(join(extensionDir, "extension-manifest.json"), JSON.stringify({
    id: "demo.extension",
    name: "Demo Extension",
    version: "1.2.3",
    description: "test extension",
    tier: "community",
    requires: { platform: "node" },
  }));
  writeFileSync(join(home, "extensions", "registry.json"), JSON.stringify({
    version: 1,
    entries: {
      "demo.extension": {
        id: "demo.extension",
        enabled: true,
        source: "user",
        version: "1.2.3",
        installedFrom: "@demo/extension",
        installType: "npm",
        extensionDir,
      },
    },
  }));

  const ctx = {
    ui: {
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;

  await handleExtensions("list", ctx);

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /demo\.extension \(Demo Extension\)/);
  assert.match(notices[0] ?? "", /\[user\]/);
});

test("extensions list prefers the current project's manifest for a shared id", async (t) => {
  const previousHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-scope-"));
  const projectDirPath = join(home, "project");
  const globalExtensionDir = join(home, "agent", "npm", "node_modules", "global-extension");
  const projectExtensionDir = join(projectDirPath, ".gsd", "npm", "node_modules", "project-extension");
  const notices: string[] = [];
  mkdirSync(globalExtensionDir, { recursive: true });
  mkdirSync(projectExtensionDir, { recursive: true });
  mkdirSync(join(home, "extensions"), { recursive: true });
  process.chdir(projectDirPath);
  const projectDir = process.cwd();
  process.env.GSD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    process.chdir(originalCwd);
    rmSync(home, { recursive: true, force: true });
  });

  const manifest = (name: string, version: string) => ({
    id: "shared.extension",
    name,
    version,
    description: "test extension",
    tier: "community",
    requires: { platform: "node" },
  });
  writeFileSync(
    join(globalExtensionDir, "extension-manifest.json"),
    JSON.stringify(manifest("Global Extension", "1.0.0")),
  );
  writeFileSync(
    join(projectExtensionDir, "extension-manifest.json"),
    JSON.stringify(manifest("Project Extension", "2.0.0")),
  );
  writeFileSync(join(home, "extensions", "registry.json"), JSON.stringify({
    version: 1,
    entries: {
      "shared.extension": {
        id: "shared.extension",
        enabled: true,
        source: "user",
        version: "1.0.0",
        installedFrom: "global-extension",
        installType: "npm",
        extensionDir: globalExtensionDir,
      },
      [`shared.extension::project::${projectDir}`]: {
        id: "shared.extension",
        enabled: true,
        source: "project",
        version: "2.0.0",
        installedFrom: "project-extension",
        installType: "npm",
        extensionDir: projectExtensionDir,
        projectDir,
      },
    },
  }));
  const ctx = {
    ui: {
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;

  await handleExtensions("list", ctx);

  assert.match(notices.join("\n"), /shared\.extension \(Project Extension\)/);
  assert.doesNotMatch(notices.join("\n"), /Global Extension/);
  assert.match(notices.join("\n"), /\[project\]/);
});

test("extensions update refreshes a shell package install in place", async (t) => {
  const previousHome = process.env.GSD_HOME;
  const previousBinPath = process.env.GSD_BIN_PATH;
  const originalCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-update-"));
  const projectDir = join(home, "project");
  const agentDir = join(home, "agent");
  const extensionDir = join(agentDir, "npm", "node_modules", "demo-extension");
  const fakeNpmPath = join(home, "fake-npm.cjs");
  const recordPath = join(home, "npm-invocation.json");
  const manifestPath = join(extensionDir, "extension-manifest.json");
  const notices: string[] = [];
  mkdirSync(projectDir, { recursive: true });
  process.env.GSD_HOME = home;
  process.env.GSD_BIN_PATH = fakeNpmPath;
  process.chdir(projectDir);
  t.after(() => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    if (previousBinPath === undefined) delete process.env.GSD_BIN_PATH;
    else process.env.GSD_BIN_PATH = previousBinPath;
    process.chdir(originalCwd);
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(extensionDir, "dist"), { recursive: true });
  writeFileSync(join(extensionDir, "dist", "index.js"), "export default function extension() {}\n");
  writeFileSync(join(extensionDir, "package.json"), JSON.stringify({
    pi: { extensions: ["dist/index.js"] },
  }));
  writeFileSync(manifestPath, JSON.stringify({
    id: "demo.extension",
    name: "Demo Extension",
    version: "1.0.0",
    description: "test extension",
    tier: "community",
    requires: { platform: "node" },
  }));
  writeFileSync(fakeNpmPath, `
const fs = require("node:fs");
const manifestPath = ${JSON.stringify(manifestPath)};
const recordPath = ${JSON.stringify(recordPath)};
const registryPath = ${JSON.stringify(join(home, "extensions", "registry.json"))};
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
manifest.version = "2.0.0";
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
registry.entries["demo.extension"].version = "2.0.0";
fs.writeFileSync(registryPath, JSON.stringify(registry));
fs.writeFileSync(recordPath, JSON.stringify(process.argv.slice(2)));
`);
  mkdirSync(join(home, "extensions"), { recursive: true });
  writeFileSync(join(home, "extensions", "registry.json"), JSON.stringify({
    version: 1,
    entries: {
      "demo.extension": {
        id: "demo.extension",
        enabled: true,
        source: "user",
        version: "1.0.0",
        installedFrom: "demo-extension",
        installType: "npm",
        extensionDir,
      },
    },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ version: "2.0.0" });
  t.after(() => { globalThis.fetch = originalFetch; });

  const ctx = {
    ui: {
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;

  await handleExtensions("update demo.extension", ctx);

  const registry = JSON.parse(readFileSync(join(home, "extensions", "registry.json"), "utf-8"));
  assert.equal(registry.entries["demo.extension"].version, "2.0.0");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf-8")).version, "2.0.0");
  assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf-8")), ["install", "npm:demo-extension"]);
  assert.match(notices.join("\n"), /Updated "demo\.extension" to v2\.0\.0/);
});

test("extensions uninstall cannot reach a package registered to another project", async (t) => {
  const previousHome = process.env.GSD_HOME;
  const previousBinPath = process.env.GSD_BIN_PATH;
  const originalCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-uninstall-"));
  const projectOnePath = join(home, "project-one");
  const projectTwo = join(home, "project-two");
  const extensionDir = join(projectOnePath, ".gsd", "npm", "node_modules", "demo-extension");
  const registryPath = join(home, "extensions", "registry.json");
  const fakeBinPath = join(home, "fake-gsd.cjs");
  const recordPath = join(home, "gsd-invocation.json");
  const notices: string[] = [];
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(projectTwo, { recursive: true });
  const projectOne = realpathSync(projectOnePath);
  const registryKey = `demo.extension::project::${projectOne}`;
  mkdirSync(join(home, "extensions"), { recursive: true });
  process.env.GSD_HOME = home;
  process.env.GSD_BIN_PATH = fakeBinPath;
  t.after(() => {
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    if (previousBinPath === undefined) delete process.env.GSD_BIN_PATH;
    else process.env.GSD_BIN_PATH = previousBinPath;
    process.chdir(originalCwd);
    rmSync(home, { recursive: true, force: true });
  });

  writeFileSync(join(extensionDir, "extension-manifest.json"), JSON.stringify({
    id: "demo.extension",
    name: "Demo Extension",
    version: "1.0.0",
    tier: "community",
  }));
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    entries: {
      [registryKey]: {
        id: "demo.extension",
        enabled: true,
        source: "project",
        version: "1.0.0",
        installedFrom: "demo-extension",
        installType: "npm",
        extensionDir,
        projectDir: projectOne,
      },
    },
  }));
  writeFileSync(fakeBinPath, `
const fs = require("node:fs");
const registryPath = ${JSON.stringify(registryPath)};
const registryKey = ${JSON.stringify(registryKey)};
const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
delete registry.entries[registryKey];
fs.writeFileSync(registryPath, JSON.stringify(registry));
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));
`);
  const ctx = {
    ui: {
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionCommandContext;

  process.chdir(projectTwo);
  await handleExtensions("uninstall demo.extension", ctx);
  assert.equal(existsSync(recordPath), false);
  assert.equal(Object.keys(JSON.parse(readFileSync(registryPath, "utf-8")).entries).length, 1);

  process.chdir(projectOne);
  await handleExtensions("uninstall demo.extension", ctx);
  assert.equal(existsSync(recordPath), true, notices.join("\n"));
  assert.deepEqual(
    JSON.parse(readFileSync(recordPath, "utf-8")),
    ["remove", "npm:demo-extension", "--local"],
  );
  assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf-8")).entries, {});
});
