// Project/App: gsd-pi
// File Purpose: Define the single canonical Kernel stage transition policy.

export const KERNEL_STAGE_TRANSITIONS = {
  execute: ["verify", "route"],
  verify: ["route"],
  route: ["closeout"],
  closeout: ["settled"],
  settled: [],
} as const;

export type KernelStage = keyof typeof KERNEL_STAGE_TRANSITIONS;

export function isAllowedKernelStageTransition(currentStage: KernelStage, nextStage: KernelStage): boolean {
  return (KERNEL_STAGE_TRANSITIONS[currentStage] as readonly KernelStage[]).includes(nextStage);
}

export function kernelStageTransitionSql(): string {
  return Object.entries(KERNEL_STAGE_TRANSITIONS)
    .filter(([, nextStages]) => nextStages.length > 0)
    .map(([currentStage, nextStages]) => {
      const allowed = nextStages.map((nextStage) => `'${nextStage}'`).join(", ");
      return `(previous.next_stage = '${currentStage}' AND NEW.next_stage IN (${allowed}))`;
    })
    .join(" OR\n            ");
}
