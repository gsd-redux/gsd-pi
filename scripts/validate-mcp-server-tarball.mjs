#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { getOrderedWorkspacePublishList } = require("./lib/npm-release-packages.cjs");
const targetName = "@opengsd/mcp-server";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packDir = mkdtempSync(join(tmpdir(), "mcp-server-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "mcp-server-install-"));
const npmCacheDir = mkdtempSync(join(tmpdir(), "mcp-server-npm-cache-"));

function runNpm(args, options = {}) {
  return execFileSync(npmCommand, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: npmCacheDir,
      npm_config_fund: "false",
      npm_config_loglevel: "error",
    },
    ...options,
  });
}

function getPackageClosure(packages, packageName) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const closure = new Set();

  function visit(name) {
    if (closure.has(name)) return;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`Publishable workspace package not found: ${name}`);
    for (const dependency of pkg.deps) visit(dependency);
    closure.add(name);
  }

  visit(packageName);
  return packages.filter((pkg) => closure.has(pkg.name));
}

try {
  const packages = getPackageClosure(getOrderedWorkspacePublishList(), targetName);
  for (const pkg of packages) {
    const distDir = join(root, pkg.dir, "dist");
    if (!existsSync(distDir)) {
      throw new Error(`${pkg.name} build output is missing; run pnpm run build:mcp-server first`);
    }
  }

  execFileSync(process.execPath, [join(root, "scripts", "prepack-resolve-workspace.cjs")], {
    cwd: root,
    stdio: "inherit",
  });

  const tarballs = new Map();
  for (const pkg of packages) {
    const output = runNpm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      { cwd: join(root, pkg.dir) },
    );
    const packed = JSON.parse(output)[0];
    if (!packed?.filename) throw new Error(`npm pack returned no tarball for ${pkg.name}`);
    tarballs.set(pkg.name, join(packDir, packed.filename));
  }

  const dependencies = Object.fromEntries(
    packages.map((pkg) => [pkg.name, pathToFileURL(tarballs.get(pkg.name)).href]),
  );
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "mcp-server-tarball-smoke", private: true, dependencies }, null, 2)}\n`,
  );
  runNpm(["install", "--ignore-scripts"], { cwd: installDir });

  const installedManifestPath = join(installDir, "node_modules", "@opengsd", "mcp-server", "package.json");
  const installedManifestText = readFileSync(installedManifestPath, "utf8");
  if (installedManifestText.includes("workspace:") || installedManifestText.includes("@gsd/pi-ai")) {
    throw new Error("packed @opengsd/mcp-server manifest contains an unpublished workspace dependency");
  }
  const installedManifest = JSON.parse(installedManifestText);

  const publicApiScript = `
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    import { createMcpServer } from "@opengsd/mcp-server";

    delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    delete process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    const { server } = await createMcpServer({});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-server-public-api-validator", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      if (!tools.some((tool) => tool.name === "gsd_execute")) {
        throw new Error("packed MCP public API did not advertise gsd_execute");
      }
      if (tools.some((tool) => tool.name === "gsd_summary_save")) {
        throw new Error("packed MCP public API advertised workflow tools without a workflow bridge");
      }
    } finally {
      await client.close();
      await server.close();
    }

    process.env.GSD_WORKFLOW_EXECUTORS_MODULE = ${JSON.stringify(join(installDir, "missing-workflow-tool-executors.js"))};
    let invalidBridgeRejected = false;
    try {
      await createMcpServer({});
    } catch {
      invalidBridgeRejected = true;
    } finally {
      delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    }
    if (!invalidBridgeRejected) {
      throw new Error("packed MCP public API accepted an invalid workflow bridge");
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", publicApiScript], {
    cwd: installDir,
    stdio: "inherit",
    timeout: 30_000,
  });

  const binEntry = installedManifest.bin?.["gsd-mcp-server"];
  if (typeof binEntry !== "string") throw new Error("packed @opengsd/mcp-server has no gsd-mcp-server bin");
  const binPath = resolve(dirname(installedManifestPath), binEntry);
  const handshakeScript = `
    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

    function withTimeout(promise, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), 10_000);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [${JSON.stringify(binPath)}],
      cwd: ${JSON.stringify(installDir)},
      env: {
        GSD_CODING_AGENT_DIR: ${JSON.stringify(join(installDir, "agent"))},
        GSD_HOME: ${JSON.stringify(join(installDir, ".gsd"))},
        GSD_MCP_CLIENT_MANAGED: "1",
        GSD_MCP_PROBE: "1",
        GSD_WORKFLOW_PROJECT_ROOT: ${JSON.stringify(installDir)},
      },
      stderr: "pipe",
    });
    let serverStderr = "";
    transport.stderr?.on("data", (chunk) => {
      serverStderr += chunk.toString();
    });
    const client = new Client({ name: "mcp-server-tarball-validator", version: "1.0.0" });

    try {
      await withTimeout(client.connect(transport), "MCP connect");
      const { tools } = await withTimeout(client.listTools(), "MCP tools/list");
      if (!tools.some((tool) => tool.name === "gsd_execute")) {
        throw new Error("packed MCP server did not advertise gsd_execute");
      }
      if (tools.some((tool) => tool.name === "gsd_summary_save")) {
        throw new Error("packed MCP server advertised workflow tools without a workflow bridge");
      }
    } catch (err) {
      if (serverStderr) process.stderr.write(serverStderr);
      throw err;
    } finally {
      await client.close();
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", handshakeScript], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 30_000,
  });

  console.log("@opengsd/mcp-server standalone tarball install, import, and MCP handshake are valid.");
} finally {
  try {
    execFileSync(process.execPath, [join(root, "scripts", "postpack-restore-workspace.cjs")], {
      cwd: root,
      stdio: "inherit",
    });
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(npmCacheDir, { recursive: true, force: true });
  }
}
