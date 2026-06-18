// Project/App: gsd-pi
// File Purpose: Recover missing milestone lease state for resumed isolated workers.

import { debugLog } from "../debug-logger.js";
import { claimMilestoneLease } from "../db/milestone-leases.js";
import type { getIsolationMode } from "../preferences.js";

type IsolationMode = ReturnType<typeof getIsolationMode>;

export interface MilestoneLeaseSession {
  workerId: string | null;
  currentMilestoneId: string | null;
  milestoneLeaseToken: number | null;
}

export function hasHeldMilestoneLease(
  session: MilestoneLeaseSession,
  milestoneId: string | null | undefined,
): boolean {
  return (
    Boolean(milestoneId) &&
    session.currentMilestoneId === milestoneId &&
    typeof session.milestoneLeaseToken === "number"
  );
}

export function reclaimMissingMilestoneLease(
  session: MilestoneLeaseSession,
  milestoneId: string | null | undefined,
  isolationMode: IsolationMode,
  phase: string,
): void {
  if (isolationMode === "none") return;
  if (!session.workerId || !milestoneId) return;
  if (hasHeldMilestoneLease(session, milestoneId)) return;
  // Note: we intentionally do NOT bail just because the session already holds a
  // lease for a *different* milestone. When dispatch advances to a new
  // milestone the session's stale `currentMilestoneId`/token are for the prior
  // one, and the active milestone's lease must still be claimed — otherwise
  // worktree safety sees `held: false` and fails dispatch (#760). Claiming is
  // safe: claimMilestoneLease refuses to steal a lease another worker holds.

  try {
    const claim = claimMilestoneLease(session.workerId, milestoneId);
    if (claim.ok) {
      session.currentMilestoneId = milestoneId;
      session.milestoneLeaseToken = claim.token;
      debugLog("worktreeSafety", {
        phase: "lease-reclaimed",
        source: phase,
        milestoneId,
        workerId: session.workerId,
        token: claim.token,
      });
    } else {
      debugLog("worktreeSafety", {
        phase: "lease-reclaim-blocked",
        source: phase,
        milestoneId,
        workerId: session.workerId,
        holderWorkerId: claim.byWorker,
        expiresAt: claim.expiresAt,
      });
    }
  } catch (err) {
    debugLog("worktreeSafety", {
      phase: "lease-reclaim-failed",
      source: phase,
      milestoneId,
      workerId: session.workerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
