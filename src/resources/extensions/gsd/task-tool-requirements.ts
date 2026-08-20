// Project/App: gsd-pi
// File Purpose: Validate persisted task tool requirements against the execution unit contract.

import { UNIT_REGISTRY, type UnitDescriptor } from "./unit-registry.js";
import { getUnitToolSurfaceContract } from "./unit-tool-contracts.js";

const TASK_EXECUTION_UNITS = ["execute-task", "execute-task-simple"] as const;

export function validateTaskToolRequirements(taskId: string, requiredTools: readonly string[]): string | null {
  const incompatible = requiredTools.flatMap((tool) => {
    const unavailableUnits = TASK_EXECUTION_UNITS.filter((unitType) => {
      const contract = getUnitToolSurfaceContract(unitType);
      return !new Set<string>(contract?.allowedGsdTools ?? []).has(tool);
    });
    return unavailableUnits.length > 0 ? [{ tool, unavailableUnits }] : [];
  });
  if (incompatible.length === 0) return null;

  return incompatible.map(({ tool, unavailableUnits }) => {
    const completionOwners = (Object.entries(UNIT_REGISTRY) as Array<[string, UnitDescriptor]>)
      .filter(([, descriptor]) => (
        descriptor.phaseChain?.some((phase) => phase === "completion") &&
        descriptor.toolContract?.allowedGsdTools.some((allowedTool) => allowedTool === tool)
      ))
      .map(([unitType]) => unitType)
      .sort((left, right) => Number(right === "complete-slice") - Number(left === "complete-slice"));
    const ownerGuidance = completionOwners.length > 0
      ? ` Route this lifecycle mutation to completion-owned ${completionOwners.join(" or ")} work.`
      : " Route this work to a lifecycle unit whose tool contract owns the mutation.";
    return `task ${taskId} requires workflow tool "${tool}", but the target execution contract${unavailableUnits.length === 1 ? "" : "s"} ${unavailableUnits.join(" and ")} cannot call it.${ownerGuidance}`;
  }).join("\n");
}
