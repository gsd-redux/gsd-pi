// Project/App: gsd-pi
// File Purpose: GSD engine — connection ownership, lifecycle, schema/migrations,
// and transaction primitives for the single-writer layer. The shared handle
// (currentDb) lives here; domain writers, allowlisted coordination/runtime
// writers, schema/migration helpers, and the Query Module (db/queries.ts) read
// it through getDb()/getDbOrNull().
//
// This file legitimately holds DDL and BEGIN/COMMIT control, so it is
// allowlisted in tests/single-writer-invariant.test.ts alongside the explicit
// writer layer.
import { createRequire } from "node:module";
import { existsSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GSDError, GSD_STALE_STATE } from "../errors.js";
import type { GsdWorkspace, MilestoneScope } from "../workspace.js";
import { logError, logWarning } from "../workflow-logger.js";
import { createDbAdapter, type DbAdapter } from "../db-adapter.js";
import { createBaseSchemaObjects } from "../db-base-schema.js";
import { createCoordinationTablesV24 } from "../db-coordination-schema.js";
import { createDbConnectionCache, type DbConnectionCacheEntry } from "../db-connection-cache.js";
import { backupDatabaseBeforeMigration, isMigrationBackupError } from "../db-migration-backup.js";
import {
  applyMigrationV2Artifacts,
  applyMigrationV3Memories,
  applyMigrationV4DecisionMadeBy,
  applyMigrationV5HierarchyTables,
  applyMigrationV6SliceSummaries,
  applyMigrationV7Dependencies,
  applyMigrationV8PlanningFields,
  applyMigrationV9Ordering,
  applyMigrationV10ReplanTrigger,
  applyMigrationV11TaskPlanning,
  applyMigrationV12QualityGates,
  applyMigrationV13HotPathIndexes,
  applyMigrationV14SliceDependencies,
  applyMigrationV15AuditTables,
  applyMigrationV16EscalationSource,
  applyMigrationV17TaskEscalation,
  applyMigrationV18MemorySources,
  applyMigrationV19MemoryFts,
  applyMigrationV20MemoryRelations,
  applyMigrationV21StructuredMemories,
  applyMigrationV22QualityGateRepair,
  applyMigrationV23MilestoneQueue,
  applyMigrationV26MilestoneCommitAttributions,
  applyMigrationV27ArtifactHash,
  applyMigrationV28MemoryLastHitAt,
  applyMigrationV29RepositoryTargets,
  applyMigrationV30ReworkBriefs,
  applyMigrationV31CanonicalFoundation,
  applyMigrationV32LifecycleFoundation,
  applyMigrationV33ConversationFoundation,
  applyMigrationV34RecoveryEvidenceFoundation,
  applyMigrationV35ProjectionImportKernelCloseoutFoundation,
} from "../db-migration-steps.js";
import {
  createCanonicalFoundationSchemaV31,
  ensureCanonicalOutboxInvariantsV31,
} from "../db-canonical-foundation-schema.js";
import { createConversationFoundationSchemaV33 } from "../db-conversation-foundation-schema.js";
import { createLifecycleFoundationSchemaV32 } from "../db-lifecycle-foundation-schema.js";
import { createProjectionImportKernelCloseoutFoundationSchemaV35 } from "../db-projection-import-kernel-closeout-foundation-schema.js";
import { createRecoveryEvidenceFoundationSchemaV34 } from "../db-recovery-evidence-foundation-schema.js";
import {
  isMemoriesFtsAvailableSchema,
  rebuildMemoriesFtsSchemaOnce,
  tryCreateMemoriesFtsSchema,
} from "../db-memory-fts-schema.js";
import { createDbOpenState, type DbOpenPhase } from "../db-open-state.js";
import { createRuntimeKvTableV25 } from "../db-runtime-kv-schema.js";
import { getCurrentSchemaVersion, recordSchemaVersion } from "../db-schema-metadata.js";
import { createDbTransactionRunner } from "../db-transaction.js";
import { ensureVerificationEvidenceDedupIndex } from "../db-verification-evidence-schema.js";
import {
  BETTER_SQLITE3_PACKAGE,
  createSqliteProviderLoader,
  suppressSqliteWarning,
  type DbProviderName,
  type SqliteFallbackOpen,
} from "../db-provider.js";

let _gsdRequire: ReturnType<typeof createRequire> | null | undefined;

function getGsdRequire(): ReturnType<typeof createRequire> | null {
  if (_gsdRequire !== undefined) return _gsdRequire;
  try {
    // Next.js may emit this module into a CommonJS chunk. Avoid ESM-only module
    // metadata syntax here; it is a hard parse error there.
    const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT || process.env.GSD_PKG_ROOT || process.cwd();
    _gsdRequire = createRequire(resolve(packageRoot, "package.json"));
  } catch {
    _gsdRequire = null;
  }
  return _gsdRequire;
}

type ProviderName = DbProviderName;
const providerLoader = createSqliteProviderLoader({
  tryRequireNodeSqlite: () => {
    const req = getGsdRequire();
    if (!req) throw new Error("unavailable");
    return req("node:sqlite");
  },
  tryRequireBetterSqlite3: () => {
    const req = getGsdRequire();
    if (!req) throw new Error("unavailable");
    return req(BETTER_SQLITE3_PACKAGE);
  },
  suppressSqliteWarning,
  nodeVersion: process.versions.node,
  writeStderr: (message: string) => process.stderr.write(message),
});
export const SCHEMA_VERSION = 35;
function initSchema(db: DbAdapter, fileBacked: boolean, dbPath: string | null): void {
  const conservativeFilePragmas = fileBacked && _isLikelyWslDrvFsPathForTest(dbPath);
  if (fileBacked) db.exec(conservativeFilePragmas ? "PRAGMA journal_mode=DELETE" : "PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec(conservativeFilePragmas ? "PRAGMA synchronous = FULL" : "PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");   // 8 MB page cache
  if (fileBacked && !conservativeFilePragmas && process.platform !== "darwin") db.exec("PRAGMA mmap_size = 67108864");  // 64 MB mmap
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec("BEGIN");
  try {
    createBaseSchemaObjects(db, {
      tryCreateMemoriesFts,
      ensureVerificationEvidenceDedupIndex,
    });

    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      // An empty schema_version table usually means a fresh install, but it can
      // also be a legacy/truncated DB that already holds user data. Stamping
      // that DB SCHEMA_VERSION without running migrations would mis-mark it as
      // fully migrated and break at first query. Probe before stamping.
      const hasData = ["milestones", "decisions", "memories"].some((t) => {
        try {
          const r = db.prepare(`SELECT count(*) as cnt FROM ${t}`).get();
          return ((r?.["cnt"] as number) ?? 0) > 0;
        } catch { /* table absent on a truly fresh DB — treat as no data */ return false; }
      });
      if (hasData) {
        // Legacy DB with data but no version row: record the baseline so
        // migrateSchema runs the full chain instead of stamping the current version.
        recordSchemaVersion(db, 1);
      } else {
        createCoordinationTablesV24(db);
        createRuntimeKvTableV25(db);
        createCanonicalFoundationSchemaV31(db);
        createLifecycleFoundationSchemaV32(db);
        createConversationFoundationSchemaV33(db);
        createRecoveryEvidenceFoundationSchemaV34(db);
        createProjectionImportKernelCloseoutFoundationSchemaV35(db);

        // Fresh install — all tables are created above with the full current schema,
        // so it is safe to create all migration-specific indexes here.  For existing
        // databases these indexes are created inside the individual migration guards
        // in migrateSchema() after the corresponding columns have been added.
        db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_rework_briefs_task ON rework_briefs(milestone_id, slice_id, task_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_rework_findings_status ON rework_brief_findings(brief_id, severity, status)");

        recordSchemaVersion(db, SCHEMA_VERSION);
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  migrateSchema(db, dbPath);
  ensureCanonicalOutboxInvariantsV31(db);
  rebuildMemoriesFtsSchemaOnce(db, {
    onRebuildFailed: (message) => logWarning("db", message),
  });
}

export function _isLikelyWslDrvFsPathForTest(dbPath: string | null): boolean {
  if (!dbPath || process.platform !== "linux") return false;
  const drvFsPathPattern = /^\/mnt\/[a-z](?:\/|$)/i;
  if (drvFsPathPattern.test(dbPath)) return true;
  try {
    return drvFsPathPattern.test(realpathSync(dbPath));
  } catch {
    return false;
  }
}

/**
 * Create the FTS5 virtual table for memories plus the triggers that keep it
 * in sync with the base table. FTS5 may be unavailable on stripped-down
 * SQLite builds — callers should treat failure as non-fatal and fall back
 * to LIKE-based scans in `memory-store.queryMemoriesRanked`.
 */
export function tryCreateMemoriesFts(db: DbAdapter): boolean {
  return tryCreateMemoriesFtsSchema(db, {
    onUnavailable: (message) => logWarning("db", message),
  });
}

export function isMemoriesFtsAvailable(db: DbAdapter): boolean {
  return isMemoriesFtsAvailableSchema(db);
}

function backfillMemoriesFts(db: DbAdapter): void {
  db.exec(`INSERT INTO memories_fts(rowid, content) SELECT seq, content FROM memories`);
}

function copyQualityGateRowsToRepairedTable(db: DbAdapter): void {
  db.exec(`
    INSERT OR IGNORE INTO quality_gates_new
      (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    SELECT milestone_id, slice_id, gate_id, scope, COALESCE(task_id, ''), status, verdict, rationale, findings, evaluated_at
    FROM quality_gates
  `);
}

let _migrationFaultForTest = false;
/** Test-only: force migrateSchema to throw after applying its steps but before COMMIT. */
export function _setMigrationFaultForTest(v: boolean): void { _migrationFaultForTest = v; }

function migrateSchema(db: DbAdapter, dbPath: string | null): void {
  const currentVersion = getCurrentSchemaVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `gsd.db schema is v${currentVersion}, newer than the v${SCHEMA_VERSION} this gsd-pi supports. ` +
      `Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) return;

  backupDatabaseBeforeMigration(db, dbPath, currentVersion, {
    existsSync,
    copyFileSync,
    logWarning,
  });

  db.exec("BEGIN");
  try {
    if (currentVersion < 2) {
      applyMigrationV2Artifacts(db);
      recordSchemaVersion(db, 2);
    }

    if (currentVersion < 3) {
      applyMigrationV3Memories(db);
      recordSchemaVersion(db, 3);
    }

    if (currentVersion < 4) {
      applyMigrationV4DecisionMadeBy(db);
      recordSchemaVersion(db, 4);
    }

    if (currentVersion < 5) {
      applyMigrationV5HierarchyTables(db);
      recordSchemaVersion(db, 5);
    }

    if (currentVersion < 6) {
      applyMigrationV6SliceSummaries(db);
      recordSchemaVersion(db, 6);
    }

    if (currentVersion < 7) {
      applyMigrationV7Dependencies(db);
      recordSchemaVersion(db, 7);
    }

    if (currentVersion < 8) {
      applyMigrationV8PlanningFields(db);
      recordSchemaVersion(db, 8);
    }

    if (currentVersion < 9) {
      applyMigrationV9Ordering(db);
      recordSchemaVersion(db, 9);
    }

    if (currentVersion < 10) {
      applyMigrationV10ReplanTrigger(db);
      recordSchemaVersion(db, 10);
    }

    if (currentVersion < 11) {
      applyMigrationV11TaskPlanning(db);
      recordSchemaVersion(db, 11);
    }

    if (currentVersion < 12) {
      // NOTE: The original DDL used COALESCE(task_id, '') in the PRIMARY KEY
      // expression, which is invalid SQLite syntax and causes startup errors on
      // DBs that migrate through v12. The corrected DDL uses
      // task_id TEXT NOT NULL DEFAULT '' with a plain column list PK. DBs that
      // were created with the broken DDL are repaired by the v22 migration below.
      applyMigrationV12QualityGates(db);
      recordSchemaVersion(db, 12);
    }

    if (currentVersion < 13) {
      applyMigrationV13HotPathIndexes(db, ensureVerificationEvidenceDedupIndex);
      recordSchemaVersion(db, 13);
    }

    if (currentVersion < 14) {
      applyMigrationV14SliceDependencies(db);
      recordSchemaVersion(db, 14);
    }

    if (currentVersion < 15) {
      applyMigrationV15AuditTables(db);
      recordSchemaVersion(db, 15);
    }

    if (currentVersion < 16) {
      applyMigrationV16EscalationSource(db);
      recordSchemaVersion(db, 16);
    }

    if (currentVersion < 17) {
      applyMigrationV17TaskEscalation(db);
      recordSchemaVersion(db, 17);
    }

    if (currentVersion < 18) {
      applyMigrationV18MemorySources(db);
      recordSchemaVersion(db, 18);
    }

    if (currentVersion < 19) {
      applyMigrationV19MemoryFts(db, {
        tryCreateMemoriesFts,
        isMemoriesFtsAvailable,
        backfillMemoriesFts,
        logWarning,
      });
      recordSchemaVersion(db, 19);
    }

    if (currentVersion < 20) {
      applyMigrationV20MemoryRelations(db);
      recordSchemaVersion(db, 20);
    }

    if (currentVersion < 21) {
      applyMigrationV21StructuredMemories(db);
      recordSchemaVersion(db, 21);
    }

    if (currentVersion < 22) {
      applyMigrationV22QualityGateRepair(db, { copyQualityGateRowsToRepairedTable });
      recordSchemaVersion(db, 22);
    }

    if (currentVersion < 23) {
      applyMigrationV23MilestoneQueue(db);
      recordSchemaVersion(db, 23);
    }

    if (currentVersion < 24) {
      // v24: auto-mode coordination tables. See createCoordinationTablesV24
      // for full schema + invariants. No-op for fresh installs (the same
      // helper runs in the fresh-install path); for upgraded DBs this is
      // the only place these tables get created.
      createCoordinationTablesV24(db);
      recordSchemaVersion(db, 24);
    }

    if (currentVersion < 25) {
      // v25: runtime_kv non-correctness-critical key-value storage. See
      // createRuntimeKvTableV25 for the full schema + invariants.
      createRuntimeKvTableV25(db);
      recordSchemaVersion(db, 25);
    }

    if (currentVersion < 26) {
      applyMigrationV26MilestoneCommitAttributions(db);
      recordSchemaVersion(db, 26);
    }

    if (currentVersion < 27) {
      applyMigrationV27ArtifactHash(db);
      recordSchemaVersion(db, 27);
    }

    if (currentVersion < 28) {
      applyMigrationV28MemoryLastHitAt(db);
      recordSchemaVersion(db, 28);
    }

    if (currentVersion < 29) {
      applyMigrationV29RepositoryTargets(db);
      recordSchemaVersion(db, 29);
    }

    if (currentVersion < 30) {
      applyMigrationV30ReworkBriefs(db);
      recordSchemaVersion(db, 30);
    }

    if (currentVersion < 31) {
      applyMigrationV31CanonicalFoundation(db);
      recordSchemaVersion(db, 31);
    }

    if (currentVersion < 32) {
      applyMigrationV32LifecycleFoundation(db);
      recordSchemaVersion(db, 32);
    }

    if (currentVersion < 33) {
      applyMigrationV33ConversationFoundation(db);
      recordSchemaVersion(db, 33);
    }

    if (currentVersion < 34) {
      applyMigrationV34RecoveryEvidenceFoundation(db);
      recordSchemaVersion(db, 34);
    }

    if (currentVersion < 35) {
      applyMigrationV35ProjectionImportKernelCloseoutFoundation(db);
      recordSchemaVersion(db, 35);
    }

    if (_migrationFaultForTest) throw new Error("migration fault injected for test");

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;
let currentPid: number = 0;
let _exitHandlerRegistered = false;
const _dbOpenState = createDbOpenState();
/**
 * Identity key of the workspace whose connection is currently active
 * (currentDb). Set by openDatabaseByWorkspace(); null when the active
 * connection was opened via the legacy openDatabase(path) path.
 */
let _currentIdentityKey: string | null = null;

/**
 * Workspace-scoped connection cache.
 * Key: GsdWorkspace.identityKey (realpath-normalized project root).
 * Value: the DB path and open adapter for that workspace.
 *
 * Sibling worktrees of the same project share the same identityKey (set by
 * createWorkspace) and therefore reuse the same cached connection, preserving
 * shared-WAL semantics. Different projects get distinct cache entries.
 *
 * NOTE: Only one connection is "active" at a time (currentDb/currentPath).
 * The cache allows fast re-activation of a previously opened connection when
 * callers switch between known workspaces via openDatabaseByWorkspace().
 */
const _dbCache = createDbConnectionCache();

/** Test helper: expose the internal cache for inspection. Not for production use. */
export function _getDbCache(): ReadonlyMap<string, DbConnectionCacheEntry> {
  return _dbCache.asReadonlyMap();
}

function closeCachedConnection(entry: DbConnectionCacheEntry, source: "all" | "workspace"): void {
  try {
    entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    if (source === "workspace") logWarning("db", `WAL checkpoint (byWorkspace) failed: ${(e as Error).message}`);
  }
  try {
    entry.db.exec("PRAGMA incremental_vacuum(64)");
  } catch (e) {
    if (source === "workspace") logWarning("db", `incremental vacuum (byWorkspace) failed: ${(e as Error).message}`);
  }
  try {
    entry.db.close();
  } catch (e) {
    if (source === "workspace") logWarning("db", `database close (byWorkspace) failed: ${(e as Error).message}`);
  }
}

/**
 * Close and evict every entry in the workspace connection cache, then call
 * closeDatabase() to close the active connection.
 *
 * Use this for test teardown or process-shutdown paths where every open
 * connection must be flushed. Normal callers should use closeDatabase() or
 * closeDatabaseByWorkspace() instead.
 */
export function closeAllDatabases(): void {
  // Close all non-active cached connections first.
  _dbCache.closeNonActive(currentDb, (entry) => closeCachedConnection(entry, "all"));
  closeDatabase();
}

/**
 * Open (or reuse) the database connection scoped to the given workspace.
 *
 * Uses workspace.identityKey as the cache key, so sibling worktrees of the
 * same project resolve to the same connection. On a cache hit the existing
 * adapter is reactivated as the current connection without re-opening the
 * file. On a cache miss, delegates to openDatabase() for the full
 * open + schema-init + migration flow, then caches the result.
 *
 * When switching to a different workspace, the previously active connection
 * is preserved in the cache (not closed), so callers can switch back to it
 * cheaply via a subsequent openDatabaseByWorkspace() call.
 *
 * @param workspace A GsdWorkspace created by createWorkspace().
 * @returns true if the connection is open and ready, false otherwise.
 */
export function openDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  const key = workspace.identityKey;
  const dbPath = workspace.contract.projectDb;

  const cached = _dbCache.get(key);
  if (cached) {
    // Reactivate the cached connection as the current singleton.
    currentDb = cached.db;
    currentPath = cached.dbPath;
    currentPid = process.pid;
    _dbOpenState.markAttempted();
    _currentIdentityKey = key;
    return true;
  }

  // Cache miss — need to open a new connection.
  //
  // If there is a currently active workspace connection, stash it in the
  // cache under its identity key before calling openDatabase(), because
  // openDatabase() will call closeDatabase() when the path changes (which
  // would destroy the existing adapter). By nulling out currentDb first,
  // we prevent openDatabase() from closing the live adapter.
  let oldDb: typeof currentDb = null;
  let oldPath: typeof currentPath = null;
  let oldPid: typeof currentPid = 0;
  let oldKey: typeof _currentIdentityKey = null;

  if (currentDb !== null && _currentIdentityKey !== null) {
    // Snapshot the old globals so we can restore them on failure.
    oldDb = currentDb;
    oldPath = currentPath;
    oldPid = currentPid;
    oldKey = _currentIdentityKey;
    // Save the current connection so it stays alive in the cache.
    _dbCache.set(_currentIdentityKey, {
      dbPath: currentPath!,
      db: currentDb,
    });
    // Detach from globals so openDatabase() opens fresh without closing it.
    currentDb = null;
    currentPath = null;
    currentPid = 0;
    _currentIdentityKey = null;
  }

  // Run the full open/schema/migration flow for the new workspace.
  // openDatabase() can throw on corrupt DB or permission error — catch so we
  // can restore the previous connection rather than leaving globals null.
  let opened: boolean;
  try {
    opened = openDatabase(dbPath);
  } catch (err) {
    // Failed to open the new DB. Restore the previous workspace connection so
    // the caller's workspace remains active (it is still safe in _dbCache).
    if (oldDb !== null) {
      currentDb = oldDb;
      currentPath = oldPath;
      currentPid = oldPid;
      _currentIdentityKey = oldKey;
    }
    throw err;
  }
  if (opened && currentDb) {
    _dbCache.set(key, { dbPath, db: currentDb });
    _currentIdentityKey = key;
  } else if (!opened && oldDb !== null) {
    // Restore the previous connection so the caller's workspace remains active.
    // The failed attempt left no live adapter, so the globals stayed null.
    currentDb = oldDb;
    currentPath = oldPath;
    currentPid = oldPid;
    _currentIdentityKey = oldKey;
  }
  return opened;
}

/**
 * Open (or reuse) the database connection scoped to the workspace in a
 * MilestoneScope. Thin delegation to openDatabaseByWorkspace().
 */
export function openDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByWorkspace(scope.workspace);
}

/**
 * Close the database connection for the given workspace and remove it from
 * the cache. If the workspace's connection is currently active (currentDb),
 * performs a full closeDatabase() including WAL checkpoint. Otherwise only
 * removes the cache entry (the adapter was already replaced by a later open).
 */
export function closeDatabaseByWorkspace(workspace: GsdWorkspace): void {
  const key = workspace.identityKey;
  const cached = _dbCache.get(key);
  if (!cached) return;

  _dbCache.delete(key);

  if (currentDb === cached.db) {
    // This workspace's connection is the active one — full close.
    closeDatabase();
  } else {
    // Connection was displaced by a later open; close the adapter directly.
    closeCachedConnection(cached, "workspace");
  }
}

export function getDbProvider(): ProviderName | null {
  providerLoader.load();
  return providerLoader.getProviderName();
}

export function isDbAvailable(): boolean {
  return currentDb !== null;
}

/**
 * Returns true if openDatabase() has been called at least once this session.
 * Used to distinguish "DB not yet initialized" from "DB genuinely unavailable"
 * so that early callers (e.g. before_agent_start context injection) don't
 * trigger a false degraded-mode warning.
 */
export function wasDbOpenAttempted(): boolean {
  return _dbOpenState.snapshot().attempted;
}

export function getDbStatus(): {
  available: boolean;
  provider: ProviderName | null;
  attempted: boolean;
  lastError: Error | null;
  lastPhase: DbOpenPhase | null;
} {
  providerLoader.load();
  const openState = _dbOpenState.snapshot();
  return {
    available: currentDb !== null,
    provider: providerLoader.getProviderName(),
    attempted: openState.attempted,
    lastError: openState.lastError,
    lastPhase: openState.lastPhase,
  };
}

export function openDatabase(path: string): boolean {
  _dbOpenState.markAttempted();
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) return true;

  // Reset error state only when a new open attempt is actually going to run.
  _dbOpenState.clearError();

  let rawDb: unknown;
  let fallbackOpen: SqliteFallbackOpen | null = null;
  try {
    rawDb = providerLoader.openRaw(path);
  } catch (primaryErr) {
    _dbOpenState.recordError("open", primaryErr);
    // node:sqlite loaded but failed to open this file — try better-sqlite3 as fallback.
    fallbackOpen = providerLoader.tryOpenBetterSqliteFallback(path);
    if (fallbackOpen) {
      rawDb = fallbackOpen.rawDb;
      _dbOpenState.clearError();
    }
    if (!rawDb) throw primaryErr;
  }
  if (!rawDb) return false;

  const adapter = createDbAdapter(rawDb);
  const fileBacked = path !== ":memory:";
  try {
    initSchema(adapter, fileBacked, path);
  } catch (err) {
    // Corrupt freelist: DDL fails with "malformed" but VACUUM can rebuild.
    // Pre-migration backup failures are already pre-DDL and must propagate
    // instead of being masked by VACUUM recovery (see #2519).
    if (shouldAttemptVacuumRecovery(fileBacked, err)) {
      try {
        adapter.exec("VACUUM");
        initSchema(adapter, fileBacked, path);
        process.stderr.write("gsd-db: recovered corrupt database via VACUUM\n");
      } catch (retryErr) {
        _dbOpenState.recordError("vacuum-recovery", retryErr);
        try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
        throw retryErr;
      }
    } else {
      _dbOpenState.recordError("initSchema", err);
      try { adapter.close(); } catch (e) { logWarning("db", `close after initSchema failed: ${(e as Error).message}`); }
      throw err;
    }
  }

  // Commit fallback provider switch only after open + schema both succeeded.
  if (fallbackOpen) providerLoader.commitFallback(fallbackOpen);

  currentDb = adapter;
  currentPath = path;
  currentPid = process.pid;

  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", () => { try { closeDatabase(); } catch (e) { logWarning("db", `exit handler close failed: ${(e as Error).message}`); } });
  }

  return true;
}

function shouldAttemptVacuumRecovery(fileBacked: boolean, err: unknown): boolean {
  return fileBacked && err instanceof Error && err.message.includes("malformed") && !isMigrationBackupError(err);
}

export const _shouldAttemptVacuumRecoveryForTest = shouldAttemptVacuumRecovery;

export function closeDatabase(): void {
  if (currentDb) {
    try {
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
    try {
      // Incremental vacuum to reclaim space without blocking
      currentDb.exec('PRAGMA incremental_vacuum(64)');
    } catch (e) { logWarning("db", `incremental vacuum failed: ${(e as Error).message}`); }
    try {
      currentDb.close();
    } catch (e) { logWarning("db", `database close failed: ${(e as Error).message}`); }
    // If this connection was workspace-tracked, evict it from the cache so
    // subsequent openDatabaseByWorkspace() calls re-open rather than reactivate
    // a closed adapter.
    if (_currentIdentityKey !== null) {
      _dbCache.delete(_currentIdentityKey);
      _currentIdentityKey = null;
    }
    currentDb = null;
    currentPath = null;
    currentPid = 0;
  }
  // Reset session-scoped state unconditionally so stale error info from a
  // failed open doesn't persist into the next open attempt or status check.
  _dbOpenState.reset();
}

/**
 * Open an isolated database connection that does NOT touch the process-wide
 * `currentDb` singleton. Intended for background observers (e.g. the parallel
 * monitor overlay) that must read a database without displacing an active
 * workflow session connection.
 *
 * The caller MUST call `adapter.close()` when done. Schema migrations are NOT
 * run — the database must already exist and be fully migrated by the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openIsolatedDatabase(path: string): DbAdapter | null {
  try {
    const rawDb = providerLoader.openRaw(path);
    if (!rawDb) return null;
    const adapter = createDbAdapter(rawDb);
    // Minimal pragmas for a short-lived read-only observer connection.
    // WAL mode is already set file-wide by the primary connection; repeating
    // it here is a no-op on an existing WAL file and safe to issue.
    adapter.exec("PRAGMA journal_mode=WAL");
    adapter.exec("PRAGMA busy_timeout = 5000");
    return adapter;
  } catch {
    return null;
  }
}

/**
 * Re-open the active database connection from disk.
 *
 * Auto-mode can observe artifacts written by a workflow server running in a
 * different process before its long-lived singleton has re-synchronized. The
 * recovery path uses this to force the next state derivation to read from the
 * current on-disk database instead of continuing with a possibly stale handle.
 */
export function refreshOpenDatabaseFromDisk(): boolean {
  if (!currentDb || !currentPath) return false;
  if (currentPath === ":memory:") return false;

  const dbPath = currentPath;
  const identityKey = _currentIdentityKey;

  try {
    closeDatabase();
    const opened = openDatabase(dbPath);
    if (opened && identityKey && currentDb) {
      _dbCache.set(identityKey, { dbPath, db: currentDb });
      _currentIdentityKey = identityKey;
    }
    return opened;
  } catch (e) {
    logWarning("db", `database refresh failed: ${(e as Error).message}`);
    return false;
  }
}

/** Run a full VACUUM — call sparingly (e.g. after milestone completion). */
export function vacuumDatabase(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('VACUUM');
  } catch (e) { logWarning("db", `VACUUM failed: ${(e as Error).message}`); }
}

/** Flush WAL into gsd.db so `git add .gsd/gsd.db` stages current state — safe while DB is open. */
export function checkpointDatabase(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
}

/**
 * Copy the live database file to `.gsd/backups/<label>-<timestamp>.db` so a
 * destructive operation (e.g. recover, which clears the hierarchy tables) is
 * reversible. Checkpoints the WAL first so the snapshot is complete. Returns
 * the backup path, or null if no DB is open or the copy failed.
 */
export function backupDatabaseSnapshot(label: string): string | null {
  if (!currentPath) return null;
  try {
    checkpointDatabase();
    const backupsDir = join(dirname(currentPath), "backups");
    mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupsDir, `${label}-${stamp}.db`);
    copyFileSync(currentPath, dest);
    return dest;
  } catch (e) {
    logWarning("db", `database snapshot failed: ${(e as Error).message}`);
    return null;
  }
}

const _transactionRunner = createDbTransactionRunner();

function createTransactionControls(db: DbAdapter) {
  return {
    begin: () => db.exec("BEGIN"),
    beginRead: () => db.exec("BEGIN DEFERRED"),
    beginImmediate: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  };
}

/**
 * Whether the current call is running inside an active SQLite transaction.
 * Statement-time recovery paths (e.g. VACUUM retry on a malformed memory
 * store) MUST gate on this — SQLite refuses VACUUM inside a transaction
 * and would mask the original error with a secondary "cannot VACUUM" throw.
 */
export function isInTransaction(): boolean {
  return _transactionRunner.isInTransaction();
}

export function transaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return _transactionRunner.transaction(createTransactionControls(currentDb), fn);
}

/**
 * Run a BEGIN IMMEDIATE write transaction for operations that need SQLite's
 * reserved writer lock before issuing updates. Re-entrant like transaction():
 * nested calls run inside the outer transaction without a nested BEGIN.
 */
export function immediateTransaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return _transactionRunner.immediateTransaction(createTransactionControls(currentDb), fn);
}

/**
 * Wrap a block of reads in a DEFERRED transaction so that all SELECTs observe
 * a consistent snapshot of the DB even if a concurrent writer commits between
 * them. Use this for multi-query read flows (e.g. tool executors that query
 * milestone + slices + counts and want one snapshot). Re-entrant — if already
 * inside a transaction, runs fn() without starting a nested one.
 */
export function readTransaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");

  return _transactionRunner.readTransaction(createTransactionControls(currentDb), fn, (rollbackErr) => {
    // A failed ROLLBACK after a failed read is a split-brain signal —
    // the transaction is in an indeterminate state. Surface it via the
    // logger instead of swallowing it.
    logError("db", "snapshotState ROLLBACK failed", {
      error: rollbackErr.message,
    });
  });
}
export function getDbOwnerPid(): number {
  return currentPid;
}

export function getDbPath(): string | null {
  return currentPath;
}

export function _getAdapter(): DbAdapter | null {
  return currentDb;
}

export function _resetProvider(): void {
  providerLoader.reset();
}

/**
 * The active engine handle, or throw if no database is open. Use in write
 * wrappers — replaces the historical `if (!currentDb) throw ...; currentDb.X`
 * guard with `getDb().X`.
 */
export function getDb(): DbAdapter {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return currentDb;
}

/**
 * The active engine handle or null. Use in read wrappers that no-op (return
 * [] / null) when no database is open.
 */
export function getDbOrNull(): DbAdapter | null {
  return currentDb;
}

export interface DbWritableProbeResult {
  ok: boolean;
  detail?: string;
}

/**
 * Confirm the open handle can actually write, not just that it opened.
 *
 * A schema-current database performs zero writes during open, so a handle that
 * opened successfully but is not writable (read-only file, WAL/SHM permission
 * mismatch, or a stale/moved handle → SQLITE_READONLY_DBMOVED) otherwise passes
 * the open-only availability check and only fails much later at the first real
 * write. The probe forces a genuine page write by re-writing the current
 * `PRAGMA user_version` value back inside an IMMEDIATE transaction: a bare
 * `BEGIN IMMEDIATE; ROLLBACK` is not sufficient because a moved handle does not
 * fail until a page is actually dirtied. The value is unchanged, so the probe
 * is idempotent, and the transaction is rolled back so nothing persists.
 */
export function probeDbWritable(): DbWritableProbeResult {
  const db = currentDb;
  if (!db) return { ok: false, detail: "No database is open." };
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = typeof row?.user_version === "number" ? row.user_version : 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`PRAGMA user_version = ${current}`);
    } finally {
      db.exec("ROLLBACK");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
