/**
 * LRU cache with TTL — zero external dependencies.
 *
 * - max: maximum entries before oldest is evicted
 * - ttlMs: time-to-live per entry
 *
 * Uses a Map (insertion-ordered) for O(1) LRU eviction:
 * on every access the entry is deleted and re-inserted at the tail.
 */
export class LRUTTLCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly store = new Map<string, { value: V; expiresAt: number }>();
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { max: number; ttlMs: number }) {
    this.max = options.max;
    this.ttlMs = options.ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh to tail (most-recently-used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  purgeStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  startPurgeInterval(intervalMs: number): void {
    if (this.purgeTimer !== null) return;
    this.purgeTimer = setInterval(() => this.purgeStale(), intervalMs);
    // Don't keep the process alive just for cache cleanup
    if (this.purgeTimer && typeof this.purgeTimer === "object" && "unref" in this.purgeTimer) {
      (this.purgeTimer as NodeJS.Timeout).unref();
    }
  }

  stopPurgeInterval(): void {
    if (this.purgeTimer !== null) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
