// Project/App: gsd-pi
// File Purpose: Response-neutral runtime context propagation for milestone-status observations.

import { randomUUID } from "node:crypto";

import { openIsolatedDatabase } from "./db/engine.js";
import {
  deleteMilestoneStatusObservationTurn,
  updateMilestoneStatusObservationTurn,
  writeMilestoneStatusObservationTurn,
} from "./db/writers/milestone-status-observation-context.js";
import { resolveProjectRootDbPath } from "./db-workspace.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { captureMilestoneVerificationSourceRevision } from "./verification-source-integrity.js";
import type {
  MilestoneStatusObservationContext,
  MilestoneStatusObservationContextError,
  MilestoneStatusRuntimeMode,
  MilestoneStatusTransport,
} from "./lifecycle-shadow-observation.js";

export const MILESTONE_STATUS_OBSERVATION_TOKEN_ENV = "GSD_MILESTONE_STATUS_OBSERVATION_TOKEN";
export const MILESTONE_STATUS_OBSERVATION_PENDING_SOURCE_REVISION = "pending_capture";

const TURN_CONTEXT_KEY_PREFIX = "milestone-status-observation-turn:";
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const RUNTIME_MODES = new Set<MilestoneStatusRuntimeMode>([
  "auto",
  "interactive",
  "guided",
  "uok",
  "custom",
  "legacy",
]);

export interface MilestoneStatusRuntimeSignals {
  autoActive: boolean;
  activeEngineId?: string | null;
  uokEnabled?: boolean;
  uokLegacyFallback?: boolean;
  guidedActive?: boolean;
}

export interface MilestoneStatusObservationTurn {
  token: string;
  databasePath: string;
  mode: MilestoneStatusRuntimeMode;
  sourceRevision: string;
  traceId?: string;
  turnId?: string;
  contextError?: MilestoneStatusObservationContextError;
  startedAt: string;
  expiresAt: string;
}

interface TurnTimingOptions {
  now?: number;
  ttlMs?: number;
  token?: string;
}

type ContextDatabase = NonNullable<ReturnType<typeof openIsolatedDatabase>>;
type SourceRevisionCapture = typeof captureMilestoneVerificationSourceRevision;

type StoredTurnResult =
  | { status: "found"; turn: MilestoneStatusObservationTurn }
  | { status: "missing" | "invalid" | "unavailable" };

export type MilestoneStatusObservationTokenState = "active" | "inactive" | "unavailable";

export function classifyMilestoneStatusRuntimeMode(
  signals: MilestoneStatusRuntimeSignals,
): MilestoneStatusRuntimeMode {
  if (signals.autoActive) {
    if (signals.activeEngineId && signals.activeEngineId !== "dev") return "custom";
    if (signals.uokLegacyFallback) return "legacy";
    return signals.uokEnabled ? "uok" : "auto";
  }
  return signals.guidedActive ? "guided" : "interactive";
}

function withContextDatabase<T>(
  databasePath: string,
  fn: (database: ContextDatabase) => T,
): { available: true; value: T } | { available: false } {
  let database: ReturnType<typeof openIsolatedDatabase>;
  try {
    database = openIsolatedDatabase(databasePath);
  } catch {
    return { available: false };
  }
  if (!database) return { available: false };
  try {
    return { available: true, value: fn(database) };
  } catch {
    return { available: false };
  } finally {
    try {
      database.close();
    } catch {
      // Observation soft state must never break the calling workflow.
    }
  }
}

function isOptionalNonblankString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && Boolean(value.trim()));
}

function isStoredTurn(value: unknown): value is MilestoneStatusObservationTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<MilestoneStatusObservationTurn>;
  if (typeof turn.token !== "string" || !turn.token.trim()) return false;
  if (typeof turn.databasePath !== "string" || !turn.databasePath.trim()) return false;
  if (!RUNTIME_MODES.has(turn.mode as MilestoneStatusRuntimeMode)) return false;
  if (typeof turn.sourceRevision !== "string" || !turn.sourceRevision.trim()) return false;
  if (typeof turn.startedAt !== "string" || !Number.isFinite(Date.parse(turn.startedAt))) return false;
  if (typeof turn.expiresAt !== "string" || !Number.isFinite(Date.parse(turn.expiresAt))) return false;
  if (!isOptionalNonblankString(turn.traceId)) return false;
  if (!isOptionalNonblankString(turn.turnId)) return false;
  if (turn.contextError !== undefined && !["unavailable", "invalid"].includes(turn.contextError)) {
    return false;
  }
  return true;
}

function turnKey(token: string): string {
  return `${TURN_CONTEXT_KEY_PREFIX}${token}`;
}

function scavengeStoredTurns(database: ContextDatabase, databasePath: string, now: number): void {
  const rows = database.prepare(`
    SELECT key, value_json
    FROM runtime_kv
    WHERE scope = 'global' AND scope_id = '' AND key LIKE :key_prefix
  `).all({ ":key_prefix": `${TURN_CONTEXT_KEY_PREFIX}%` });

  for (const row of rows) {
    const key = row["key"];
    const raw = row["value_json"];
    if (typeof key !== "string" || typeof raw !== "string") continue;

    let remove = false;
    try {
      const turn = JSON.parse(raw);
      remove = !isStoredTurn(turn)
        || turnKey(turn.token) !== key
        || turn.databasePath !== databasePath
        || Date.parse(turn.expiresAt) <= now;
    } catch {
      remove = true;
    }
    if (!remove) continue;

    deleteMilestoneStatusObservationTurn(database, key, raw);
  }
}

function deleteStoredTurn(databasePath: string, token: string, raw?: string): boolean {
  const result = withContextDatabase(databasePath, (database) =>
    deleteMilestoneStatusObservationTurn(database, turnKey(token), raw)
  );
  return result.available && result.value;
}

function readStoredTurn(basePath: string, token: string, now: number): StoredTurnResult {
  let databasePath: string;
  try {
    databasePath = resolveProjectRootDbPath(basePath);
  } catch {
    return { status: "unavailable" };
  }
  const result = withContextDatabase(databasePath, (database) => database.prepare(`
    SELECT value_json
    FROM runtime_kv
    WHERE scope = 'global' AND scope_id = '' AND key = :key
  `).get({ ":key": turnKey(token) }));
  if (!result.available) return { status: "unavailable" };

  const raw = result.value?.["value_json"];
  if (raw === undefined) return { status: "missing" };
  if (typeof raw !== "string") return { status: "invalid" };

  try {
    const turn = JSON.parse(raw);
    if (!isStoredTurn(turn) || turn.token !== token || turn.databasePath !== databasePath) {
      return { status: "invalid" };
    }
    if (Date.parse(turn.expiresAt) <= now) {
      deleteStoredTurn(databasePath, token, raw);
      return { status: "invalid" };
    }
    return { status: "found", turn };
  } catch {
    return { status: "invalid" };
  }
}

export function beginMilestoneStatusObservationTurn(
  basePath: string,
  input: Omit<MilestoneStatusObservationTurn, "token" | "databasePath" | "startedAt" | "expiresAt">,
  options: TurnTimingOptions = {},
): string | null {
  const now = options.now ?? Date.now();
  const token = options.token ?? randomUUID();
  if (!token.trim()) return null;
  let databasePath: string;
  try {
    databasePath = resolveProjectRootDbPath(basePath);
  } catch {
    return null;
  }
  const turn: MilestoneStatusObservationTurn = {
    token,
    databasePath,
    mode: input.mode,
    sourceRevision: input.sourceRevision,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.contextError ? { contextError: input.contextError } : {}),
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
  const stored = withContextDatabase(databasePath, (database) => {
    scavengeStoredTurns(database, databasePath, now);
    writeMilestoneStatusObservationTurn(database, {
      key: turnKey(token),
      valueJson: JSON.stringify(turn),
      updatedAt: turn.startedAt,
    });
    return true;
  });
  return stored.available && stored.value ? token : null;
}

export function readMilestoneStatusObservationTurn(
  basePath: string,
  token: string,
  now: number = Date.now(),
): MilestoneStatusObservationTurn | null {
  if (!token.trim()) return null;
  const result = readStoredTurn(basePath, token, now);
  return result.status === "found" ? result.turn : null;
}

export function resolveMilestoneStatusObservationTokenState(
  basePath: string,
  token: string,
  now: number = Date.now(),
): MilestoneStatusObservationTokenState {
  if (!token.trim()) return "inactive";
  const result = readStoredTurn(basePath, token, now);
  if (result.status === "found") return "active";
  return result.status === "missing" ? "inactive" : "unavailable";
}

export function clearMilestoneStatusObservationTurn(basePath: string, token: string): boolean {
  if (!token.trim()) return false;
  try {
    return deleteStoredTurn(resolveProjectRootDbPath(basePath), token);
  } catch {
    return false;
  }
}

function materializeSourceRevision(
  basePath: string,
  turn: MilestoneStatusObservationTurn,
  captureSourceRevision: SourceRevisionCapture,
): MilestoneStatusObservationTurn {
  let sourceRevision = "unavailable";
  let contextError: MilestoneStatusObservationContextError | undefined;
  try {
    const preferences = loadEffectiveGSDPreferences(basePath)?.preferences;
    const captured = captureSourceRevision(basePath, preferences);
    if (captured.ok) sourceRevision = captured.sourceRevision;
    else contextError = "unavailable";
  } catch {
    contextError = "unavailable";
  }

  const updated: MilestoneStatusObservationTurn = {
    ...turn,
    sourceRevision,
    ...(contextError ? { contextError } : {}),
  };
  const updatedAt = new Date().toISOString();
  const stored = withContextDatabase(turn.databasePath, (database) =>
    updateMilestoneStatusObservationTurn(database, {
      key: turnKey(turn.token),
      expectedValueJson: JSON.stringify(turn),
      valueJson: JSON.stringify(updated),
      updatedAt,
    })
  );
  if (stored.available && stored.value) return updated;
  const current = readStoredTurn(basePath, turn.token, Date.now());
  return current.status === "found" ? current.turn : updated;
}

export function resolveMilestoneStatusObservationContext(
  basePath: string,
  transport: MilestoneStatusTransport,
  token?: string,
  captureSourceRevision: SourceRevisionCapture = captureMilestoneVerificationSourceRevision,
): MilestoneStatusObservationContext {
  let selected = token?.trim()
    ? readStoredTurn(basePath, token.trim(), Date.now())
    : { status: "missing" as const };
  if (
    selected.status === "found"
    && selected.turn.sourceRevision === MILESTONE_STATUS_OBSERVATION_PENDING_SOURCE_REVISION
  ) {
    selected = {
      status: "found",
      turn: materializeSourceRevision(basePath, selected.turn, captureSourceRevision),
    };
  }
  if (selected.status === "found") {
    return {
      mode: selected.turn.mode,
      transport,
      sourceRevision: selected.turn.sourceRevision,
      ...(selected.turn.traceId ? { traceId: selected.turn.traceId } : {}),
      ...(selected.turn.turnId ? { turnId: selected.turn.turnId } : {}),
      ...(selected.turn.contextError ? { contextError: selected.turn.contextError } : {}),
    };
  }

  return {
    mode: transport === "native_pi" ? "interactive" : "legacy",
    transport,
    sourceRevision: "unavailable",
    contextError: selected.status === "invalid" ? "invalid" : "unavailable",
  };
}
