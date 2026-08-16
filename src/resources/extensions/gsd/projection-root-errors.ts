// Project/App: gsd-pi
// File Purpose: Preserve typed transient projection-root lock failures across the native boundary.

const WINDOWS_SHARING_VIOLATION = /(?:transient projection root sharing violation|projection root operation failed:.*(?:os error 32|sharing violation))/i;

export class ProjectionLockTransientError extends Error {
  readonly failureKind = "projection-lock-transient" as const;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "ProjectionLockTransientError";
  }
}

export function isTransientProjectionLockError(error: unknown): boolean {
  // Walk the cause chain: a wrapped transient must classify identically to a
  // bare one on every consumer (#1762).
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    if (current instanceof ProjectionLockTransientError) return true;
    const message = current instanceof Error ? current.message : String(current ?? "");
    if (WINDOWS_SHARING_VIOLATION.test(message)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export function throwIfTransientProjectionLockError(error: unknown): void {
  if (isTransientProjectionLockError(error)) {
    throw error instanceof ProjectionLockTransientError
      ? error
      : new ProjectionLockTransientError(error);
  }
}
