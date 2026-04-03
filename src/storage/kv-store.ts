// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * KVStore — High-level key-value store backed by SQLite.
 *
 * Wraps the kv_store table with a clean interface for get/set/delete/list/has/clear.
 * Values are automatically JSON-serialized, so you can store strings, numbers,
 * objects, arrays, booleans, and null.
 *
 * Uses the existing database connection from getDb() — no new connections.
 * Auto-creates the kv_store table on first access if it doesn't exist.
 *
 * Usage:
 *   const kv = new KVStore();
 *   kv.set('user:123:prefs', { theme: 'dark', lang: 'pt-BR' });
 *   const prefs = kv.get<UserPrefs>('user:123:prefs');
 *   const userKeys = kv.list('user:123:');
 */

import { getDb } from '../services/database';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export interface KVEntry<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

// ─── KVStore Class ──────────────────────────────────────────────────

export class KVStore {
  private _initialized = false;

  /**
   * Ensure the kv_store table exists. Called lazily on first operation.
   * Safe to call multiple times — uses CREATE TABLE IF NOT EXISTS.
   */
  private ensureTable(): void {
    if (this._initialized) return;
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this._initialized = true;
  }

  /**
   * Get a value by key. Returns undefined if the key doesn't exist.
   * Automatically deserializes JSON.
   */
  get<T = unknown>(key: string): T | undefined {
    this.ensureTable();
    const db = getDb();
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  /**
   * Get a value with full metadata (key, value, updatedAt).
   */
  getEntry<T = unknown>(key: string): KVEntry<T> | undefined {
    this.ensureTable();
    const db = getDb();
    const row = db.prepare('SELECT key, value, updated_at FROM kv_store WHERE key = ?').get(key) as
      { key: string; value: string; updated_at: string } | undefined;
    if (!row) return undefined;
    try {
      return { key: row.key, value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
    } catch {
      return { key: row.key, value: row.value as unknown as T, updatedAt: row.updated_at };
    }
  }

  /**
   * Set a value. Uses UPSERT (INSERT OR REPLACE) so it works for both
   * new keys and updates. Values are JSON-serialized.
   */
  set<T = unknown>(key: string, value: T): void {
    this.ensureTable();
    const db = getDb();
    const serialized = JSON.stringify(value);
    db.prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, serialized);
  }

  /**
   * Delete a key. Returns true if the key existed and was deleted.
   */
  delete(key: string): boolean {
    this.ensureTable();
    const db = getDb();
    const result = db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /**
   * List keys matching a prefix. Returns keys only (not values).
   *
   * @param prefix - Key prefix to match (e.g., 'user:123:')
   * @returns Array of matching keys, sorted alphabetically
   */
  list(prefix: string): string[] {
    this.ensureTable();
    const db = getDb();
    const escaped = prefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = db.prepare(
      "SELECT key FROM kv_store WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
    ).all(`${escaped}%`) as { key: string }[];
    return rows.map(r => r.key);
  }

  /**
   * Check if a key exists.
   */
  has(key: string): boolean {
    this.ensureTable();
    const db = getDb();
    const row = db.prepare('SELECT 1 FROM kv_store WHERE key = ?').get(key);
    return row !== undefined;
  }

  /**
   * Delete all keys. Optionally accepts a prefix to only clear matching keys.
   * @returns Number of deleted keys.
   */
  clear(prefix?: string): number {
    this.ensureTable();
    const db = getDb();
    if (prefix) {
      const escaped = prefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const result = db.prepare("DELETE FROM kv_store WHERE key LIKE ? ESCAPE '\\'").run(`${escaped}%`);
      return result.changes;
    }
    const result = db.prepare('DELETE FROM kv_store').run();
    return result.changes;
  }

  /**
   * Execute multiple set/delete operations in a single transaction.
   * Atomic: either all succeed or none do.
   */
  batch(ops: Array<{ type: 'set'; key: string; value: unknown } | { type: 'delete'; key: string }>): number {
    this.ensureTable();
    const db = getDb();
    const trx = db.transaction(() => {
      let count = 0;
      for (const op of ops) {
        if (op.type === 'set') {
          this.set(op.key, op.value);
          count++;
        } else if (op.type === 'delete') {
          this.delete(op.key);
          count++;
        }
      }
      return count;
    });
    return trx();
  }

  /**
   * Get the number of keys in the store (optionally filtered by prefix).
   */
  count(prefix?: string): number {
    this.ensureTable();
    const db = getDb();
    if (prefix) {
      const escaped = prefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const row = db.prepare("SELECT COUNT(*) as c FROM kv_store WHERE key LIKE ? ESCAPE '\\'").get(`${escaped}%`) as { c: number };
      return row.c;
    }
    const row = db.prepare('SELECT COUNT(*) as c FROM kv_store').get() as { c: number };
    return row.c;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _kvStore: KVStore | null = null;

/** Get the singleton KVStore instance. */
export function getKV(): KVStore {
  if (!_kvStore) {
    _kvStore = new KVStore();
  }
  return _kvStore;
}

/** Clear the singleton (for tests). */
export function clearKV(): void {
  _kvStore = null;
}
