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
  if (error instanceof ProjectionLockTransientError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return WINDOWS_SHARING_VIOLATION.test(message);
}

export function throwIfTransientProjectionLockError(error: unknown): void {
  if (isTransientProjectionLockError(error)) {
    throw error instanceof ProjectionLockTransientError
      ? error
      : new ProjectionLockTransientError(error);
  }
}
