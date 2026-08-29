import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = resolve(new URL("../../", import.meta.url).pathname);

async function importValidatePackWithRootPackage(rootPackageJson) {
  const outdir = await mkdtemp(join(tmpdir(), "validate-pack-test-"));
  const outfile = join(outdir, "entry.mjs");
  const logs = [];
  const plugin = {
    name: "validate-pack-stubs",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^node:(child_process|fs|module|os)$/ }, (args) => ({
        path: args.path,
        namespace: "validate-pack-stub",
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "validate-pack-stub" }, (args) => {
        const stubs = {
          "node:child_process": `
            export function execFileSync(command, args) {
              globalThis.__validatePackStubCalls = globalThis.__validatePackStubCalls || [];
              globalThis.__validatePackStubCalls.push(String(args?.[1] ?? command));
              return "";
            }
          `,
          "node:fs": `
            export function copyFileSync() {}
            export function cpSync() {}
            export function existsSync() { return true; }
            export function mkdirSync() {}
            export function mkdtempSync(prefix) { return prefix + "stub"; }
            export function readdirSync() { return []; }
            export function readFileSync(path) {
              if (String(path).endsWith("package.json")) return ${JSON.stringify(JSON.stringify(rootPackageJson))};
              return "";
            }
            export function rmSync() {}
            export function statSync() { return { isDirectory: () => true, size: 1234 }; }
            export function writeFileSync() {}
          `,
          "node:module": `
            export function createRequire() {
              return () => ({ getLinkablePackages: () => [] });
            }
          `,
          "node:os": `
            export function tmpdir() { return "/tmp"; }
          `,
        };
        return { contents: stubs[args.path], loader: "js", resolveDir: root };
      });
    },
  };
  await build({
    entryPoints: [join(root, "scripts/validate-pack.js")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [plugin],
  });

  const originalLog = console.log;
  const originalExit = process.exit;
  console.log = (...values) => {
    logs.push(values.map(String).join(" "));
  };
  process.exit = ((code) => {
    const error = new Error(`process.exit(${code})`);
    error.code = code;
    throw error;
  });
  try {
    await import(pathToFileURL(outfile).href);
    assert.fail("validate-pack should have exited");
  } catch (error) {
    assert.equal(error.code, 1);
    return logs;
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
    delete globalThis.__validatePackStubCalls;
  }
}

test("validate-pack resolves workspace ranges first, then fails when they survive the rewrite", async () => {
  // The stubbed readFileSync always returns the same manifest, simulating a
  // prepack resolve that failed to rewrite the workspace range.
  const logs = await importValidatePackWithRootPackage({
    dependencies: {
      "@gsd/pi-ai": "workspace:*",
    },
  });
  const output = logs.join("\n");
  // The resolve must run BEFORE the leak guard (publish snapshot order).
  assert.match(output, /Resolving workspace:\* ranges for publishable manifest/);
  const resolveAt = output.indexOf("Resolving workspace:");
  const leakAt = output.indexOf("dependencies.@gsd/pi-ai=workspace:*");
  assert.ok(resolveAt !== -1 && leakAt > resolveAt, "leak check must observe the resolved state");
  assert.match(output, /check prepack-resolve-workspace\.cjs/);
  assert.doesNotMatch(output, /Packing tarball/);
});
