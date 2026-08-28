/**
 * Extension Registry — manages manifest reading, registry persistence, and enable/disable state.
 *
 * Extensions without manifests always load (backwards compatible).
 * A fresh install has an empty registry — all extensions enabled by default.
 * The only way an extension stops loading is an explicit `gsd extensions disable <id>`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { appRoot } from "./app-paths.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLockSync } from "./resources/extensions/gsd/file-lock.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: "core" | "bundled" | "community";
  requires: { platform: string };
  provides?: {
    tools?: string[];
    commands?: string[];
    hooks?: string[];
    shortcuts?: string[];
  };
  dependencies?: {
    extensions?: string[];
    runtime?: string[];
  };
}

export interface ExtensionRegistryEntry {
  id: string;
  enabled: boolean;
  source: "bundled" | "user" | "project";
  disabledAt?: string;
  disabledReason?: string;
  version?: string;           // From manifest, used for semver comparison
  installedFrom?: string;     // Original specifier: npm package name, git URL, or local path
  installType?: "npm" | "git" | "local";  // Explicit source type
  extensionDir?: string;      // Manifest directory for package-managed extensions
  projectDir?: string;        // Owning project for project-local package installs
}

export interface ExtensionRegistry {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
}

export type InstalledExtensionRegistryEntry = ExtensionRegistryEntry & {
  source: "user" | "project";
};

// ─── Validation ─────────────────────────────────────────────────────────────

function isRegistry(data: unknown): data is ExtensionRegistry {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.version === 1 && typeof obj.entries === "object" && obj.entries !== null;
}

function isManifest(data: unknown): data is ExtensionManifest {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.version === "string" &&
    typeof obj.tier === "string"
  );
}

// ─── Registry Path ──────────────────────────────────────────────────────────

function getRegistryPath(): string {
  return join(appRoot, "extensions", "registry.json");
}

// ─── Registry I/O ───────────────────────────────────────────────────────────

function defaultRegistry(): ExtensionRegistry {
  return { version: 1, entries: {} };
}

export function loadRegistry(filePath = getRegistryPath()): ExtensionRegistry {
  try {
    if (!existsSync(filePath)) return defaultRegistry();
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRegistry(parsed) ? parsed : defaultRegistry();
  } catch {
    return defaultRegistry();
  }
}

function saveRegistry(registry: ExtensionRegistry, filePath = getRegistryPath()): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
    // Non-fatal — don't let persistence failures break operation
  }
}

function mutateRegistry(filePath: string, mutate: (registry: ExtensionRegistry) => void): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    try {
      writeFileSync(filePath, JSON.stringify(defaultRegistry(), null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  withFileLockSync(filePath, () => {
    const registry = loadRegistry(filePath);
    mutate(registry);
    saveRegistry(registry, filePath);
  });
}

function getInstallMetadata(source: string, cwd: string): {
  installedFrom: string;
  installType: "npm" | "git" | "local";
} {
  if (source.startsWith("npm:")) {
    return { installedFrom: source.slice("npm:".length).trim(), installType: "npm" };
  }
  if (
    source.startsWith("git:") ||
    source.startsWith("github:") ||
    source.startsWith("http:") ||
    source.startsWith("https:") ||
    source.startsWith("ssh:")
  ) {
    return { installedFrom: source, installType: "git" };
  }
  const expanded = source === "~"
    ? homedir()
    : source.startsWith("~/")
      ? join(homedir(), source.slice(2))
      : source;
  return { installedFrom: resolve(cwd, expanded), installType: "local" };
}

/** Return user/project extensions that should appear in the shell package listing. */
export function listInstalledExtensions(
  cwd: string,
  registry = loadRegistry(),
): InstalledExtensionRegistryEntry[] {
  const resolvedCwd = resolve(cwd);
  return Object.values(registry.entries).filter(
    (entry): entry is InstalledExtensionRegistryEntry =>
      entry.source === "user" ||
      (entry.source === "project" && entry.projectDir === resolvedCwd),
  );
}

/** Register extension manifests resolved from a successful shell package install. */
export function registerPackageExtensions(
  source: string,
  scope: "user" | "project",
  cwd: string,
  extensions: Array<{ path: string; packageRoot?: string }>,
  registryPath = getRegistryPath(),
): void {
  const install = getInstallMetadata(source, cwd);
  const installedEntries: Array<[string, ExtensionRegistryEntry]> = [];

  for (const extension of extensions) {
    const entryDir = dirname(extension.path);
    const entryManifest = readManifest(entryDir);
    const packageManifest = extension.packageRoot ? readManifest(extension.packageRoot) : null;
    const manifest = entryManifest ?? packageManifest;
    if (!manifest) continue;

    const registryKey = scope === "project"
      ? `${manifest.id}::project::${resolve(cwd)}`
      : manifest.id;
    installedEntries.push([registryKey, {
      id: manifest.id,
      enabled: true,
      source: scope,
      version: manifest.version,
      installedFrom: install.installedFrom,
      installType: install.installType,
      extensionDir: entryManifest ? entryDir : extension.packageRoot,
      projectDir: scope === "project" ? resolve(cwd) : undefined,
    }]);
  }

  if (installedEntries.length === 0) return;
  mutateRegistry(registryPath, (registry) => {
    for (const [key, entry] of installedEntries) registry.entries[key] = entry;
  });
}

/** Remove package-managed registry entries after a successful shell package removal. */
export function unregisterPackageExtensions(
  source: string,
  scope: "user" | "project",
  cwd: string,
  registryPath = getRegistryPath(),
): void {
  if (!existsSync(registryPath)) return;
  const install = getInstallMetadata(source, cwd);
  const projectDir = scope === "project" ? resolve(cwd) : undefined;
  mutateRegistry(registryPath, (registry) => {
    for (const [id, entry] of Object.entries(registry.entries)) {
      if (
        entry.extensionDir &&
        entry.source === scope &&
        entry.installedFrom === install.installedFrom &&
        entry.projectDir === projectDir
      ) {
        delete registry.entries[id];
      }
    }
  });
}

// ─── Query ──────────────────────────────────────────────────────────────────

/** Returns true if the extension is enabled (missing entries default to enabled). */
export function isExtensionEnabled(registry: ExtensionRegistry, id: string): boolean {
  const currentProject = resolve(process.cwd());
  const projectEntry = Object.values(registry.entries).find(
    (entry) => entry.id === id && entry.source === "project" && entry.projectDir === currentProject,
  );
  const entry = projectEntry ?? registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

function enableExtension(registry: ExtensionRegistry, id: string): void {
  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = true;
    delete entry.disabledAt;
    delete entry.disabledReason;
  } else {
    registry.entries[id] = { id, enabled: true, source: "bundled" };
  }
}

/**
 * Disable an extension. Returns an error string if the extension is core (cannot disable),
 * or null on success.
 */
function disableExtension(
  registry: ExtensionRegistry,
  id: string,
  manifest: ExtensionManifest | null,
  reason?: string,
): string | null {
  if (manifest?.tier === "core") {
    return `Cannot disable "${id}" — it is a core extension.`;
  }
  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = false;
    entry.disabledAt = new Date().toISOString();
    entry.disabledReason = reason;
  } else {
    registry.entries[id] = {
      id,
      enabled: false,
      source: "bundled",
      disabledAt: new Date().toISOString(),
      disabledReason: reason,
    };
  }
  return null;
}

// ─── Manifest Reading ───────────────────────────────────────────────────────

/** Read extension-manifest.json from a directory. Returns null if missing or invalid. */
export function readManifest(extensionDir: string): ExtensionManifest | null {
  const manifestPath = join(extensionDir, "extension-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return isManifest(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Given an entry path (e.g. `.../extensions/browser-tools/index.ts`),
 * resolve the parent directory and read its manifest.
 */
export function readManifestFromEntryPath(entryPath: string): ExtensionManifest | null {
  let dir = dirname(resolve(entryPath));
  while (true) {
    const manifest = readManifest(dir);
    if (manifest) return manifest;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Scan all subdirectories of extensionsDir for manifests. Returns a Map<id, manifest>. */
function discoverAllManifests(extensionsDir: string): Map<string, ExtensionManifest> {
  const manifests = new Map<string, ExtensionManifest>();
  if (!existsSync(extensionsDir)) return manifests;

  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(extensionsDir, entry.name));
    if (manifest) {
      manifests.set(manifest.id, manifest);
    }
  }
  return manifests;
}

/**
 * Auto-populate registry entries for newly discovered extensions.
 * Extensions already in the registry are left untouched.
 */
export function ensureRegistryEntries(extensionsDir: string): void {
  const manifests = discoverAllManifests(extensionsDir);
  if (manifests.size === 0) return;

  const registry = loadRegistry();
  let changed = false;

  for (const [id, manifest] of manifests) {
    if (!registry.entries[id]) {
      registry.entries[id] = {
        id,
        enabled: true,
        source: "bundled",
      };
      changed = true;
    }
  }

  if (changed) {
    saveRegistry(registry);
  }
}
