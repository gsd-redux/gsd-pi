#!/usr/bin/env node

// Project/App: gsd-pi
// File Purpose: Emit normalized local semantic-shadow capstone evidence to stdout.

import { resolve } from "node:path";

import {
  collectSemanticShadowCapstoneEvidence,
  normalizeSemanticShadowCapstoneEvidence,
} from "./semantic-shadow-capstone-harness.ts";

const sourceRoot = resolve(process.argv[2] ?? process.cwd());
const evidence = await collectSemanticShadowCapstoneEvidence({ sourceRoot });
process.stdout.write(`${JSON.stringify(normalizeSemanticShadowCapstoneEvidence(evidence), null, 2)}\n`);
