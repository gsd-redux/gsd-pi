import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FileExists = (path: string) => boolean;

export function resolvePackageRoot(importUrl: string): string {
  const moduleDir = dirname(fileURLToPath(importUrl));
  return resolve(moduleDir, "..");
}

function hasCompleteBundledResources(
  resourcesDir: string,
  fileExists: FileExists = existsSync,
): boolean {
  return fileExists(join(resourcesDir, "agents")) &&
    fileExists(join(resourcesDir, "extensions"));
}

export function resolveBundledResourcesDirFromPackageRoot(
  packageRoot: string,
  fileExists: FileExists = existsSync,
): string {
  const distResources = join(packageRoot, "dist", "resources");
  const srcResources = join(packageRoot, "src", "resources");
  return hasCompleteBundledResources(distResources, fileExists)
    ? distResources
    : srcResources;
}

function resolveBundledResourcesDir(
  importUrl: string,
  fileExists: FileExists = existsSync,
): string {
  return resolveBundledResourcesDirFromPackageRoot(resolvePackageRoot(importUrl), fileExists);
}

function resolveBundledResource(
  importUrl: string,
  ...segments: string[]
): string {
  return join(resolveBundledResourcesDir(importUrl), ...segments);
}

export function resolveBundledGsdExtensionModule(
  importUrl: string,
  moduleFile: string,
  fileExists: FileExists = existsSync,
): string {
  const packageRoot = resolvePackageRoot(importUrl);
  // Extension modules are loaded via jiti from raw TypeScript. Compiled dist/*.js
  // copies pull @gsd/* through CJS require, which cannot load the ESM workspace
  // packages that dist-test mirrors — always use the source .ts entry.
  const tsFile = moduleFile.replace(/\.js$/, ".ts");
  return join(packageRoot, "src", "resources", "extensions", "gsd", tsFile);
}

/**
 * Resolve bundled raw resource files from the package root.
 *
 * Both `src/*.ts` and compiled `dist/*.js` entry points need to load the same
 * raw `.ts` resource modules via jiti. Those modules are shipped under
 * `src/resources/**`, not next to the compiled entry point.
 */
function resolveBundledSourceResource(
  importUrl: string,
  ...segments: string[]
): string {
  const packageRoot = resolvePackageRoot(importUrl);
  return join(packageRoot, "src", "resources", ...segments);
}
