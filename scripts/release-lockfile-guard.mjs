#!/usr/bin/env node
/**
 * Guard for the npm-publish "Fold native packages into release lockfile" step.
 *
 * The fold runs `pnpm install --lockfile-only`, which consults pnpm's registry
 * metadata cache. A packument cached earlier in the job — from before the
 * `@opengsd/engine-*` packages were published — makes pnpm silently drop an
 * engine from the regenerated lockfile (observed on 1.17.0 with
 * win32-x64-msvc, #2067), and the auto-opened release PR then fails
 * ERR_PNPM_OUTDATED_LOCKFILE in every CI job.
 *
 * This guard turns that silent drop into a loud, machine-checkable failure:
 * the fold step retries `pnpm install --lockfile-only` until this check
 * passes (registry caches expire), and fails the release otherwise.
 *
 * CLI:
 *   node scripts/release-lockfile-guard.mjs verify-lockfile --version 1.17.0 [--lockfile pnpm-lock.yaml]
 *
 * Exit 0 when every engine resolves at `version`; exit 1 with the missing
 * list on stderr otherwise. Exit 2 on usage errors.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Engine platforms published by the release flow — single source of truth. */
export const ENGINE_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
];

/**
 * Platforms whose engine entry is absent from `lockfileContent`.
 *
 * pnpm serializes lockfile keys as quoted strings:
 *   '@opengsd/engine-<platform>@<version>':
 * Requiring the trailing colon distinguishes an exact entry from a longer
 * version string that merely shares the prefix.
 */
export function missingEngines({ lockfileContent, version, platforms = ENGINE_PLATFORMS }) {
  return platforms.filter(
    (platform) => !lockfileContent.includes(`'@opengsd/engine-${platform}@${version}':`),
  );
}

function parseArgs(argv) {
  const args = { command: undefined, version: undefined, lockfile: "pnpm-lock.yaml" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "verify-lockfile") {
      args.command = "verify-lockfile";
    } else if (argv[i] === "--version") {
      args.version = argv[++i];
    } else if (argv[i] === "--lockfile") {
      args.lockfile = argv[++i];
    }
  }
  return args;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "verify-lockfile" || !args.version) {
    console.error(
      "usage: release-lockfile-guard.mjs verify-lockfile --version <release-version> [--lockfile <path>]",
    );
    process.exit(2);
  }

  let lockfileContent;
  try {
    lockfileContent = readFileSync(args.lockfile, "utf8");
  } catch (err) {
    console.error(`Cannot read lockfile ${args.lockfile}: ${err.message}`);
    process.exit(2);
  }

  const missing = missingEngines({ lockfileContent, version: args.version });
  if (missing.length > 0) {
    console.error(
      `Release lockfile ${args.lockfile} is missing engine packages at version ${args.version}:`,
    );
    for (const platform of missing) {
      console.error(`  - @opengsd/engine-${platform}@${args.version}`);
    }
    process.exit(1);
  }

  console.log(
    `All ${ENGINE_PLATFORMS.length} engine packages resolve at ${args.version} in ${args.lockfile}.`,
  );
}
