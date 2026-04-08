// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * LRU (Least Recently Used) Map — drop-in replacement for a Map with a
 * hard size cap. When the map would exceed `maxSize`, the LEAST-recently
 * accessed entry is evicted.
 *
 * Used to bound caches that would otherwise grow monotonically for the
 * process lifetime. Examples in this codebase:
 *   - lastCoachStates in domain-handler.ts (per-user coach briefing state)
 *   - _alertCooldowns in error-monitor.ts (per-error-key alert throttle)
 *
 * Implementation leverages the fact that JavaScript's built-in Map
 * preserves insertion order. To mark an entry as "recently used", we
 * delete + re-insert it — which moves it to the end of the iteration
 * order. When eviction is needed, we pop the first key (oldest). This
 * is O(1) per operation and doesn't need any external dependency.
 *
 * NOT thread-safe (Node.js doesn't have threads in this sense) but is
 * safe across async operations because all mutations happen synchronously
 * within a single event-loop tick.
 */

export class LRUMap<K, V> {
  private map = new Map<K, V>();

  constructor(public readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error(`LRUMap: maxSize must be > 0, got ${maxSize}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Get a value and mark it as most-recently-used. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to most-recently-used position.
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  /** Set a value, evicting the LRU entry if over capacity. */
  set(key: K, value: V): this {
    // If already present, delete first so the re-insert lands at the
    // end of the iteration order (most-recently-used).
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict the oldest (first) entry.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Iteration (for tests / introspection). Iterates oldest → newest. */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }
}
