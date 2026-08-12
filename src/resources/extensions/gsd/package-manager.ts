/**
 * Package Manager Detection — Shared utilities for detecting and using
 * the correct package manager in a project.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Detect the package manager used by a project.
 *
 * Detection order (first match wins):
 * 1. Lock files (most reliable — reflects actual installed state)
 * 2. packageManager field in package.json (Corepack)
 * 3. Fallback to npm if package.json exists
 *
 * @param cwd - Project root directory
 * @returns Detected package manager, or undefined if no supported marker exists
 */
export function detectPackageManager(cwd: string): PackageManager | undefined {
  // Lock files take precedence — they reflect actual installed state
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";

  // Check package.json for packageManager field (Corepack)
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && typeof pkg.packageManager === "string") {
        // packageManager format: "pnpm@9.12.2" or "yarn@4.0.0"
        const match = pkg.packageManager.match(/^(npm|pnpm|yarn|bun)@/);
        if (match) return match[1] as PackageManager;
      }
    } catch {
      // Ignore parse errors, fall through to npm default
    }
    // Has package.json but no lock file or packageManager field
    return "npm";
  }

  return undefined;
}

/**
 * Build a canonical command to run a package.json script.
 *
 * - npm: `npm test` for the test script, otherwise `npm run <script>`
 * - pnpm/yarn: `<pm> <script>` (implicit run is idiomatic)
 * - bun: `bun run <script>` (avoids collisions with built-in commands)
 *
 * This matches the project’s package-manager conventions and the verification
 * rules used when interpreting shell commands.
 *
 * @param pm - Package manager to use
 * @param script - Script name from package.json
 * @returns Full command string
 */
export function buildScriptCommand(pm: PackageManager, script: string): string {
  if (pm === "npm") {
    if (script === "test") return "npm test";
    return `npm run ${script}`;
  }
  if (pm === "bun") return `bun run ${script}`;
  // pnpm and yarn support implicit run — more idiomatic
  return `${pm} ${script}`;
}
