import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { load as loadWithTestLoader, resolve as resolveWithTestLoader } from "../resources/extensions/gsd/tests/dist-redirect.mjs"

const nextResolve = async (specifier: string) => ({ url: specifier })

const cases = [
  ["@gsd/pi-coding-agent", "../../packages/pi-coding-agent/src/index.ts"],
] as const

test("resolve-ts loader redirects pi-coding-agent bare imports to the workspace source entrypoint", async () => {
  for (const [specifier, relativeTarget] of cases) {
    const resolved = await resolveWithTestLoader(specifier, {}, nextResolve)
    assert.equal(
      resolved.url,
      new URL(relativeTarget, import.meta.url).href,
      `${specifier} should resolve to ${relativeTarget}`,
    )
  }
})

test("resolve-ts loader rewrites direct pi-coding-agent source entry import to .ts", async () => {
  const resolved = await resolveWithTestLoader(
    "../../packages/pi-coding-agent/src/index.js",
    {},
    nextResolve,
  )

  assert.equal(
    resolved.url,
    new URL("../../packages/pi-coding-agent/src/index.ts", import.meta.url).href,
  )
})

test("resolve-ts loader transpiles pi-coding-agent source files that strip-only mode cannot parse", async () => {
  const agentUrl = new URL(
    "../../packages/pi-agent-core/src/agent.ts",
    import.meta.url,
  ).href

  const loaded = await loadWithTestLoader(agentUrl, {}, async () => {
    throw new Error("expected pi-coding-agent source to be transpiled before nextLoad")
  })

  assert.equal(loaded.format, "module")
  assert.equal(loaded.shortCircuit, true)
  assert.match(loaded.source, /class Agent/, "transpiled source should include the Agent class")
  assert.doesNotMatch(loaded.source, /private readonly listeners/, "TypeScript field modifiers should be removed")
})

test("resolve-ts loader allows source-mode DB provider to require node:sqlite", () => {
  const loaderPath = fileURLToPath(
    new URL("../resources/extensions/gsd/tests/resolve-ts.mjs", import.meta.url),
  )

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      loaderPath,
      "--experimental-strip-types",
      "-e",
      "const sqlite = require('node:sqlite'); console.log(typeof sqlite.DatabaseSync)",
    ],
    { encoding: "utf-8" },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "function")
})
