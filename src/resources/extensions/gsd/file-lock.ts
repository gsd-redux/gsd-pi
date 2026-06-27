import { existsSync } from "node:fs";
import lockfile from "proper-lockfile";

export type OnLocked = "fail" | "skip";

export interface FileLockOptions {
  /**
   * Behavior when the lock cannot be acquired after retries (ELOCKED).
   * - "fail" (default): rethrow the ELOCKED error so the caller can react.
   * - "skip": run fn() unlocked. Only choose this for best-effort writes
   *   that genuinely tolerate contention (e.g. high-frequency audit appends
   *   where dropping one entry is acceptable). Silent unlocked execution was
   *   the legacy behavior and is a correctness hazard for shared state.
   */
  onLocked?: OnLocked;
  /** proper-lockfile retries (default 5). */
  retries?: number;
  /** proper-lockfile stale threshold in ms (default 10000). */
  stale?: number;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_STALE_MS = 10000;
const SYNC_RETRY_DELAY_MS = 50;

// Block the thread for `ms` milliseconds without spinning the CPU.
// Used by the sync lock retry loop, since proper-lockfile's lockSync does not
// accept a `retries` option (only the async `lock` does).
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLockSyncWithRetry(
  filePath: string,
  retries: number,
  stale: number,
): () => void {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return lockfile.lockSync(filePath, { stale });
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "ELOCKED") throw err;
      if (attempt < retries) sleepSync(SYNC_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  if (!existsSync(filePath)) return fn();

  const stale = opts.stale ?? DEFAULT_STALE_MS;
  const onLocked: OnLocked = opts.onLocked ?? "fail";
  const retries = onLocked === "skip" ? 0 : (opts.retries ?? DEFAULT_RETRIES);

  try {
    const release = acquireLockSyncWithRetry(filePath, retries, stale);
    try {
      return fn();
    } finally {
      release();
    }
  } catch (err: any) {
    if (err?.code === "ELOCKED" && onLocked === "skip") {
      return fn();
    }
    throw err;
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
  opts: FileLockOptions = {},
): Promise<T> {
  if (!existsSync(filePath)) return await fn();

  const retries = opts.retries ?? DEFAULT_RETRIES;
  const stale = opts.stale ?? DEFAULT_STALE_MS;
  const onLocked: OnLocked = opts.onLocked ?? "fail";

  try {
    const release = await lockfile.lock(filePath, { retries, stale });
    try {
      return await fn();
    } finally {
      await release();
    }
  } catch (err: any) {
    if (err?.code === "ELOCKED" && onLocked === "skip") {
      return await fn();
    }
    throw err;
  }
}
