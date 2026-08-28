import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readManifestFromEntryPath } from "../extension-registry.ts";

test("readManifestFromEntryPath finds a manifest above a nested package entry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "extension-registry-nested-"));
  const extensionDir = join(root, "extensions", "nested-extension");
  const entryPath = join(extensionDir, "src", "extensions", "index.js");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(extensionDir, "src", "extensions"), { recursive: true });
  writeFileSync(
    join(extensionDir, "extension-manifest.json"),
    JSON.stringify({ id: "nested", name: "Nested", version: "1.0.0", tier: "community" }),
  );
  writeFileSync(entryPath, "export default function() {};");

  assert.equal(readManifestFromEntryPath(entryPath)?.id, "nested");
});
