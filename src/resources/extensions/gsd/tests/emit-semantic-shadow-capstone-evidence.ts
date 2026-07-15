#!/usr/bin/env node

// Project/App: gsd-pi
// File Purpose: Emit normalized local semantic-shadow capstone evidence to stdout or a local file.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectSemanticShadowCapstoneEvidence,
  normalizeSemanticShadowCapstoneEvidence,
} from "./semantic-shadow-capstone-harness.ts";

interface EmitterOptions {
  sourceRoot: string;
  outputPath?: string;
}

const REMOTE_PATH_PATTERN = /(?:^[a-z][a-z0-9+.-]*:\/\/|^git@|^\\\\|^\/\/|github\.com)/iu;

function localPath(value: string, label: string): string {
  if (!value.trim() || REMOTE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} must be a local filesystem path`);
  }
  return resolve(value);
}

export function parseEmitterArgs(args: string[]): EmitterOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !["--source-root", "--output"].includes(option)) {
      throw new Error(`Unknown argument: ${option ?? ""}`);
    }
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    if (values.has(option)) throw new Error(`Duplicate argument: ${option}`);
    values.set(option, value);
  }
  const sourceRoot = values.get("--source-root");
  if (!sourceRoot) throw new Error("Usage: emit-semantic-shadow-capstone-evidence --source-root <path> [--output <path>]");
  const output = values.get("--output");
  return {
    sourceRoot: localPath(sourceRoot, "Source root"),
    ...(output ? { outputPath: localPath(output, "Output") } : {}),
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseEmitterArgs(args);
  const evidence = await collectSemanticShadowCapstoneEvidence({ sourceRoot: options.sourceRoot });
  const serialized = `${JSON.stringify(normalizeSemanticShadowCapstoneEvidence(evidence), null, 2)}\n`;
  if (options.outputPath) writeFileSync(options.outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
