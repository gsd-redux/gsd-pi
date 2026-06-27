// Project/App: gsd-pi
// File Purpose: Workspace-facing Interface for opening and maintaining the workflow database.

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import type { GsdWorkspace, MilestoneScope } from "./workspace.js";
import type { DbAdapter } from "./db-adapter.js";
import {
  backupDatabaseSnapshot,
  checkpointDatabase,
  closeAllDatabases,
  closeDatabase,
  closeDatabaseByWorkspace,
  getDbPath,
  getDbStatus,
  getDbProvider,
  isDbAvailable,
  openDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
  openIsolatedDatabase,
  refreshOpenDatabaseFromDisk,
  vacuumDatabase,
  wasDbOpenAttempted,
} from "./gsd-db.js";
import { resolveGsdPathContract } from "./paths.js";
import { setLogBasePath } from "./workflow-logger.js";

export interface WorkflowDatabaseLocation {
  projectRoot: string;
  projectGsd: string;
  projectDb: string;
}

export type WorkflowDatabaseOpenReason =
  | "opened-existing"
  | "created-empty"
  | "missing-database"
  | "missing-gsd-dir"
  | "open-failed";

export type WorkflowDatabaseOpenResult =
  | {
      ok: true;
      reason: "opened-existing" | "created-empty";
      location: WorkflowDatabaseLocation;
    }
  | {
      ok: false;
      reason: "missing-database" | "missing-gsd-dir" | "open-failed";
      location: WorkflowDatabaseLocation;
      error?: Error;
    };

export type WorkflowDatabaseStatus = ReturnType<typeof getDbStatus>;
export type WorkflowDatabaseProvider = ReturnType<typeof getDbProvider>;

export function resolveWorkflowDatabaseLocation(basePath: string): WorkflowDatabaseLocation {
  const contract = resolveGsdPathContract(basePath);
  return {
    projectRoot: dirname(dirname(contract.projectDb)),
    projectGsd: contract.projectGsd,
    projectDb: contract.projectDb,
  };
}

/**
 * Resolve the correct DB path for the current working directory.
 * If `basePath` is inside a `.gsd/worktrees/<MID>/` directory, returns
 * the project root's `.gsd/gsd.db` (shared WAL — R012). Otherwise returns
 * `<basePath>/.gsd/gsd.db`.
 */
export function resolveProjectRootDbPath(basePath: string): string {
  return resolveWorkflowDatabaseLocation(basePath).projectDb;
}

export function openWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectGsd)) {
    return { ok: false, reason: "missing-gsd-dir", location };
  }

  const existed = existsSync(location.projectDb);
  try {
    const opened = openDatabase(location.projectDb);
    if (!opened) {
      return { ok: false, reason: "open-failed", location };
    }
    setLogBasePath(location.projectRoot);
    return {
      ok: true,
      reason: existed ? "opened-existing" : "created-empty",
      location,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "open-failed",
      location,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export function openExistingWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectDb)) {
    return { ok: false, reason: "missing-database", location };
  }
  return openWorkflowDatabase(basePath);
}

export function openWorkflowDatabasePath(path: string): boolean {
  return openDatabase(path);
}

/**
 * Open an isolated database connection for read-only observation without
 * displacing the active workflow session's global DB handle. The caller is
 * responsible for calling `adapter.close()` when done.
 *
 * Use this for background observers (e.g. the parallel monitor overlay) that
 * need to query a database on a 5s tick without interfering with the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openWorkflowDatabaseIsolated(path: string): DbAdapter | null {
  return openIsolatedDatabase(path);
}

export function openWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  return openDatabaseByWorkspace(workspace);
}

export function openWorkflowDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByScope(scope);
}

export function closeWorkflowDatabase(): void {
  closeDatabase();
}

export function closeWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): void {
  closeDatabaseByWorkspace(workspace);
}

export function closeAllWorkflowDatabases(): void {
  closeAllDatabases();
}

export function isWorkflowDatabaseOpen(): boolean {
  return isDbAvailable();
}

export function wasWorkflowDatabaseOpenAttempted(): boolean {
  return wasDbOpenAttempted();
}

export function getWorkflowDatabaseStatus(): WorkflowDatabaseStatus {
  return getDbStatus();
}

export function getWorkflowDatabaseProvider(): WorkflowDatabaseProvider {
  return getDbProvider();
}

export function getWorkflowDatabasePath(): string | null {
  return getDbPath();
}

export function refreshWorkflowDatabaseFromDisk(): boolean {
  return refreshOpenDatabaseFromDisk();
}

export function checkpointWorkflowDatabase(): void {
  checkpointDatabase();
}

export function vacuumWorkflowDatabase(): void {
  vacuumDatabase();
}

export function backupWorkflowDatabaseSnapshot(label: string): string | null {
  return backupDatabaseSnapshot(label);
}
