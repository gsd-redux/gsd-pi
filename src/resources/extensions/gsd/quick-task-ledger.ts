// Project/App: GSD-2
// File Purpose: Quick-task completion ledger import and recording helpers.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { isDbAvailable, openDatabase, upsertQuickTask, type QuickTaskRow } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";

const QUICK_DIR_RE = /^(\d+)-(.+)$/;

export interface QuickTaskCompletionInput {
  id: string;
  origin: QuickTaskRow["origin"];
  description: string;
  status?: QuickTaskRow["status"];
  summaryPath?: string;
  branch?: string;
  commitSha?: string | null;
  captureId?: string | null;
  completedAt?: string;
  fullSummaryMd?: string;
}

function ensureQuickTaskDb(basePath: string): boolean {
  if (isDbAvailable()) return true;
  try {
    mkdirSync(gsdRoot(basePath), { recursive: true });
    return openDatabase(join(gsdRoot(basePath), "gsd.db"));
  } catch (err) {
    logWarning("db", `quick-task ledger unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function quickTaskStatusFromSummary(content: string): QuickTaskRow["status"] {
  return /\balready resolved\b/i.test(content) ? "already-resolved" : "complete";
}

function normalizeQuickTaskId(id: string): string {
  const trimmed = id.trim();
  if (/^Q\d+$/i.test(trimmed)) return `Q${trimmed.slice(1).padStart(3, "0")}`;
  return trimmed;
}

export function recordQuickTaskCompletion(basePath: string, input: QuickTaskCompletionInput): boolean {
  if (!ensureQuickTaskDb(basePath)) return false;
  const summaryPath = input.summaryPath ?? "";
  let fullSummaryMd = input.fullSummaryMd ?? "";
  if (!fullSummaryMd && summaryPath) {
    try {
      fullSummaryMd = readFileSync(join(basePath, summaryPath), "utf-8");
    } catch {
      try {
        fullSummaryMd = readFileSync(join(gsdRoot(basePath), summaryPath.replace(/^\.gsd\//, "")), "utf-8");
      } catch {
        fullSummaryMd = "";
      }
    }
  }
  const status = input.status ?? quickTaskStatusFromSummary(fullSummaryMd);
  if (!fullSummaryMd && status === "complete" && !input.commitSha) return false;

  upsertQuickTask({
    id: normalizeQuickTaskId(input.id),
    origin: input.origin,
    description: input.description,
    status,
    summary_path: summaryPath,
    branch: input.branch ?? "",
    commit_sha: input.commitSha ?? null,
    capture_id: input.captureId ?? null,
    completed_at: input.completedAt ?? new Date().toISOString(),
    full_summary_md: fullSummaryMd,
  });
  return true;
}

export function importCompletedQuickTasks(basePath: string, origin: QuickTaskRow["origin"] = "migration"): number {
  const quickDir = join(gsdRoot(basePath), "quick");
  if (!existsSync(quickDir) || !ensureQuickTaskDb(basePath)) return 0;

  let imported = 0;
  for (const dirName of readdirSync(quickDir)) {
    const match = dirName.match(QUICK_DIR_RE);
    if (!match) continue;
    const taskNum = Number(match[1]);
    const slug = match[2];
    const summaryRel = `.gsd/quick/${dirName}/${taskNum}-SUMMARY.md`;
    const summaryAbs = join(quickDir, dirName, `${taskNum}-SUMMARY.md`);
    if (!existsSync(summaryAbs)) continue;
    const fullSummaryMd = readFileSync(summaryAbs, "utf-8");
    const ok = recordQuickTaskCompletion(basePath, {
      id: `Q${String(taskNum).padStart(3, "0")}`,
      origin,
      description: extractQuickTaskDescription(fullSummaryMd) ?? slug.replace(/-/g, " "),
      status: quickTaskStatusFromSummary(fullSummaryMd),
      summaryPath: summaryRel,
      fullSummaryMd,
    });
    if (ok) imported++;
  }
  return imported;
}

function extractQuickTaskDescription(content: string): string | null {
  const heading = content.match(/^#\s+Quick Task:\s+(.+)$/im);
  if (heading?.[1]) return heading[1].trim();
  return null;
}
