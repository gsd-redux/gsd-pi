/**
 * Native addon loader.
 *
 * Locates and loads the compiled Rust N-API addon (`.node` file).
 * Resolution order:
 *   1. native/addon/gsd_engine.{platform}.node / gsd_engine.dev.node when a
 *      local build is present (or when GSD_NATIVE_PREFER_LOCAL=1 forces it).
 *      The pinned npm binary is documented to lag the Rust source, so a
 *      present local build is always the better match for the source tree.
 *   2. @opengsd/engine-{platform} npm optional dependency (production install,
 *      where no native/addon directory exists)
 *   3. local builds retried as a last resort (covers a local build that
 *      appeared between the existence check and here)
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
// Type-only import (erased at compile time — no runtime cycle): the lock
// class shapes are defined once in file-identity/index.ts and referenced here
// so the two surfaces cannot drift apart.
import type { ProjectionRootIdentityLock, SqliteFileIdentityLock } from "./file-identity/index.js";

// __dirname and require are available in both execution contexts:
//   - CJS (production build via tsc): provided natively by Node
//   - ESM (CI test loader): injected by the dist-redirect.mjs preamble
const _dirname = __dirname;
const _require = require;

const addonDir = path.resolve(_dirname, "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;

/** Map Node.js platform/arch to the npm package suffix */
const platformPackageMap: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
};

let _loadedSuccessfully = false;

// Exports the source tree expects that the pinned @opengsd/engine-* binary is
// documented to lag (CI builds from source for exactly this reason). Used to
// flag a stale-but-loadable addon so the failure detail names the real cause
// instead of surfacing later as a bare "unavailable" error.
const EXPECTED_LOCK_EXPORTS = ["SqliteFileIdentityLock", "ProjectionRootIdentityLock"] as const;

function warnIfStale(loaded: Record<string, unknown>, source: string): void {
  const missing = EXPECTED_LOCK_EXPORTS.filter((name) => typeof loaded[name] !== "function");
  if (missing.length === 0) return;
  process.stderr.write(
    `[gsd] Native addon from ${source} is stale: it lacks exports the source tree expects (${missing.join(", ")}). ` +
      `Build the local addon (pnpm run build:native:dev) or update the pinned @opengsd/engine-* package.\n`,
  );
}

function loadNative(): Record<string, unknown> {
  const errors: string[] = [];

  if (process.env.GSD_NATIVE_DISABLE === "1") {
    errors.push("disabled by GSD_NATIVE_DISABLE=1");
  } else {
    const localCandidates = [
      path.join(addonDir, `gsd_engine.${platformTag}.node`),
      path.join(addonDir, "gsd_engine.dev.node"),
    ];
    // 0. Local builds first when one is present on disk (or when
    // GSD_NATIVE_PREFER_LOCAL=1 forces it explicitly). The pinned npm binary
    // only refreshes at release time and is documented to lag the Rust
    // source, so a present local build is always the better match for this
    // source tree; the env var remains as an explicit override that attempts
    // the local paths even when they do not exist yet.
    const preferLocal = process.env.GSD_NATIVE_PREFER_LOCAL === "1"
      || localCandidates.some((candidate) => existsSync(candidate));
    if (preferLocal) {
      for (const candidate of localCandidates) {
        try {
          const loaded = _require(candidate) as Record<string, unknown>;
          _loadedSuccessfully = true;
          warnIfStale(loaded, candidate);
          return loaded;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${candidate} (local): ${message}`);
        }
      }
    }

    // 1. Try the platform-specific npm optional dependency (production
    // fallback — reached only when no local build is present)
    const packageSuffix = platformPackageMap[platformTag];
    if (packageSuffix) {
      try {
        const loaded = _require(`@opengsd/engine-${packageSuffix}`) as Record<string, unknown>;
        _loadedSuccessfully = true;
        warnIfStale(loaded, `@opengsd/engine-${packageSuffix}`);
        return loaded;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`@opengsd/engine-${packageSuffix}: ${message}`);
      }
    }

    // 2. Try local release build (native/addon/gsd_engine.{platform}.node)
    const releasePath = localCandidates[0];
    try {
      const loaded = _require(releasePath) as Record<string, unknown>;
      _loadedSuccessfully = true;
      warnIfStale(loaded, releasePath);
      return loaded;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${releasePath}: ${message}`);
    }

    // 3. Try local dev build (native/addon/gsd_engine.dev.node)
    const devPath = localCandidates[1];
    try {
      const loaded = _require(devPath) as Record<string, unknown>;
      _loadedSuccessfully = true;
      warnIfStale(loaded, devPath);
      return loaded;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${devPath}: ${message}`);
    }
  }

  const details = errors.map((e) => `  - ${e}`).join("\n");
  const supportedPlatforms = Object.keys(platformPackageMap);

  // Graceful fallback: on unsupported platforms (e.g., win32-arm64), return a
  // proxy that throws on individual function calls rather than crashing the
  // entire import chain at startup (#1223). Consumers with JS fallbacks
  // (parseRoadmap, parsePlan, fuzzyFind, etc.) catch these and degrade gracefully.
  process.stderr.write(
    `[gsd] Native addon not available for ${platformTag}. Falling back to JS implementations (slower).\n` +
      `  Supported native platforms: ${supportedPlatforms.join(", ")}\n`,
  );
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return (..._args: unknown[]) => {
        throw new Error(`Native function '${String(prop)}' is not available on ${platformTag}`);
      };
    },
  });
}

/** True when a real `.node` addon was loaded (not the throw-on-call proxy). */
export function isNativeAddonLoaded(): boolean {
  return _loadedSuccessfully;
}

export const native = loadNative() as {
  SqliteFileIdentityLock: new (path: string, create: boolean) => SqliteFileIdentityLock;
  ProjectionRootIdentityLock: new (
    path: string,
    expectedDevice: string,
    expectedInode: string,
  ) => ProjectionRootIdentityLock;
  syncDirectoryEntry: (path: string) => void;
  search: (content: Buffer | Uint8Array, options: unknown) => unknown;
  grep: (options: unknown) => unknown;
  killTree: (pid: number, signal: number) => number;
  listDescendants: (pid: number) => number[];
  processGroupId: (pid: number) => number | null;
  killProcessGroup: (pgid: number, signal: number) => boolean;
  glob: (
    options: unknown,
    onMatch?: ((match: unknown) => void) | undefined | null,
  ) => Promise<unknown>;
  invalidateFsScanCache: (path?: string) => void;
  highlightCode: (code: string, lang: string | null, colors: unknown) => unknown;
  supportsLanguage: (lang: string) => unknown;
  getSupportedLanguages: () => unknown;
  copyToClipboard: (text: string) => void;
  readTextFromClipboard: () => string | null;
  readImageFromClipboard: () => Promise<unknown>;
  astGrep: (options: unknown) => unknown;
  astEdit: (options: unknown) => unknown;
  htmlToMarkdown: (html: string, options: unknown) => unknown;
  wrapTextWithAnsi: (text: string, width: number, tabWidth?: number) => string[];
  truncateToWidth: (
    text: string,
    maxWidth: number,
    ellipsisKind: number,
    pad: boolean,
    tabWidth?: number,
  ) => string;
  sliceWithWidth: (
    line: string,
    startCol: number,
    length: number,
    strict: boolean,
    tabWidth?: number,
  ) => unknown;
  extractSegments: (
    line: string,
    beforeEnd: number,
    afterStart: number,
    afterLen: number,
    strictAfter: boolean,
    tabWidth?: number,
  ) => unknown;
  sanitizeText: (text: string) => string;
  visibleWidth: (text: string, tabWidth?: number) => number;
  fuzzyFind: (options: unknown) => unknown;
  normalizeForFuzzyMatch: (text: string) => string;
  fuzzyFindText: (content: string, oldText: string) => unknown;
  generateDiff: (oldContent: string, newContent: string, contextLines?: number) => unknown;
  NativeImage: unknown;
  ttsrCompileRules: (rules: unknown[]) => number;
  ttsrCheckBuffer: (handle: number, buffer: string) => string[];
  ttsrFreeRules: (handle: number) => void;
  processStreamChunk: (chunk: Buffer, state?: unknown) => unknown;
  stripAnsiNative: (text: string) => string;
  sanitizeBinaryOutputNative: (text: string) => string;
  parseFrontmatter: (content: string) => unknown;
  extractSection: (content: string, heading: string, level?: number) => unknown;
  extractAllSections: (content: string, level?: number) => string;
  batchParseGsdFiles: (directory: string) => unknown;
  parseRoadmapFile: (content: string) => unknown;
  truncateTail: (text: string, maxBytes: number) => unknown;
  truncateHead: (text: string, maxBytes: number) => unknown;
  truncateOutput: (text: string, maxBytes: number, mode?: string) => unknown;
  parseJson: (text: string) => unknown;
  parsePartialJson: (text: string) => unknown;
  parseStreamingJson: (text: string) => unknown;
  xxHash32: (input: string, seed: number) => number;
};
