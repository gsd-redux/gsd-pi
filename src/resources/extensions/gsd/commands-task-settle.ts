// Project/App: gsd-pi
// File Purpose: /gsd task settle — operator CLI surface for gsd_task_settle (#1749).

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { applyTaskSettle, planTaskSettle, type TaskSettleTask } from "./task-settle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

function parseTaskSettleArgs(args: string): {
  task: TaskSettleTask;
  reason: string;
  apply: boolean;
  reconcileLifecycle: boolean;
} | null {
  const apply = /(?:^|\s)--apply(?:\s|$)/.test(args);
  const reconcileLifecycle = /(?:^|\s)--reconcile-lifecycle(?:\s|$)/.test(args);
  const reasonMatch = args.match(/--reason\s+"([^"]+)"|--reason\s+'([^']+)'|--reason\s+(\S+)/);
  const positional = args
    .replace(/--apply/g, "")
    .replace(/--reconcile-lifecycle/g, "")
    .replace(/--reason\s+"[^"]*"|\s--reason\s+'[^']*'|--reason\s+\S+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const unit = (positional[0] ?? "").replace(/^execute-task\//, "");
  const parts = unit.split("/");
  const reason = reasonMatch?.[1] ?? reasonMatch?.[2] ?? reasonMatch?.[3] ?? "";
  if (parts.length !== 3 || parts.some((part) => part.length === 0) || reason.length === 0) return null;
  return {
    task: { milestoneId: parts[0], sliceId: parts[1], taskId: parts[2] },
    reason,
    apply,
    reconcileLifecycle,
  };
}

function cliInvocation(): ExecutionInvocation {
  const id = randomUUID();
  return {
    idempotencyKey: `cli:gsd_task_settle:${id}`,
    sourceTransport: "internal",
    actorType: "user",
    traceId: id,
  };
}

export async function handleTaskSettle(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
): Promise<void> {
  const parsed = parseTaskSettleArgs(args);
  if (!parsed) {
    ctx.ui.notify(
      'Usage: /gsd task settle <M001/S01/T01> --reason "why this Attempt is being settled" [--apply] [--reconcile-lifecycle]\n' +
      "Dry-run by default: prints the exact Attempt and optional lifecycle rows it would change. --apply performs the settle.",
      "warning",
    );
    return;
  }
  if (!await ensureDbOpen(basePath)) {
    ctx.ui.notify("gsd task settle: GSD database is not available.", "error");
    return;
  }
  const unit = `${parsed.task.milestoneId}/${parsed.task.sliceId}/${parsed.task.taskId}`;
  try {
    const settleOptions = { reconcileLifecycle: parsed.reconcileLifecycle };
    if (!parsed.apply) {
      const plan = planTaskSettle(parsed.task, parsed.reason, settleOptions);
      if (plan.rows.length === 0 && plan.lifecycleRows.length === 0) {
        ctx.ui.notify(`gsd task settle (dry run): ${unit} has no running Attempt — nothing to do.`, "info");
        return;
      }
      const lines = [
        ...plan.rows.map(
          (row) => `  attempt ${row.attemptId}: ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...plan.lifecycleRows.map(
          (row) => `  lifecycle ${row.currentStatus} → ${row.targetStatus} — ${row.rationale}`,
        ),
        ...(plan.proof ? [`  proof: ${plan.proof.note}`] : []),
      ];
      ctx.ui.notify(
        `gsd task settle (dry run) — no changes made:\n${lines.join("\n")}\nRe-run with --apply to settle.`,
        "info",
      );
      return;
    }
    const result = applyTaskSettle({
      invocation: cliInvocation(),
      task: parsed.task,
      reason: parsed.reason,
      ...settleOptions,
    });
    if (!result.settled && !result.reconciled) {
      ctx.ui.notify(`gsd task settle: ${unit} has no running Attempt — nothing to do.`, "info");
      return;
    }
    const parts: string[] = [];
    if (result.settled) {
      parts.push(`Settled Attempt ${result.rows[0].attemptId} as interrupted (${unit}).`);
    }
    if (result.reconciled) {
      const target = result.lifecycleRows[result.lifecycleRows.length - 1]?.targetStatus;
      parts.push(`Reconciled lifecycle to ${target} (${unit}) without deleting SUMMARYs.`);
    }
    ctx.ui.notify(parts.join(" "), "info");
  } catch (error) {
    ctx.ui.notify(`gsd task settle: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
