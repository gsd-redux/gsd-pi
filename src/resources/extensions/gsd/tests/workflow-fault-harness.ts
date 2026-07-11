export type WorkflowFaultPoint =
  | "before-transaction-commit"
  | "after-db-commit-before-render"
  | "during-projection-write"
  | "before-independent-reopen"
  | "after-independent-reopen";

export interface WorkflowFaultHarness {
  hit(point: WorkflowFaultPoint, operation?: string): void;
  count(point: WorkflowFaultPoint): number;
}

export class WorkflowFaultError extends Error {
  readonly point: WorkflowFaultPoint;
  readonly operation: string;
  readonly hitCount: number;

  constructor(point: WorkflowFaultPoint, operation: string, hitCount: number) {
    super(`${operation} fault at ${point} (hit ${hitCount})`);
    this.name = "WorkflowFaultError";
    this.point = point;
    this.operation = operation;
    this.hitCount = hitCount;
  }
}

export function createWorkflowFaultHarness(
  armedPoint: WorkflowFaultPoint,
): WorkflowFaultHarness {
  const counts = new Map<WorkflowFaultPoint, number>();
  let armed = true;

  return {
    hit(point, operation = "workflow-operation") {
      const hitCount = (counts.get(point) ?? 0) + 1;
      counts.set(point, hitCount);
      if (armed && point === armedPoint) {
        armed = false;
        throw new WorkflowFaultError(point, operation, hitCount);
      }
    },
    count(point) {
      return counts.get(point) ?? 0;
    },
  };
}
