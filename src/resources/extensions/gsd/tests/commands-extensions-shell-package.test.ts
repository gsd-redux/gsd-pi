import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { handleExtensions } from "../commands-extensions.ts";

test("extension list discovers shell-installed npm package manifests", async (t) => {
  const previousGsdHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-shell-extension-list-"));
  process.env.GSD_HOME = home;
  t.after(() => {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(home, { recursive: true, force: true });
  });

  const packageDir = join(home, "agent", "npm", "node_modules", "@example", "demo-extension");
  mkdirSync(packageDir, { recursive: true });
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
  mkdirSync(join(home, "extensions"), { recursive: true });
  writeFileSync(
    join(home, "extensions", "registry.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "example.demo": {
          id: "example.demo",
          enabled: true,
          source: "user",
          version: "2.3.4",
          installedFrom: "@example/demo-extension@2.3.4",
          installType: "npm",
        },
      },
    }),
  );

  const notices: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  await handleExtensions("list", ctx);

  const output = notices.join("\n");
  assert.match(output, /example\.demo \(Demo Extension\)/);
  assert.match(output, /\[user\]/);
  assert.match(output, /installed from: npm:@example\/demo-extension@2\.3\.4/);
  assert.doesNotMatch(output, /@2\.3\.4@2\.3\.4/);
});
