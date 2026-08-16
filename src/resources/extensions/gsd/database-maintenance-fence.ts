import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { getDatabaseReplacementPaths } from "./database-replacement-paths.js";
import { processStartIdentity } from "./process-start-identity.js";
import { syncDirectoryEntry } from "@gsd/native/directory-sync";

const owners = new AsyncLocalStorage<ReadonlySet<string>>();
const PROJECTION_CLAIM_RETRY_MS = 5;
const PROJECTION_CLAIM_MAX_ATTEMPTS = 1_000;
const projectionClaimSleep = new Int32Array(new SharedArrayBuffer(4));
let cachedCurrentProcessIdentity: string | null | undefined;
type ProjectionClaimReleaseBoundary = "after-link" | "after-primary-unlink" | "after-transition-unlink";
let projectionClaimReleaseBoundaryForTest: ((point: ProjectionClaimReleaseBoundary) => void) | null = null;
let projectionMutationBeforeClaimForTest: (() => void) | null = null;

export function _setProjectionClaimReleaseBoundaryForTest(
  boundary: ((point: ProjectionClaimReleaseBoundary) => void) | null,
): void {
  projectionClaimReleaseBoundaryForTest = boundary;
}

export function _setProjectionMutationBeforeClaimForTest(boundary: (() => void) | null): void {
  projectionMutationBeforeClaimForTest = boundary;
}

function waitForProjectionClaim(): void {
  Atomics.wait(projectionClaimSleep, 0, 0, PROJECTION_CLAIM_RETRY_MS);
}

function currentProcessIdentity(): string | null {
  if (cachedCurrentProcessIdentity === undefined) {
    cachedCurrentProcessIdentity = processStartIdentity(process.pid);
  }
  return cachedCurrentProcessIdentity;
}

function pathExistsFailClosed(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonicalDatabasePath(databasePath: string): string {
  try {
    return realpathSync.native(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot prove the database maintenance path", { cause: error });
    }
    try {
      return join(realpathSync.native(dirname(resolve(databasePath))), basename(databasePath));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot prove the database maintenance parent", { cause: parentError });
      }
      return resolve(databasePath);
    }
  }
}

export function databaseMaintenanceIntentPath(databasePath: string): string {
  return `${canonicalDatabasePath(databasePath)}.maintenance.json`;
}

interface ProjectionClaim {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface ProjectionClaimReleaseState {
  readonly claim: ProjectionClaim;
  readonly transition: string;
  transitionLinked: boolean;
  primaryRemoved: boolean;
  transitionRemoved: boolean;
  directorySynced: boolean;
}

interface ProjectionClaimContent {
  readonly pid: number;
  readonly identity: string;
}

/**
 * In-process ground truth for projection claim ownership, keyed by canonical
 * database path. The claim file alone cannot distinguish "held by another
 * process" from "held by another async task in this process" — both share the
 * same pid and start identity — so ownership within this process instance is
 * decided here, exactly like the live-restore `activeRestoreOwners` registry.
 *
 * - mutationDepth: ordinary projection mutations. Shareable: concurrent
 *   in-process mutations co-own one file claim (each write is individually
 *   atomic via temp-file + rename; the claim exists so foreign processes and
 *   maintenance stay fenced for the whole mutation epoch).
 * - maintenanceDepth: exclusive maintenance claims. Never shares with
 *   mutations — that is the genuine fence.
 * - ownerDepth: withDatabaseMaintenanceOwner scopes. No file claim; preserves
 *   the historical owner bypass while keeping it provably in-process.
 */
interface ProjectionClaimRegistryEntry {
  mutationDepth: number;
  maintenanceDepth: number;
  ownerDepth: number;
  claim: ProjectionClaim | null;
}

const projectionClaimRegistry = new Map<string, ProjectionClaimRegistryEntry>();

function registryEntryHeld(entry: ProjectionClaimRegistryEntry): boolean {
  return entry.mutationDepth > 0 || entry.maintenanceDepth > 0 || entry.ownerDepth > 0;
}

/**
 * True only when the current async context inherited a projection-owner grant
 * AND this process still holds a matching mutation/owner entry. The registry
 * check closes the AsyncLocalStorage leak: fire-and-forget tasks spawned
 * inside an operation keep the inherited store after the claim is released,
 * but without a live registry entry they no longer bypass the fences.
 * Maintenance-only holds deliberately do not qualify: owner scopes register
 * ownerDepth, so genuine maintenance work still passes, while stale contexts
 * from unrelated writes stay fenced during maintenance.
 */
function nestedProjectionOwnerActive(canonical: string): boolean {
  if (!owners.getStore()?.has(canonical)) return false;
  const entry = projectionClaimRegistry.get(canonical);
  return entry !== undefined && (entry.mutationDepth > 0 || entry.ownerDepth > 0);
}

function projectionClaimPath(databasePath: string): string {
  return `${canonicalDatabasePath(databasePath)}.projection.lock`;
}

function syncClaimDirectory(path: string): void {
  const directory = dirname(path);
  if (process.platform === "win32") {
    syncDirectoryEntry(directory);
    return;
  }
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Read and validate a claim file. Returns null when the claim disappeared
 * between the failed link and the read — a concurrent release or recovery —
 * which callers treat as retryable. Malformed claim content stays fail-closed.
 */
function readClaimOwner(path: string): ProjectionClaimContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim is invalid", { cause: error });
  }
  const value = parsed as Record<string, unknown>;
  const pid = Number(value["pid"]);
  const identity = value["processStartIdentity"];
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof identity !== "string") {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim is invalid");
  }
  return { pid, identity };
}

function claimOwnerIsActive(owner: ProjectionClaimContent, registryKey: string): boolean {
  if (owner.pid === process.pid && owner.identity === currentProcessIdentity()) {
    // Same process instance: the registry is ground truth. A claim file this
    // process published but no longer holds (left behind by a crashed
    // fire-and-forget write or an interrupted acquire) is stale and
    // recoverable, not active.
    const entry = projectionClaimRegistry.get(registryKey);
    return entry !== undefined && (entry.mutationDepth > 0 || entry.maintenanceDepth > 0);
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const current = processStartIdentity(owner.pid);
  return current === null || current === owner.identity;
}

function removeTransitionedClaim(path: string, transition: string): void {
  let linked: ReturnType<typeof lstatSync>;
  try {
    linked = lstatSync(transition);
  } catch (error) {
    // A concurrent recovery already unlinked both entries; nothing to do.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (pathExistsFailClosed(path)) {
    const current = lstatSync(path);
    if (current.dev !== linked.dev || current.ino !== linked.ino) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim changed during recovery");
    }
    unlinkSync(path);
  }
  unlinkSync(transition);
  syncClaimDirectory(path);
}

/** Returns true when no active recovery transition blocks acquisition; false to retry. */
function recoverProjectionTransition(path: string, transition: string, registryKey: string): boolean {
  if (!pathExistsFailClosed(transition)) return true;
  const owner = readClaimOwner(transition);
  if (owner !== null && claimOwnerIsActive(owner, registryKey)) return false;
  removeTransitionedClaim(path, transition);
  return true;
}

function acquireProjectionClaim(databasePath: string, waitForActiveOwner = true): ProjectionClaim {
  const path = projectionClaimPath(databasePath);
  const registryKey = path.slice(0, -".projection.lock".length);
  const transition = `${path}.transition`;
  for (let attempt = 0; attempt < PROJECTION_CLAIM_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) waitForProjectionClaim();
    if (!recoverProjectionTransition(path, transition, registryKey)) {
      if (!waitForActiveOwner) {
        throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection authority changed during claim acquisition");
      }
      continue;
    }
    const temporary = `${path}.pending-${process.pid}-${randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      const identity = currentProcessIdentity();
      if (identity === null) throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot prove projection claim identity");
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, processStartIdentity: identity, nonce: randomUUID() }));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(temporary, path);
      unlinkSync(temporary);
      syncClaimDirectory(path);
      const stat = lstatSync(path);
      return { path, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (pathExistsFailClosed(temporary)) unlinkSync(temporary);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readClaimOwner(path);
      if (owner === null) continue;
      if (claimOwnerIsActive(owner, registryKey)) {
        if (!waitForActiveOwner) {
          throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection authority changed during claim acquisition");
        }
        waitForProjectionClaim();
        continue;
      }
      try {
        linkSync(path, transition);
      } catch (transitionError) {
        // A concurrent recovery won the transition race, or the claim vanished
        // mid-recovery; either way the next attempt re-evaluates cleanly.
        if ((transitionError as NodeJS.ErrnoException).code === "EEXIST") {
          waitForProjectionClaim();
          continue;
        }
        if ((transitionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw transitionError;
      }
      const transitionOwner = readClaimOwner(transition);
      if (transitionOwner !== null && claimOwnerIsActive(transitionOwner, registryKey)) {
        unlinkSync(transition);
        throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim owner changed during recovery");
      }
      removeTransitionedClaim(path, transition);
    }
  }
  throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation remains fenced after the contention timeout");
}

function createProjectionClaimReleaseState(claim: ProjectionClaim): ProjectionClaimReleaseState {
  return {
    claim,
    transition: `${claim.path}.transition`,
    transitionLinked: false,
    primaryRemoved: false,
    transitionRemoved: false,
    directorySynced: false,
  };
}

function continueProjectionClaimRelease(state: ProjectionClaimReleaseState): void {
  const { claim, transition } = state;
  if (!state.transitionLinked) {
    const current = lstatSync(claim.path);
    if (current.dev !== claim.dev || current.ino !== claim.ino) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim ownership changed");
    }
    linkSync(claim.path, transition);
    state.transitionLinked = true;
    projectionClaimReleaseBoundaryForTest?.("after-link");
  }
  if (!state.primaryRemoved) {
    const current = lstatSync(claim.path);
    if (current.dev !== claim.dev || current.ino !== claim.ino) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim ownership changed");
    }
    unlinkSync(claim.path);
    state.primaryRemoved = true;
    projectionClaimReleaseBoundaryForTest?.("after-primary-unlink");
  }
  if (!state.transitionRemoved) {
    const linked = lstatSync(transition);
    if (linked.dev !== claim.dev || linked.ino !== claim.ino) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim ownership changed");
    }
    unlinkSync(transition);
    state.transitionRemoved = true;
    projectionClaimReleaseBoundaryForTest?.("after-transition-unlink");
  }
  if (!state.directorySynced) {
    syncClaimDirectory(claim.path);
    state.directorySynced = true;
  }
}

function releaseProjectionClaim(claim: ProjectionClaim): void {
  continueProjectionClaimRelease(createProjectionClaimReleaseState(claim));
}

function acquireMutationEntry(databasePath: string, canonical: string): void {
  const existing = projectionClaimRegistry.get(canonical);
  if (existing !== undefined) {
    if (existing.maintenanceDepth > 0) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation is fenced by active maintenance or publication");
    }
    // Co-own the live in-process claim. Writes are individually atomic; the
    // shared claim keeps foreign processes and maintenance fenced until the
    // last mutation releases.
    existing.mutationDepth++;
    return;
  }
  const claim = acquireProjectionClaim(databasePath);
  projectionClaimRegistry.set(canonical, { mutationDepth: 1, maintenanceDepth: 0, ownerDepth: 0, claim });
}

function releaseMutationEntry(canonical: string): void {
  const entry = projectionClaimRegistry.get(canonical);
  if (entry === undefined || entry.mutationDepth === 0) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation claim ownership changed");
  }
  entry.mutationDepth--;
  if (entry.mutationDepth === 0 && entry.claim !== null) {
    const claim = entry.claim;
    entry.claim = null;
    try {
      releaseProjectionClaim(claim);
    } finally {
      if (!registryEntryHeld(entry)) projectionClaimRegistry.delete(canonical);
    }
    return;
  }
  if (!registryEntryHeld(entry)) projectionClaimRegistry.delete(canonical);
}

function runAsProjectionOwner<T>(canonical: string, operation: () => T): T {
  const active = new Set(owners.getStore() ?? []);
  active.add(canonical);
  return owners.run(active, operation);
}

export function claimProjectionMaintenance(databasePath: string): () => void {
  const canonical = canonicalDatabasePath(databasePath);
  const existing = projectionClaimRegistry.get(canonical);
  if (existing !== undefined && (existing.mutationDepth > 0 || existing.maintenanceDepth > 0)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Projection mutation is fenced by active maintenance or publication");
  }
  const claim = acquireProjectionClaim(databasePath);
  const entry = existing ?? { mutationDepth: 0, maintenanceDepth: 0, ownerDepth: 0, claim: null };
  entry.maintenanceDepth++;
  entry.claim = claim;
  projectionClaimRegistry.set(canonical, entry);
  const releaseState = createProjectionClaimReleaseState(claim);
  let releaseCompleted = false;
  return () => {
    if (releaseCompleted) return;
    continueProjectionClaimRelease(releaseState);
    entry.claim = null;
    entry.maintenanceDepth--;
    releaseCompleted = true;
    if (!registryEntryHeld(entry)) projectionClaimRegistry.delete(canonical);
  };
}

function projectionDatabasePath(filePath: string): string | null {
  let current = dirname(resolve(filePath));
  while (current !== dirname(current)) {
    const name = basename(current).toLocaleLowerCase("en-US");
    if (name === ".gsd") {
      return pathExistsFailClosed(current) ? join(current, "gsd.db") : null;
    }
    if (name === ".planning") {
      const gsdPath = join(dirname(current), ".gsd");
      return pathExistsFailClosed(gsdPath) ? join(gsdPath, "gsd.db") : null;
    }
    current = dirname(current);
  }
  return null;
}

export function withProjectionMutationSync<T>(filePath: string, operation: () => T): T {
  const databasePath = projectionDatabasePath(filePath);
  if (databasePath === null) return operation();
  const canonical = canonicalDatabasePath(databasePath);
  if (nestedProjectionOwnerActive(canonical)) return operation();
  assertProjectionWriteFencesAllowWrite(databasePath);
  projectionMutationBeforeClaimForTest?.();
  acquireMutationEntry(databasePath, canonical);
  try {
    assertProjectionWriteFencesAllowWrite(databasePath);
    return runAsProjectionOwner(canonical, operation);
  } finally {
    releaseMutationEntry(canonical);
  }
}

export async function withProjectionMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const databasePath = projectionDatabasePath(filePath);
  if (databasePath === null) return operation();
  const canonical = canonicalDatabasePath(databasePath);
  if (nestedProjectionOwnerActive(canonical)) return operation();
  assertProjectionWriteFencesAllowWrite(databasePath);
  projectionMutationBeforeClaimForTest?.();
  acquireMutationEntry(databasePath, canonical);
  try {
    assertProjectionWriteFencesAllowWrite(databasePath);
    return await runAsProjectionOwner(canonical, operation);
  } finally {
    releaseMutationEntry(canonical);
  }
}

export function withDatabaseMaintenanceOwner<T>(databasePath: string, operation: () => T): T {
  const canonical = canonicalDatabasePath(databasePath);
  const entry = projectionClaimRegistry.get(canonical) ?? { mutationDepth: 0, maintenanceDepth: 0, ownerDepth: 0, claim: null };
  entry.ownerDepth++;
  projectionClaimRegistry.set(canonical, entry);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    entry.ownerDepth--;
    if (!registryEntryHeld(entry)) projectionClaimRegistry.delete(canonical);
  };
  const active = new Set(owners.getStore() ?? []);
  active.add(canonical);
  try {
    const result = owners.run(active, operation);
    // Async operations keep the owner grant until they settle so the bypass
    // provably ends with the operation rather than at the first await.
    if (result instanceof Promise) {
      return result.finally(release) as T;
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

export function assertDatabaseReplacementFenceAllowsWrite(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const activeIntentPath = getDatabaseReplacementPaths(databasePath).activeIntentPath;
  if (pathExistsFailClosed(activeIntentPath)) {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Projection mutation is fenced while database replacement intent exists at ${activeIntentPath}`,
    );
  }
}

export function assertDatabaseMaintenanceFenceAllowsWrite(databasePath: string): void {
  if (databasePath === ":memory:") return;
  const canonical = canonicalDatabasePath(databasePath);
  if (nestedProjectionOwnerActive(canonical)) return;
  const marker = databaseMaintenanceIntentPath(databasePath);
  if (pathExistsFailClosed(marker)) {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Database writes are fenced while maintenance intent exists at ${marker}`,
    );
  }
}

function assertProjectionWriteFencesAllowWrite(databasePath: string): void {
  assertDatabaseMaintenanceFenceAllowsWrite(databasePath);
  assertDatabaseReplacementFenceAllowsWrite(databasePath);
}

export function assertProjectionMaintenanceFenceAllowsWrite(filePath: string): void {
  const databasePath = projectionDatabasePath(filePath);
  if (databasePath !== null) assertDatabaseMaintenanceFenceAllowsWrite(databasePath);
}
