// Project/App: gsd-pi
// File Purpose: Transaction depth helper for the GSD database facade.

export interface DbTransactionControls {
  begin(): void;
  beginRead(): void;
  /** Starts a write transaction that obtains SQLite's reserved lock up front. */
  beginImmediate?(): void;
  commit(): void;
  rollback(): void;
}

export class DbTransactionRunner {
  private depth = 0;

  isInTransaction(): boolean {
    return this.depth > 0;
  }

  transaction<T>(controls: DbTransactionControls, fn: () => T): T {
    return this.runTransaction(controls, () => controls.begin(), fn);
  }

  /**
   * Run a BEGIN IMMEDIATE transaction through the same depth counter as regular
   * transactions so callers can compose it inside existing transaction scopes.
   */
  immediateTransaction<T>(controls: DbTransactionControls, fn: () => T): T {
    if (!controls.beginImmediate) {
      throw new Error("db transaction controls do not support immediate transactions");
    }

    return this.runTransaction(controls, () => controls.beginImmediate!(), fn);
  }

  readTransaction<T>(
    controls: DbTransactionControls,
    fn: () => T,
    logRollbackError: (error: Error) => void,
  ): T {
    return this.runTransaction(controls, () => controls.beginRead(), fn, logRollbackError);
  }

  private runTransaction<T>(
    controls: DbTransactionControls,
    begin: () => void,
    fn: () => T,
    logRollbackError?: (error: Error) => void,
  ): T {
    if (this.depth > 0) {
      return this.runNested(fn);
    }

    begin();
    this.depth++;
    try {
      const result = fn();
      controls.commit();
      return result;
    } catch (err) {
      this.rollback(controls, logRollbackError);
      throw err;
    } finally {
      this.depth--;
    }
  }

  private runNested<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private rollback(controls: DbTransactionControls, logRollbackError?: (error: Error) => void): void {
    if (!logRollbackError) {
      controls.rollback();
      return;
    }

    try {
      controls.rollback();
    } catch (rollbackErr) {
      logRollbackError(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
    }
  }
}

export function createDbTransactionRunner(): DbTransactionRunner {
  return new DbTransactionRunner();
}
