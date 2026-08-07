// Project/App: gsd-pi
// File Purpose: Runtime state derivation from GSD workflow database and legacy files.
// GSD Extension — State Derivation
// DB-authoritative runtime derivation; legacy filesystem fallback in _deriveStateImpl only.

import type {
  GSDState,
  ActiveRef,
  Roadmap,
  RoadmapSliceEntry,
  SlicePlan,
  MilestoneRegistryEntry,
} from './types.js';

// LEGACY-ONLY import (post-cutover): the live derive seam
// (state/derive/index.ts) routes exclusively to deriveStateFromDb when the DB
// is available and fails closed via buildDbUnavailableState when it is not —
// it never consults these parsers. parseRoadmap/parsePlan remain here solely
// for _deriveStateImpl (explicit pre-migration derivation used by tests) and
// the pre-migration branch of getActiveMilestoneId. Deletion is the
// timebox-gated wave-4 task T022.
import {
  parseRoadmap,
  parsePlan,
} from './parsers-legacy.js';

import {
  parseSummary,
  loadFile,
  parseRequirementCounts,
  parseContextDependsOn,
} from './files.js';

import {
  buildMilestoneFileName,
  resolveFile,
  resolveMilestonePath,
  resolveMilestoneFile,
  resolveSlicePath,
  resolveSliceFile,
  resolveTaskFile,
  resolveTasksDir,
  resolveGsdRootFile,
  gsdRoot,
} from './paths.js';

import { findMilestoneIds } from './milestone-ids.js';
import { loadQueueOrder, sortByQueueOrder } from './queue-order.js';
import { isClosedStatus, isDeferredStatus } from './status-guards.js';
import { nativeBatchParseGsdFiles, type BatchParsedFile } from './native-parser-bridge.js';
import { join, resolve } from 'path';
import { existsSync, readdirSync } from 'node:fs';
import { debugCount, debugTime } from './debug-logger.js';
import { logWarning } from './workflow-logger.js';
import { extractVerdict } from './verdict-parser.js';
import { detectPendingEscalation } from './escalation.js';
import { isTerminalMilestoneSummaryContent } from './milestone-summary-classifier.js';
import { interruptedWorkNextAction, detectInterruptedWork } from './state/derive/interrupted-work.js';
import {
  deriveState,
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
  type DeriveStateOptions,
} from './state/derive/index.js';
import { deriveStateFromDb } from './state/derive/from-db.js';
import { getRequestedMilestoneLock, syncQueueOrderProjectionToDb } from './state/derive/db-open.js';

export {
  deriveState,
  deriveStateFromDb,
  getDeriveTelemetry,
  invalidateStateCache,
  resetDeriveTelemetry,
  type DeriveStateOptions,
};

import {
  isDbAvailable,
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSlicesByMilestoneIds,
  getSliceTasks,
  getReplanHistory,
  getSlice,
  getRequirementCounts,
  getLatestAssessmentByScope,
  getPendingGateCountForTurn,
  setMilestoneQueueOrder,
} from './gsd-db.js';
import { openExistingWorkflowDatabase, wasWorkflowDatabaseOpenAttempted } from './db-workspace.js';
import { formatCompletePhaseNextAction, countUnmappedActiveRequirements } from './requirements-backlog.js';
import type { MilestoneRow } from './db-milestone-artifact-rows.js';
import type { SliceRow, TaskRow } from './db-task-slice-rows.js';
import {
  classifyMilestoneReadiness,
  readinessNeedsDiscussion,
} from './milestone-readiness.js';

import {
  needsAttentionBlockerGuidance as formatNeedsAttentionBlocker,
  needsRemediationBlockerGuidance as formatNeedsRemediationBlocker,
} from './guidance.js';

/**
 * A "ghost" milestone directory contains only META.json (and no substantive
 * files like CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY).  These appear when
 * a milestone is created but never initialised.  Treating them as active causes
 * auto-mode to stall or falsely declare completion.
 *
 * However, a milestone is NOT a ghost if:
 * - It has a DB row with a meaningful status (queued, active, etc.) — the DB
 *   knows about it even if content files haven't been created yet.
 * - It has a worktree directory — a worktree proves the milestone was
 *   legitimately created and is expected to be populated.
 *
 * Fixes #2921: queued milestones with worktrees were incorrectly classified
 * as ghosts, causing auto-mode to skip them entirely.
 */
export function isGhostMilestone(basePath: string, mid: string): boolean {
  // If the milestone has a DB row, it's usually a known milestone — not a ghost.
  // Exception: a "queued" row with no disk artifacts is a phantom from
  // gsd_milestone_generate_id that was never planned (#3645).
  if (isDbAvailable()) {
    const dbRow = getMilestone(mid);
    if (dbRow) {
      if (dbRow.status === 'queued') {
        const hasContent = resolveMilestoneFile(basePath, mid, "CONTEXT")
          || resolveMilestoneFile(basePath, mid, "ROADMAP")
          || resolveMilestoneFile(basePath, mid, "SUMMARY");
        return !hasContent;
      }
      return false;
    }
  }

  // If a worktree exists for this milestone, it was legitimately created.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Fall back to content-file check: no substantive files means ghost.
  const context   = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft     = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap   = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary   = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

/**
 * A "reusable ghost" milestone is an orphaned filesystem stub that is safe
 * to reclaim as the next milestone ID.
 *
 * Stricter than `isGhostMilestone`: returns true ONLY when ALL of the
 * following hold:
 *   1. No DB row exists for `mid` (any status, including "queued") — a DB row
 *      means the milestone was intentionally registered by
 *      `gsd_milestone_generate_id` and may have an in-flight discuss flow.
 *      Reusing it would collide with that flow. (#4996 race window)
 *   2. No worktree directory exists at `gsdRoot/worktrees/{mid}` — a worktree
 *      means the milestone is legitimately in-flight.
 *   3. No content files exist (CONTEXT, CONTEXT-DRAFT, ROADMAP, SUMMARY) —
 *      any content means the discuss flow already ran.
 *
 * The looser `isGhostMilestone` also classifies queued-row-without-content as
 * a ghost to help state queries filter phantoms. `isReusableGhostMilestone`
 * intentionally does NOT reclaim those — a queued row is sufficient proof of
 * a live in-flight ID reservation.
 *
 * Used by `nextMilestoneIdReserved` and both MCP ID-generator tools to fill
 * gaps left by phantom directories before resorting to max+1.
 */
export function isReusableGhostMilestone(basePath: string, mid: string): boolean {
  // Condition 1: no DB row (any status).
  if (!isDbAvailable()) return false;
  const dbRow = getMilestone(mid);
  if (dbRow != null) return false;

  // Condition 2: no worktree.
  const root = gsdRoot(basePath);
  const wtPath = join(root, 'worktrees', mid);
  if (existsSync(wtPath)) return false;

  // Condition 3: no content files.
  const context = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft   = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}

// ─── Query Functions ───────────────────────────────────────────────────────

/**
 * Check if all tasks in a slice plan are done.
 */
export function isSliceComplete(plan: SlicePlan): boolean {
  return plan.tasks.length > 0 && plan.tasks.every(t => t.done);
}

/**
 * Check if all slices in a roadmap are done.
 */
export function isMilestoneComplete(roadmap: Roadmap): boolean {
  return roadmap.slices.length > 0 && roadmap.slices.every(s => s.done);
}

/**
 * Check whether a VALIDATION file's verdict is terminal.
 * Any successfully extracted verdict (pass, needs-attention, needs-remediation,
 * fail, etc.) means validation completed. Only return false when no verdict
 * could be parsed — i.e. extractVerdict() returns undefined (#2769).
 */
export function isValidationTerminal(validationContent: string): boolean {
  return extractVerdict(validationContent) != null;
}

async function isTerminalMilestoneSummaryFile(
  path: string,
  loader: (path: string) => Promise<string | null>,
): Promise<boolean> {
  const content = await loader(path);
  return content != null && isTerminalMilestoneSummaryContent(content);
}


export async function getActiveMilestoneId(basePath: string): Promise<string | null> {
  // Milestone-scoped execution. Parallel workers and explicit solo commands
  // such as `/gsd auto M002` both set GSD_MILESTONE_LOCK; state derivation must
  // honor it so recovery/adoption sees the requested milestone, not the first
  // open milestone in queue order.
  const milestoneLock = getRequestedMilestoneLock();
  if (milestoneLock) {
    if (isDbAvailable()) {
      const locked = getAllMilestones().find(m => m.id === milestoneLock);
      if (!locked || isClosedStatus(locked.status) || locked.status === "parked") return null;
      return locked.id;
    }

    const milestoneIds = findMilestoneIds(basePath);
    if (!milestoneIds.includes(milestoneLock)) return null;
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }

  // DB-first: query milestones table for the first non-complete, non-parked milestone
  if (isDbAvailable()) {
    syncQueueOrderProjectionToDb(basePath);
    const allMilestones = getAllMilestones();
    if (allMilestones.length > 0) {
      for (const m of allMilestones) {
        if (isClosedStatus(m.status) || m.status === "parked") continue;
        return m.id;
      }
      return null;
    }
  }

  // Filesystem fallback for unmigrated projects or empty DB
  const milestoneIds = findMilestoneIds(basePath);
  for (const mid of milestoneIds) {
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) continue;

    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const content = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!content) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, loadFile)) continue;
      if (isGhostMilestone(basePath, mid)) continue;
      return mid;
    }
    const roadmap = parseRoadmap(content);
    const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, loadFile)) continue;
    if (!isMilestoneComplete(roadmap)) return mid;
    return mid;
  }
  return null;
}

function stripMilestonePrefix(title: string): string {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || title;
}

function extractContextTitle(content: string | null, fallback: string): string {
  if (!content) return fallback;
  const h1 = content.split('\n').find(line => line.startsWith('# '));
  if (!h1) return fallback;
  // Extract title from "# M005: Platform Foundation & Separation" format
  return stripMilestonePrefix(h1.slice(2).trim()) || fallback;
}


// LEGACY: Filesystem-based state derivation for unmigrated projects.
// NOT reachable from the live derive seam: deriveState (state/derive/index.ts)
// dispatches to deriveStateFromDb when the DB is available and fails closed
// (buildDbUnavailableState) when it is not — this fallback branch is never
// taken on the live path. Retained and still exported for explicit
// pre-migration derivation in tests; deletion is the timebox-gated wave-4
// task T022.
export async function _deriveStateImpl(
  basePath: string,
  opts?: DeriveStateOptions,
): Promise<GSDState> {
  // When the caller supplies a canonical project root for reads (e.g.
  // s.canonicalProjectRoot from auto-mode), route all artifact reads through
  // it. This prevents the worktree-local empty `.gsd/` from being consulted
  // when the canonical state lives at the project root (or via a `.gsd`
  // symlink into the external state dir).
  if (opts?.projectRootForReads) {
    basePath = opts.projectRootForReads;
  }

  const diskIds = findMilestoneIds(basePath);
  const customOrder = loadQueueOrder(basePath);
  const milestoneIds = sortByQueueOrder(diskIds, customOrder);

  // ── Milestone-scoped execution ─────────────────────────────────────────
  // Parallel workers and explicit solo recovery both scope auto-mode to one
  // milestone through GSD_MILESTONE_LOCK.
  const milestoneLock = getRequestedMilestoneLock();
  if (milestoneLock && milestoneIds.includes(milestoneLock)) {
    milestoneIds.length = 0;
    milestoneIds.push(milestoneLock);
  }

  // ── Batch-parse file cache ──────────────────────────────────────────────
  // When the native Rust parser is available, read every .md file under .gsd/
  // in one call and build an in-memory content map keyed by absolute path.
  // This eliminates O(N) individual fs.readFile calls during traversal.
  const fileContentCache = new Map<string, string>();
  const gsdDir = gsdRoot(basePath);

  // Filesystem fallback: used when deriveStateFromDb() is not available
  // (pre-migration projects). The DB-backed path is preferred when available
  // — see deriveStateFromDb() above.
  const batchFiles = nativeBatchParseGsdFiles(gsdDir);
  if (batchFiles) {
    for (const f of batchFiles) {
      const absPath = resolve(gsdDir, f.path);
      fileContentCache.set(absPath, f.rawContent);
    }
  }

  /**
   * Load file content from batch cache first, falling back to disk read.
   * Resolves the path to absolute before cache lookup.
   */
  async function cachedLoadFile(path: string): Promise<string | null> {
    const abs = resolve(path);
    const cached = fileContentCache.get(abs);
    if (cached !== undefined) return cached;
    return loadFile(path);
  }

  const requirements = parseRequirementCounts(await cachedLoadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));

  if (milestoneIds.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [],
      blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [],
      requirements,
      progress: {
        milestones: { done: 0, total: 0 },
      },
    };
  }

  // ── Single-pass milestone scan ──────────────────────────────────────────
  // Parse each milestone's roadmap once, caching results. First pass determines
  // completeness for dependency resolution; second pass builds the registry.
  // With the batch cache, all file reads hit memory instead of disk.

  // Phase 1: Build roadmap cache and completeness set
  const roadmapCache = new Map<string, Roadmap>();
  const completeMilestoneIds = new Set<string>();

  // Track parked milestone IDs so Phase 2 can check without re-reading disk
  const parkedMilestoneIds = new Set<string>();

  for (const mid of milestoneIds) {
    // Skip parked milestones — they do NOT count as complete (don't satisfy depends_on)
    // But still parse their roadmap for title extraction in Phase 2.
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) {
      parkedMilestoneIds.add(mid);
      // Cache roadmap for title extraction (but don't add to completeMilestoneIds)
      const prf = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const prc = prf ? await cachedLoadFile(prf) : null;
      if (prc) roadmapCache.set(mid, parseRoadmap(prc));
      continue;
    }

    const rf = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const rc = rf ? await cachedLoadFile(rf) : null;
    if (!rc) {
      const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const rmap = parseRoadmap(rc);
    roadmapCache.set(mid, rmap);
    if (!isMilestoneComplete(rmap)) {
      // Summary is the terminal artifact — if it exists, the milestone is
      // complete even when roadmap checkboxes weren't ticked (#864).
      const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
  }

  // Phase 2: Build registry using cached roadmaps (no re-parsing or re-reading)
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeRoadmap: Roadmap | null = null;
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;

  for (const mid of milestoneIds) {
    // Skip parked milestones — register them as 'parked' and move on
    if (parkedMilestoneIds.has(mid)) {
      const roadmap = roadmapCache.get(mid) ?? null;
      const title = roadmap
        ? stripMilestonePrefix(roadmap.title)
        : mid;
      registry.push({ id: mid, title, status: 'parked' });
      continue;
    }

    const roadmap = roadmapCache.get(mid) ?? null;

    if (!roadmap) {
      // No roadmap — check if a summary exists (completed milestone without roadmap)
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) {
        const summaryContent = await cachedLoadFile(summaryFile);
        if (summaryContent != null && isTerminalMilestoneSummaryContent(summaryContent)) {
          const summaryTitle = summaryContent
            ? (parseSummary(summaryContent).title || mid)
            : mid;
          registry.push({ id: mid, title: summaryTitle, status: 'complete' });
          completeMilestoneIds.add(mid);
          continue;
        }
      }
      // Ghost milestone (only META.json, no CONTEXT/ROADMAP/SUMMARY) — skip entirely
      if (isGhostMilestone(basePath, mid)) continue;

      // No roadmap and no summary — treat as incomplete/active
      if (!activeMilestoneFound) {
        // Check for CONTEXT-DRAFT.md to distinguish draft-seeded from blank milestones.
        // A draft seed means the milestone has discussion material but no full context yet.
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        if (!contextFile && draftFile) activeMilestoneHasDraft = true;

        // Extract title from CONTEXT.md or CONTEXT-DRAFT.md heading before falling back to mid.
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title = extractContextTitle(contextContent || draftContent, mid);

        // Check milestone-level dependencies before promoting to active.
        // Without this, a queued milestone with depends_on in its CONTEXT
        // or CONTEXT-DRAFT frontmatter would be promoted to active even when
        // its deps are unmet. Fall back to CONTEXT-DRAFT.md when absent (#1724).
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title, status: 'pending', dependsOn: deps });
        } else {
          activeMilestone = { id: mid, title };
          activeMilestoneFound = true;
          registry.push({ id: mid, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        }
      } else {
        // For milestones after the active one, also try to extract title from context files.
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title = extractContextTitle(contextContent || draftContent, mid);
        registry.push({ id: mid, title, status: 'pending' });
      }
      continue;
    }

    const title = stripMilestonePrefix(roadmap.title);
    const complete = isMilestoneComplete(roadmap);

    if (complete) {
      // All slices done — check validation and summary state
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
      const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
      const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
      const verdict = validationContent ? extractVerdict(validationContent) : undefined;
      // needs-remediation is terminal but requires re-validation (#3596)
      const needsRevalidation = !validationTerminal || verdict === 'needs-remediation' || verdict === 'needs-attention';

      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        // Summary exists → milestone is complete regardless of validation state.
        // The summary is the terminal artifact (#864).
        registry.push({ id: mid, title, status: 'complete' });
      } else if (needsRevalidation && !activeMilestoneFound) {
        // No summary and needs (re-)validation → validating-milestone
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: 'active' });
      } else if (needsRevalidation && activeMilestoneFound) {
        // Needs (re-)validation, but another milestone is already active
        registry.push({ id: mid, title, status: 'pending' });
      } else if (!activeMilestoneFound) {
        // Terminal passing validation but no summary → completing-milestone
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: 'active' });
      } else {
        registry.push({ id: mid, title, status: 'complete' });
      }
    } else {
      // Roadmap slices not all checked — but if a summary exists, the milestone
      // is still complete. The summary is the terminal artifact (#864).
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        registry.push({ id: mid, title, status: 'complete' });
      } else if (!activeMilestoneFound) {
        // Check milestone-level dependencies before promoting to active.
        // Fall back to CONTEXT-DRAFT.md when CONTEXT.md is absent (#1724).
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title, status: 'pending', dependsOn: deps });
          // Do NOT set activeMilestoneFound — let the loop continue to the next milestone
        } else {
          activeMilestone = { id: mid, title };
          activeRoadmap = roadmap;
          activeMilestoneFound = true;
          registry.push({ id: mid, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        }
      } else {
        const contextFile2 = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFileForDeps3 = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextOrDraftContent3 = contextFile2
            ? await cachedLoadFile(contextFile2)
            : (draftFileForDeps3 ? await cachedLoadFile(draftFileForDeps3) : null);
        const deps2 = parseContextDependsOn(contextOrDraftContent3);
        registry.push({ id: mid, title, status: 'pending', ...(deps2.length > 0 ? { dependsOn: deps2 } : {}) });
      }
    }
  }

  const milestoneProgress = {
    done: registry.filter(entry => entry.status === 'complete').length,
    total: registry.length,
  };

  if (!activeMilestone) {
    // Check whether any milestones are pending (dep-blocked) or parked
    const pendingEntries = registry.filter(entry => entry.status === 'pending');
    const parkedEntries = registry.filter(entry => entry.status === 'parked');
    if (pendingEntries.length > 0) {
      // All incomplete milestones are dep-blocked — no progress possible
      const blockerDetails = pendingEntries
        .filter(entry => entry.dependsOn && entry.dependsOn.length > 0)
        .map(entry => `${entry.id} is waiting on unmet deps: ${entry.dependsOn!.join(', ')}`);
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: blockerDetails.length > 0
          ? blockerDetails
          : ['All remaining milestones are dep-blocked but no deps listed — check CONTEXT.md files'],
        nextAction: 'Resolve milestone dependencies before proceeding.',
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
        },
      };
    }
    if (parkedEntries.length > 0) {
      // All non-complete milestones are parked — nothing active, but not "all complete"
      const parkedIds = parkedEntries.map(e => e.id).join(', ');
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [],
        blockers: [],
        nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
        },
      };
    }
    // All real milestones were ghosts (empty registry) → treat as pre-planning
    if (registry.length === 0) {
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: 'pre-planning',
        recentDecisions: [],
        blockers: [],
        nextAction: 'No milestones found. Run /gsd to create one.',
        registry: [],
        requirements,
        progress: {
          milestones: { done: 0, total: 0 },
        },
      };
    }
    // All milestones complete
    const lastEntry = registry[registry.length - 1];
    const unmappedActive = countUnmappedActiveRequirements();
    const completionNote = formatCompletePhaseNextAction(unmappedActive);
    return {
      activeMilestone: null,
      lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null,
      activeTask: null,
      phase: 'complete',
      recentDecisions: [],
      blockers: [],
      nextAction: completionNote,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
      },
    };
  }

  if (!activeRoadmap) {
    // Active milestone exists but has no roadmap yet.
    // If a CONTEXT-DRAFT.md seed exists, it needs discussion before planning.
    // Otherwise, it's a blank milestone ready for initial planning.
    const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
    const nextAction = activeMilestoneHasDraft
      ? `Discuss draft context for milestone ${activeMilestone.id}.`
      : `Plan milestone ${activeMilestone.id}.`;
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase,
      recentDecisions: [],
      blockers: [],
      nextAction,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
      },
    };
  }

  // ── Zero-slice roadmap guard (#1785) ─────────────────────────────────
  // A stub roadmap (placeholder text, no slice definitions) has a truthy
  // roadmap object but an empty slices array. Without this check the
  // slice-finding loop below finds nothing and returns phase: "blocked".
  // An empty slices array means the roadmap still needs slice definitions,
  // so the correct phase is pre-planning.
  if (activeRoadmap.slices.length === 0) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: { done: 0, total: 0 },
      },
    };
  }

  // Check if active milestone needs validation or completion (all slices done)
  if (isMilestoneComplete(activeRoadmap)) {
    const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
    const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
    const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
    const verdict = validationContent ? extractVerdict(validationContent) : undefined;
    const sliceProgress = {
      done: activeRoadmap.slices.length,
      total: activeRoadmap.slices.length,
    };

    // Force re-validation when VALIDATION.md is absent or non-terminal —
    // remediation slices may have completed since the stale validation was
    // written (#3596). But needs-remediation with all slices done is a dead
    // end — return blocked to avoid an infinite dispatch loop (#4506).
    if (!validationTerminal) {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'validating-milestone',
        recentDecisions: [],
        blockers: [],
        nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }

    if (verdict === 'needs-attention') {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: [formatNeedsAttentionBlocker(activeMilestone.id)],
        nextAction: `Resolve ${activeMilestone.id} validation attention before proceeding.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }

    if (verdict === 'needs-remediation') {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: [formatNeedsRemediationBlocker(activeMilestone.id)],
        nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }

    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'completing-milestone',
      recentDecisions: [],
      blockers: [],
      nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  const sliceProgress = {
    done: activeRoadmap.slices.filter(s => s.done).length,
    total: activeRoadmap.slices.length,
  };

  // Find the active slice (first incomplete with deps satisfied)
  const doneSliceIds = new Set(activeRoadmap.slices.filter(s => s.done).map(s => s.id));
  let activeSlice: ActiveRef | null = null;

  // ── Slice-level parallel worker isolation ─────────────────────────────
  // When GSD_PARALLEL_WORKER and GSD_SLICE_LOCK are set, override activeSlice to only the locked slice.
  const sliceLockLegacy = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : undefined;
  if (sliceLockLegacy) {
    const lockedSlice = activeRoadmap.slices.find(s => s.id === sliceLockLegacy);
    if (lockedSlice) {
      activeSlice = { id: lockedSlice.id, title: lockedSlice.title };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLockLegacy} not found in active slices — worker has no assigned work`);
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: 'blocked',
        recentDecisions: [],
        blockers: [`GSD_SLICE_LOCK=${sliceLockLegacy} not found in active milestone slices`],
        nextAction: 'Slice lock references a non-existent slice — check orchestrator dispatch.',
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
        },
      };
    }
  } else {
    for (const s of activeRoadmap.slices) {
      if (s.done) continue;
      if (s.depends.every(dep => doneSliceIds.has(dep))) {
        activeSlice = { id: s.id, title: s.title };
        break;
      }
    }
  }

  if (!activeSlice) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: 'blocked',
      recentDecisions: [],
      blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  // Check if the slice has a plan
  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  const slicePlanContent = planFile ? await cachedLoadFile(planFile) : null;

  if (!slicePlanContent) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
      },
    };
  }

  const slicePlan = parsePlan(slicePlanContent);

  // ── Reconcile stale task status for filesystem-based projects (#2514) ──
  // Heading-style tasks (### T01:) are always parsed as done=false by
  // parsePlan because the heading syntax has no checkbox. When the agent
  // writes a SUMMARY file but the plan's heading isn't converted to a
  // checkbox, the task appears incomplete forever — causing infinite
  // re-dispatch. Reconcile by checking SUMMARY files on disk.
  for (const t of slicePlan.tasks) {
    if (t.done) continue;
    const summaryPath = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      t.done = true;
      logWarning("reconcile", `task ${activeMilestone.id}/${activeSlice.id}/${t.id} reconciled via SUMMARY on disk`, { mid: activeMilestone.id, sid: activeSlice.id, tid: t.id });
    }
  }

  const taskProgress = {
    done: slicePlan.tasks.filter(t => t.done).length,
    total: slicePlan.tasks.length,
  };
  const activeTaskEntry = slicePlan.tasks.find(t => !t.done);

  if (!activeTaskEntry && slicePlan.tasks.length > 0) {
    // All tasks done but slice not marked complete
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'summarizing',
      recentDecisions: [],
      blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress,
      },
    };
  }

  // Empty plan — no tasks defined yet, stay in planning phase
  if (!activeTaskEntry) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: 'planning',
      recentDecisions: [],
      blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,

      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress,
      },
    };
  }

  const activeTask: ActiveRef = {
    id: activeTaskEntry.id,
    title: activeTaskEntry.title,
  };

  // ── Task plan file check (#909) ──────────────────────────────────────
  // The slice plan may reference tasks but per-task plan files may be
  // missing — e.g. when the slice plan was pre-created during roadmapping.
  // If the tasks dir exists but has literally zero files (empty dir from
  // mkdir), fall back to planning so plan-slice generates task plans.
  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && slicePlan.tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter(f => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone,
        activeSlice,
        activeTask: null,
        phase: 'planning',
        recentDecisions: [],
        blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress,
        },
      };
    }
  }

  // ── Blocker detection: scan completed task summaries ──────────────────
  // If any completed task has blocker_discovered: true and no REPLAN.md
  // exists yet, transition to replanning-slice instead of executing.
  const completedTasks = slicePlan.tasks.filter(t => t.done);
  let blockerTaskId: string | null = null;
  for (const ct of completedTasks) {
    const summaryFile = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await cachedLoadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
  }

  if (blockerTaskId) {
    // Loop protection: if REPLAN.md already exists, a replan was already
    // performed for this slice — skip further replanning and continue executing.
    const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
    if (!replanFile) {
      return {
        activeMilestone,
        activeSlice,
        activeTask,
        phase: 'replanning-slice',
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
  
        activeWorkspace: undefined,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress,
        },
      };
    }
    // REPLAN.md exists — loop protection: fall through to normal executing
  }

  // ── REPLAN-TRIGGER detection: triage-initiated replan ──────────────────
  // Manual `/gsd triage` writes REPLAN-TRIGGER.md when a capture is classified
  // as "replan". Detect it here and transition to replanning-slice so the
  // dispatch loop picks it up (instead of silently advancing past it).
  if (!blockerTaskId) {
    const replanTriggerFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN-TRIGGER");
    if (replanTriggerFile) {
      // Same loop protection: if REPLAN.md already exists, a replan was
      // already performed — skip further replanning and continue executing.
      const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
      if (!replanFile) {
        return {
          activeMilestone,
          activeSlice,
          activeTask,
          phase: 'replanning-slice',
          recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,

          activeWorkspace: undefined,
          registry,
          requirements,
          progress: {
            milestones: milestoneProgress,
            slices: sliceProgress,
            tasks: taskProgress,
          },
        };
      }
    }
  }

  // Check for interrupted work (legacy filesystem path only)
  const hasInterrupted = await detectInterruptedWork(
    basePath,
    activeMilestone.id,
    activeSlice.id,
  );

  return {
    activeMilestone,
    activeSlice,
    activeTask,
    phase: 'executing',
    recentDecisions: [],
    blockers: [],
    nextAction: interruptedWorkNextAction(
      activeTask.id,
      activeTask.title,
      activeSlice.id,
      hasInterrupted,
    ),
    registry,
    requirements,
    progress: {
      milestones: milestoneProgress,
      slices: sliceProgress,
      tasks: taskProgress,
    },
  };
}
