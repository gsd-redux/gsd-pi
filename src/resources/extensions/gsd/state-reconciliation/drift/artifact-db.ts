// Project/App: gsd-pi
// File Purpose: Fail-closed reconciliation guards for DB/artifact and slice-id drift.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  _getAdapter,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "../../gsd-db.js";
import { clearParseCache } from "../../files.js";
import {
  clearPathCache,
  gsdProjectionRoot,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
} from "../../paths.js";
import { isClosedStatus } from "../../status-guards.js";
import { invalidateStateCache } from "../../state.js";
import type { GSDState } from "../../types.js";
import { isAfter, latestExplicitReopenAt } from "../../milestone-reopen-events.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type DiskSliceIdDivergenceDrift = Extract<
  DriftRecord,
  { kind: "disk-slice-id-divergence" }
>;
type ArtifactDbStatusDivergenceDrift = Extract<
  DriftRecord,
  { kind: "artifact-db-status-divergence" }
>;
type CompletedMilestoneReopenedDrift = Extract<
  DriftRecord,
  { kind: "completed-milestone-reopened" }
>;

type ArtifactStatusRow = {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  imported_at: string | null;
};

type CompletedDispatchRow = {
  started_at: string | null;
  ended_at: string | null;
};

function safeListArtifactRows(milestoneId: string): ArtifactStatusRow[] {
  const adapter = _getAdapter();
  if (!adapter) return [];
  try {
    return adapter
      .prepare(
        `SELECT path, artifact_type, milestone_id, slice_id, task_id, imported_at
         FROM artifacts
         WHERE milestone_id = :mid
         ORDER BY imported_at, path`,
      )
      .all({ ":mid": milestoneId }) as ArtifactStatusRow[];
  } catch {
    return [];
  }
}

function latestCompletedMilestoneDispatch(
  milestoneId: string,
): CompletedDispatchRow | null {
  const adapter = _getAdapter();
  if (!adapter) return null;
  try {
    const row = adapter
      .prepare(
        `SELECT started_at, ended_at
         FROM unit_dispatches
         WHERE milestone_id = :mid
           AND unit_type = 'complete-milestone'
           AND unit_id = :mid
           AND status = 'completed'
         ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
         LIMIT 1`,
      )
      .get({ ":mid": milestoneId }) as CompletedDispatchRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function hasExplicitReopenAfter(
  basePath: string,
  milestoneId: string,
  completedDispatchAt: string | null | undefined,
): boolean {
  const reopenAt = latestExplicitReopenAt(basePath, milestoneId);
  if (!reopenAt) return false;
  if (!completedDispatchAt) return true;
  return Date.parse(reopenAt) > Date.parse(completedDispatchAt);
}

function addUniqueDrift(
  drifts: ArtifactDbStatusDivergenceDrift[],
  seen: Set<string>,
  drift: ArtifactDbStatusDivergenceDrift,
): void {
  const key = [
    drift.milestoneId,
    drift.sliceId ?? "",
    drift.taskId ?? "",
    drift.artifactType,
    drift.artifactPath ?? "",
    drift.reason,
  ].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  drifts.push(drift);
}

function detectArtifactDbStatusDriftForMilestone(
  basePath: string,
  milestoneId: string,
): ArtifactDbStatusDivergenceDrift[] {
  const milestone = getAllMilestones().find((m) => m.id === milestoneId);
  if (!milestone || isClosedStatus(milestone.status)) return [];

  const latestReopen = latestExplicitReopenAt(basePath, milestoneId);
  const artifacts = safeListArtifactRows(milestoneId).filter((row) =>
    isAfter(row.imported_at, latestReopen),
  );
  const bySlice = new Map(getMilestoneSlices(milestoneId).map((slice) => [slice.id, slice]));
  const drifts: ArtifactDbStatusDivergenceDrift[] = [];
  const seen = new Set<string>();

  for (const slice of bySlice.values()) {
    if (!isClosedStatus(slice.status)) {
      const diskSummary = resolveSliceFile(basePath, milestoneId, slice.id, "SUMMARY");
      if (diskSummary && existsSync(diskSummary)) {
        addUniqueDrift(drifts, seen, {
          kind: "artifact-db-status-divergence",
          milestoneId,
          sliceId: slice.id,
          artifactType: "SUMMARY",
          artifactPath: diskSummary,
          dbStatus: slice.status,
          reason: `slice ${slice.id} has SUMMARY on disk while DB status is ${slice.status}`,
        });
      }
    }

    const tasks = getSliceTasks(milestoneId, slice.id);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const summaryRows = artifacts.filter(
      (row) =>
        row.artifact_type === "SUMMARY" &&
        row.slice_id === slice.id &&
        row.task_id,
    );

    if (tasks.length === 0 && summaryRows.length > 0) {
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        artifactType: "SUMMARY",
        artifactPath: summaryRows[0]?.path,
        dbStatus: "no-db-tasks",
        reason: `slice ${slice.id} has task SUMMARY artifacts but no DB tasks`,
      });
    }

    for (const row of summaryRows) {
      const task = row.task_id ? taskById.get(row.task_id) : null;
      if (!task) {
        if (tasks.length > 0) {
          addUniqueDrift(drifts, seen, {
            kind: "artifact-db-status-divergence",
            milestoneId,
            sliceId: slice.id,
            taskId: row.task_id ?? undefined,
            artifactType: "SUMMARY",
            artifactPath: row.path,
            dbStatus: "missing-db-task",
            reason: `task ${slice.id}/${row.task_id} has SUMMARY artifact but no DB task`,
          });
        }
        continue;
      }
      if (isClosedStatus(task.status)) continue;
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        taskId: row.task_id ?? undefined,
        artifactType: "SUMMARY",
        artifactPath: row.path,
        dbStatus: task.status,
        reason: `task ${slice.id}/${row.task_id} has SUMMARY artifact while DB status is ${task.status}`,
      });
    }

    for (const task of tasks) {
      if (isClosedStatus(task.status)) continue;
      const diskTaskSummary = resolveTaskFile(
        basePath,
        milestoneId,
        slice.id,
        task.id,
        "SUMMARY",
      );
      if (!diskTaskSummary || !existsSync(diskTaskSummary)) continue;
      addUniqueDrift(drifts, seen, {
        kind: "artifact-db-status-divergence",
        milestoneId,
        sliceId: slice.id,
        taskId: task.id,
        artifactType: "SUMMARY",
        artifactPath: diskTaskSummary,
        dbStatus: task.status,
        reason: `task ${slice.id}/${task.id} has SUMMARY on disk while DB status is ${task.status}`,
      });
    }
  }

  for (const row of artifacts) {
    if (row.artifact_type !== "SUMMARY" || !row.slice_id || row.task_id) continue;
    const slice = bySlice.get(row.slice_id);
    if (!slice || isClosedStatus(slice.status)) continue;
    addUniqueDrift(drifts, seen, {
      kind: "artifact-db-status-divergence",
      milestoneId,
      sliceId: row.slice_id,
      artifactType: "SUMMARY",
      artifactPath: row.path,
      dbStatus: slice.status,
      reason: `slice ${row.slice_id} has SUMMARY artifact while DB status is ${slice.status}`,
    });
  }

  return drifts;
}

function classifyDiskOnlySliceDir(
  sliceDir: string,
): DiskSliceIdDivergenceDrift["disposition"] {
  let sawScaffold = false;
  const stack = [sliceDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return "block-meaningful";
    }
    if (entries.length === 0 && dir !== sliceDir) {
      sawScaffold = true;
      continue;
    }
    for (const entry of entries) {
      if (entry === ".DS_Store") continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        return "block-meaningful";
      }
      if (stat.isDirectory()) {
        sawScaffold = true;
        stack.push(full);
        continue;
      }
      if (stat.isFile() && stat.size === 0) {
        sawScaffold = true;
        continue;
      }
      return "block-meaningful";
    }
  }

  return sawScaffold ? "quarantine-scaffold" : "delete-empty";
}

function detectDiskSliceIdDivergenceForMilestone(
  basePath: string,
  milestoneId: string,
): DiskSliceIdDivergenceDrift[] {
  const milestonePath = resolveMilestonePath(basePath, milestoneId);
  if (!milestonePath) return [];

  const slicesDir = join(milestonePath, "slices");
  if (!existsSync(slicesDir)) return [];

  const knownSliceIds = new Set(getMilestoneSlices(milestoneId).map((slice) => slice.id));
  const drifts: DiskSliceIdDivergenceDrift[] = [];

  for (const entry of readdirSync(slicesDir)) {
    const sliceDir = join(slicesDir, entry);
    try {
      if (!lstatSync(sliceDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry === "parallel-research") continue;
    if (knownSliceIds.has(entry)) continue;

    const disposition = classifyDiskOnlySliceDir(sliceDir);
    drifts.push({
      kind: "disk-slice-id-divergence",
      milestoneId,
      sliceId: entry,
      sliceDir,
      disposition,
      reason:
        disposition === "block-meaningful"
          ? `disk-only slice directory ${entry} contains meaningful files and is not in the DB`
          : `disk-only slice directory ${entry} is not in the DB`,
    });
  }

  return drifts;
}

export function detectArtifactDbDrift(
  _state: GSDState,
  ctx: DriftContext,
): Array<
  | DiskSliceIdDivergenceDrift
  | ArtifactDbStatusDivergenceDrift
  | CompletedMilestoneReopenedDrift
> {
  if (!isDbAvailable()) return [];

  const drifts: Array<
    | DiskSliceIdDivergenceDrift
    | ArtifactDbStatusDivergenceDrift
    | CompletedMilestoneReopenedDrift
  > = [];

  for (const milestone of getAllMilestones()) {
    if (isClosedStatus(milestone.status)) continue;

    const completedDispatch = latestCompletedMilestoneDispatch(milestone.id);
    const completedAt = completedDispatch?.ended_at ?? completedDispatch?.started_at ?? null;
    if (
      completedDispatch &&
      !hasExplicitReopenAfter(ctx.basePath, milestone.id, completedAt)
    ) {
      drifts.push({
        kind: "completed-milestone-reopened",
        milestoneId: milestone.id,
        dbStatus: milestone.status,
        completedDispatchAt: completedAt,
      });
    }

    drifts.push(...detectArtifactDbStatusDriftForMilestone(ctx.basePath, milestone.id));
    drifts.push(...detectDiskSliceIdDivergenceForMilestone(ctx.basePath, milestone.id));
  }

  return drifts;
}

function quarantineSliceDir(record: DiskSliceIdDivergenceDrift, basePath: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantineDir = join(
    gsdProjectionRoot(basePath),
    "quarantine",
    "milestones",
    record.milestoneId,
    "slices",
  );
  mkdirSync(quarantineDir, { recursive: true });
  const target = join(quarantineDir, `${basename(record.sliceDir)}-${stamp}`);
  renameSync(record.sliceDir, target);
}

function diskSliceIdDivergenceGuidance(record: DiskSliceIdDivergenceDrift): string {
  const quarantineExample = `.gsd/quarantine/milestones/${record.milestoneId}/slices/${record.sliceId}-manual-review`;
  return (
    `Slice ID drift in ${record.milestoneId}: ${record.reason}. ` +
    "Runtime will not import disk-only slice IDs into the DB. " +
    `Review ${record.sliceDir}. ` +
    `If ${record.sliceId} is stale, move or delete that directory; to preserve it, move it under ${quarantineExample}. ` +
    "If it contains work to keep, copy or merge that content into a DB-backed slice, or explicitly recreate the slice through GSD planning, then remove the disk-only directory. " +
    `After repair, run /gsd doctor ${record.milestoneId}, then resume with /gsd next or /gsd auto.`
  );
}

export function repairArtifactDbDrift(
  record:
    | DiskSliceIdDivergenceDrift
    | ArtifactDbStatusDivergenceDrift
    | CompletedMilestoneReopenedDrift,
  ctx: DriftContext,
): void {
  if (record.kind === "disk-slice-id-divergence") {
    if (record.disposition === "delete-empty") {
      rmSync(record.sliceDir, { recursive: true, force: true });
    } else if (record.disposition === "quarantine-scaffold") {
      quarantineSliceDir(record, ctx.basePath);
    } else {
      throw new Error(diskSliceIdDivergenceGuidance(record));
    }
    clearPathCache();
    clearParseCache();
    invalidateStateCache();
    return;
  }

  if (record.kind === "completed-milestone-reopened") {
    throw new Error(
      `Milestone ${record.milestoneId} has completed complete-milestone dispatch history` +
        ` (${record.completedDispatchAt ?? "time unknown"}) but the DB status is ${record.dbStatus}. ` +
        "Refusing to plan it again without an explicit reopen or recovery.",
    );
  }

  throw new Error(
    `Artifact/DB status drift in ${record.milestoneId}` +
      `${record.sliceId ? `/${record.sliceId}` : ""}` +
      `${record.taskId ? `/${record.taskId}` : ""}: ${record.reason}. ` +
      "Runtime will not silently import completion artifacts into DB state. " +
      "Run `/gsd rebuild markdown` after review to quarantine stale projections and re-render from the DB; use `/gsd recover --confirm` only when markdown should repopulate a lost or corrupt DB.",
  );
}

export function describeArtifactDbDriftBlocker(
  record:
    | DiskSliceIdDivergenceDrift
    | ArtifactDbStatusDivergenceDrift
    | CompletedMilestoneReopenedDrift,
): string | null {
  if (record.kind === "disk-slice-id-divergence") {
    if (record.disposition !== "block-meaningful") return null;
    return diskSliceIdDivergenceGuidance(record);
  }

  if (record.kind === "completed-milestone-reopened") {
    return (
      `Milestone ${record.milestoneId} has completed complete-milestone dispatch history` +
      ` (${record.completedDispatchAt ?? "time unknown"}) but the DB status is ${record.dbStatus}. ` +
      "Refusing to plan it again without an explicit reopen or recovery."
    );
  }

  return (
    `Artifact/DB status drift in ${record.milestoneId}` +
    `${record.sliceId ? `/${record.sliceId}` : ""}` +
    `${record.taskId ? `/${record.taskId}` : ""}: ${record.reason}. ` +
    "Runtime will not silently import completion artifacts into DB state. " +
    "Run `/gsd rebuild markdown` after review to quarantine stale projections and re-render from the DB; use `/gsd recover --confirm` only when markdown should repopulate a lost or corrupt DB."
  );
}

export const diskSliceIdDivergenceHandler: DriftHandler<DiskSliceIdDivergenceDrift> = {
  kind: "disk-slice-id-divergence",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is DiskSliceIdDivergenceDrift =>
        record.kind === "disk-slice-id-divergence",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};

export const artifactDbStatusDivergenceHandler: DriftHandler<ArtifactDbStatusDivergenceDrift> = {
  kind: "artifact-db-status-divergence",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is ArtifactDbStatusDivergenceDrift =>
        record.kind === "artifact-db-status-divergence",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};

export const completedMilestoneReopenedHandler: DriftHandler<CompletedMilestoneReopenedDrift> = {
  kind: "completed-milestone-reopened",
  detect: (state, ctx) =>
    detectArtifactDbDrift(state, ctx).filter(
      (record): record is CompletedMilestoneReopenedDrift =>
        record.kind === "completed-milestone-reopened",
    ),
  blocker: describeArtifactDbDriftBlocker,
  repair: repairArtifactDbDrift,
};
