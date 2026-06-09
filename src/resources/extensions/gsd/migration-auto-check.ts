import { existsSync, readdirSync, readFileSync } from "node:fs";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import {
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
} from "./gsd-db.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import { parsePlan, parseRoadmap } from "./parsers-legacy.js";
import {
  milestonesDir,
  resolveMilestoneFile,
  resolveSliceFile,
} from "./paths.js";

export interface HierarchyCounts {
  milestones: number;
  slices: number;
  tasks: number;
}

export interface MigrationAutoCheckResult {
  action: "none" | "recovery-required";
  reason: "no-markdown" | "in-sync" | "db-empty" | "count-mismatch" | "markdown-missing";
  markdown: HierarchyCounts;
  beforeDb: HierarchyCounts;
  afterDb: HierarchyCounts;
  recoveryCommand?: string;
  message?: string;
}

interface HierarchyScan {
  counts: HierarchyCounts;
  // Fully-qualified identities: milestone "M001", slice "M001/S01",
  // task "M001/S01/T01". Used to detect drift the cardinalities miss (a
  // deleted+added pair nets to the same counts but is real divergence).
  milestones: Set<string>;
  slices: Set<string>;
  tasks: Set<string>;
  // Markdown milestones whose dir has no ROADMAP (CONTEXT/CONTEXT-DRAFT only
  // or empty). Always empty for DB scans.
  milestonesWithoutRoadmap: Set<string>;
}

function zeroCounts(): HierarchyCounts {
  return { milestones: 0, slices: 0, tasks: 0 };
}

function emptyScan(): HierarchyScan {
  return {
    counts: zeroCounts(),
    milestones: new Set(),
    slices: new Set(),
    tasks: new Set(),
    milestonesWithoutRoadmap: new Set(),
  };
}

function sameCounts(a: HierarchyCounts, b: HierarchyCounts): boolean {
  return a.milestones === b.milestones && a.slices === b.slices && a.tasks === b.tasks;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function scanIdentitiesMatch(a: HierarchyScan, b: HierarchyScan): boolean {
  return (
    setsEqual(a.milestones, b.milestones) &&
    setsEqual(a.slices, b.slices) &&
    setsEqual(a.tasks, b.tasks)
  );
}

/** True if any element of `a` is absent from `b`. */
function hasExtra(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) if (!b.has(value)) return true;
  return false;
}

function scanHasExtraIdentities(a: HierarchyScan, b: HierarchyScan): boolean {
  return (
    hasExtra(a.milestones, b.milestones) ||
    hasExtra(a.slices, b.slices) ||
    hasExtra(a.tasks, b.tasks)
  );
}

/**
 * True when the DB holds any milestone/slice/task identity the markdown lacks —
 * i.e. a `/gsd recover --confirm` (markdown → DB) would DELETE authoritative DB
 * rows. This is identity-based, so it catches equal-count divergence (e.g. DB
 * slice `S99` vs markdown `S01`) that a cardinality-only check misses. Used by
 * the recover data-loss guard.
 */
export function recoverWouldDeleteDbRows(basePath: string): boolean {
  return scanHasExtraIdentities(scanDbHierarchy(), scanMarkdownHierarchy(basePath));
}

export function scanMarkdownHierarchy(basePath: string): HierarchyScan {
  const root = milestonesDir(basePath);
  if (!existsSync(root)) return emptyScan();

  const scan = emptyScan();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^M\d+/.test(entry.name)) continue;
    // Use the CANONICAL milestone id (e.g. "M001" or "M001-a1b2c3"), matching
    // scanDbHierarchy's milestone.id — not the raw directory name, which may
    // carry a legacy descriptor (e.g. "M001-some-descriptor"). The canonical id
    // both keys the identity sets AND resolves files correctly: resolveFile's
    // prefix/legacy-pattern matching handles the descriptor dir either way.
    const milestoneId = entry.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/)?.[1] ?? entry.name;
    scan.counts.milestones++;
    scan.milestones.add(milestoneId);

    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) {
      scan.milestonesWithoutRoadmap.add(milestoneId);
      continue;
    }

    const roadmap = parseRoadmap(readFileSync(roadmapPath, "utf-8"));
    scan.counts.slices += roadmap.slices.length;

    for (const slice of roadmap.slices) {
      scan.slices.add(`${milestoneId}/${slice.id}`);
      const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
      if (!planPath || !existsSync(planPath)) continue;
      const plan = parsePlan(readFileSync(planPath, "utf-8"));
      scan.counts.tasks += plan.tasks.length;
      for (const task of plan.tasks) {
        scan.tasks.add(`${milestoneId}/${slice.id}/${task.id}`);
      }
    }
  }

  return scan;
}

export function scanDbHierarchy(): HierarchyScan {
  if (!isDbAvailable()) return emptyScan();
  const scan = emptyScan();
  const milestones = getAllMilestones();
  scan.counts.milestones = milestones.length;

  for (const milestone of milestones) {
    scan.milestones.add(milestone.id);
    const slices = getMilestoneSlices(milestone.id);
    scan.counts.slices += slices.length;
    for (const slice of slices) {
      scan.slices.add(`${milestone.id}/${slice.id}`);
      const tasks = getSliceTasks(milestone.id, slice.id);
      scan.counts.tasks += tasks.length;
      for (const task of tasks) {
        scan.tasks.add(`${milestone.id}/${slice.id}/${task.id}`);
      }
    }
  }

  return scan;
}

export function countMarkdownHierarchy(basePath: string): HierarchyCounts {
  return scanMarkdownHierarchy(basePath).counts;
}

export function countDbHierarchy(): HierarchyCounts {
  return scanDbHierarchy().counts;
}

export async function checkMarkdownHierarchyAgainstDb(
  basePath: string,
): Promise<MigrationAutoCheckResult> {
  const markdownScan = scanMarkdownHierarchy(basePath);

  // Always open the DB before deciding. An empty markdown tree does NOT imply
  // an empty project — the DB may hold authoritative rows whose markdown was
  // lost, which is itself recoverable drift. The previous early return here
  // skipped the DB entirely and silently hid a populated-DB/empty-markdown
  // project.
  const opened = await ensureDbOpen(basePath);
  if (!opened || !isDbAvailable()) {
    throw new Error(`failed to open or create the GSD database at ${basePath}`);
  }

  // The markdown projections may have just been written by a workflow/MCP
  // server in another process. Reopen before comparing so startup does not
  // warn from a stale long-lived SQLite handle.
  refreshWorkflowDatabaseFromDisk();

  const dbScan = scanDbHierarchy();
  const beforeDb = dbScan.counts;

  // Discussion-phase scratch: a milestone dir with no ROADMAP and no DB row is
  // a pre-registration discussion artifact (CONTEXT/CONTEXT-DRAFT only — the
  // queued DB row is inserted only at discussion handoff). Treating it as
  // drift would warn on every live discussion and recommend
  // `/gsd recover --confirm`, an import that materializes abandoned-discussion
  // dirs as ghost active milestones. Exclude such dirs from this comparison
  // only; recover preflights use the raw scans and still see them.
  for (const id of markdownScan.milestonesWithoutRoadmap) {
    if (dbScan.milestones.has(id)) continue;
    markdownScan.milestones.delete(id);
    markdownScan.counts.milestones--;
  }
  const markdown = markdownScan.counts;

  const markdownEmpty = sameCounts(markdown, zeroCounts());
  const dbEmpty = sameCounts(beforeDb, zeroCounts());

  // Genuinely empty project: nothing on disk, nothing in the DB.
  if (markdownEmpty && dbEmpty) {
    return { action: "none", reason: "no-markdown", markdown, beforeDb, afterDb: beforeDb };
  }

  // In sync only when both cardinalities AND identities agree. Identity
  // comparison catches drift the counts miss (e.g. a slice deleted from the DB
  // and a different one added nets to the same count but is real divergence,
  // and a missing PLAN.md vs DB tasks shows up as a task-identity gap).
  if (sameCounts(markdown, beforeDb) && scanIdentitiesMatch(markdownScan, dbScan)) {
    return { action: "none", reason: "in-sync", markdown, beforeDb, afterDb: beforeDb };
  }

  // Choose the SAFE repair direction by IDENTITY, not cardinality. Recover
  // imports markdown → DB and DELETES any DB row markdown lacks, so it must
  // never be recommended when the DB holds identities the markdown is missing —
  // including equal-count divergence (DB `S99` vs markdown `S01`), which a
  // count-only check would wrongly route to recover. Whenever the DB holds rows
  // markdown lacks, the correct repair is to re-project from the DB (rebuild).
  const dbHasExtra = scanHasExtraIdentities(dbScan, markdownScan);

  const countsLine =
    `Markdown planning artifacts (${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T) ` +
    `do not match the authoritative DB (${beforeDb.milestones}M/${beforeDb.slices}S/${beforeDb.tasks}T). `;

  // The DB holds rows markdown lacks (richer, identity-diverged, or markdown
  // entirely missing): re-project from the DB. Recover here would destroy data.
  if (dbHasExtra) {
    return {
      action: "recovery-required",
      reason: markdownEmpty ? "markdown-missing" : "count-mismatch",
      markdown,
      beforeDb,
      afterDb: beforeDb,
      recoveryCommand: "/gsd rebuild markdown",
      message:
        countsLine +
        "The DB holds rows the markdown lacks, so the markdown projection is stale. " +
        "Run `/gsd rebuild markdown` to re-project from the authoritative DB. " +
        "Do NOT run `/gsd recover --confirm` here — it would delete the extra DB rows.",
    };
  }

  // DB is empty (or markdown is strictly richer): markdown is the surviving
  // source to import.
  const reason = dbEmpty ? "db-empty" : "count-mismatch";
  return {
    action: "recovery-required",
    reason,
    markdown,
    beforeDb,
    afterDb: beforeDb,
    recoveryCommand: "/gsd recover --confirm",
    message:
      countsLine +
      "Runtime startup will not import markdown automatically; run `/gsd recover --confirm` if markdown should repopulate the database.",
  };
}
