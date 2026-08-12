/**
 * Tests for package-manager.ts — shared package manager detection utilities.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPackageManager, buildScriptCommand } from "../package-manager.js";

describe("package-manager: detectPackageManager", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-pm-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("pnpm-lock.yaml → pnpm", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
    assert.equal(detectPackageManager(tmp), "pnpm");
  });

  test("yarn.lock → yarn", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "yarn.lock"), "# yarn lockfile v1");
    assert.equal(detectPackageManager(tmp), "yarn");
  });

  test("bun.lockb → bun", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "bun.lockb"), "binary");
    assert.equal(detectPackageManager(tmp), "bun");
  });

  test("bun.lock (text format) → bun", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "bun.lock"), "bun lockfile");
    assert.equal(detectPackageManager(tmp), "bun");
  });

  test("package-lock.json → npm", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "package-lock.json"), "{}");
    assert.equal(detectPackageManager(tmp), "npm");
  });

  test("packageManager field pnpm@x.y.z → pnpm (no lock file)", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.12.2" }),
    );
    assert.equal(detectPackageManager(tmp), "pnpm");
  });

  test("packageManager field yarn@x.y.z → yarn (no lock file)", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.0.0" }),
    );
    assert.equal(detectPackageManager(tmp), "yarn");
  });

  test("lock file takes precedence over packageManager field", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0" }),
    );
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
    assert.equal(detectPackageManager(tmp), "pnpm");
  });

  test("package.json only → npm fallback", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    assert.equal(detectPackageManager(tmp), "npm");
  });

  test("no package.json → undefined", () => {
    assert.equal(detectPackageManager(tmp), undefined);
  });

  test("malformed package.json → npm fallback", () => {
    writeFileSync(join(tmp, "package.json"), "not json");
    assert.equal(detectPackageManager(tmp), "npm");
  });
});

describe("package-manager: buildScriptCommand", () => {
  test("npm test → npm test (special shorthand)", () => {
    assert.equal(buildScriptCommand("npm", "test"), "npm test");
  });

  test("npm lint → npm run lint", () => {
    assert.equal(buildScriptCommand("npm", "lint"), "npm run lint");
  });

  test("npm typecheck → npm run typecheck", () => {
    assert.equal(buildScriptCommand("npm", "typecheck"), "npm run typecheck");
  });

  test("pnpm test → pnpm test (implicit run)", () => {
    assert.equal(buildScriptCommand("pnpm", "test"), "pnpm test");
  });

  test("pnpm lint → pnpm lint (implicit run)", () => {
    assert.equal(buildScriptCommand("pnpm", "lint"), "pnpm lint");
  });

  test("yarn test → yarn test (implicit run)", () => {
    assert.equal(buildScriptCommand("yarn", "test"), "yarn test");
  });

  test("yarn typecheck → yarn typecheck (implicit run)", () => {
    assert.equal(buildScriptCommand("yarn", "typecheck"), "yarn typecheck");
  });

  test("bun test → bun run test (explicit run)", () => {
    assert.equal(buildScriptCommand("bun", "test"), "bun run test");
  });

  test("bun build → bun run build (explicit run)", () => {
    assert.equal(buildScriptCommand("bun", "build"), "bun run build");
  });
});
