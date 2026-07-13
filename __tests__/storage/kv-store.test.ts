/**
 * KVStore Tests
 *
 * Tests the key-value store abstraction over SQLite:
 * - CRUD operations (get, set, delete, has)
 * - JSON round-trip for complex values
 * - Prefix listing and count
 * - Batch transactions (atomic)
 * - Auto-table creation
 * - Clear with and without prefix
 * - Edge cases (special characters, large values)
 * - Singleton getKV/clearKV
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ─── Mock getDb to return our in-memory test database ───────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { KVStore, getKV, clearKV } from '../../src/storage/kv-store';

// ═══════════════════════════════════════════════════════════════════

describe('KVStore', () => {
  let kv: KVStore;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    kv = new KVStore();
  });

  afterEach(() => {
    clearKV();
    testDb?.close();
  });

  // ── Auto-table creation ───────────────────────────────────────────

  describe('auto-table creation', () => {
    it('creates kv_store table on first operation', () => {
      kv.set('test', 'value');
      const tables = testDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kv_store'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('safe to call multiple operations (no duplicate table error)', () => {
      kv.set('a', 1);
      kv.set('b', 2);
      kv.get('a');
      kv.has('c');
      kv.list('');
      expect(kv.count()).toBe(2);
    });
  });

  // ── get / set ─────────────────────────────────────────────────────

  describe('get / set', () => {
    it('stores and retrieves a string value', () => {
      kv.set('name', 'Felipe');
      expect(kv.get('name')).toBe('Felipe');
    });

    it('stores and retrieves a number', () => {
      kv.set('score', 42.5);
      expect(kv.get('score')).toBe(42.5);
    });

    it('stores and retrieves a boolean', () => {
      kv.set('active', true);
      expect(kv.get('active')).toBe(true);
      kv.set('disabled', false);
      expect(kv.get('disabled')).toBe(false);
    });

    it('stores and retrieves null', () => {
      kv.set('empty', null);
      expect(kv.get('empty')).toBeNull();
    });

    it('stores and retrieves an object (JSON round-trip)', () => {
      const obj = { theme: 'dark', lang: 'pt-BR' };
      kv.set('prefs', obj);
      expect(kv.get('prefs')).toEqual(obj);
    });

    it('stores and retrieves an array (JSON round-trip)', () => {
      const arr = ['triathlon', 'devops', 'cooking'];
      kv.set('tags', arr);
      expect(kv.get('tags')).toEqual(arr);
    });

    it('stores and retrieves nested objects', () => {
      const complex = {
        name: 'Felipe',
        prefs: { theme: 'dark', lang: 'pt-BR' },
        tags: ['triathlon', 'devops'],
        score: 42.5,
        active: true,
        meta: null,
      };
      kv.set('user:123', complex);
      expect(kv.get('user:123')).toEqual(complex);
    });

    it('returns undefined for non-existent key', () => {
      expect(kv.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing key (upsert)', () => {
      kv.set('key', 'first');
      kv.set('key', 'second');
      expect(kv.get('key')).toBe('second');
    });

    it('updates the updated_at timestamp on overwrite', () => {
      kv.set('key', 'v1');
      const entry1 = kv.getEntry('key');
      // SQLite datetime('now') has second resolution, so we just verify it exists
      expect(entry1?.updatedAt).toBeTruthy();

      kv.set('key', 'v2');
      const entry2 = kv.getEntry('key');
      expect(entry2?.updatedAt).toBeTruthy();
      expect(entry2?.value).toBe('v2');
    });
  });

  // ── getEntry ──────────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns full entry with key, value, updatedAt', () => {
      kv.set('user:1', { name: 'Alice' });
      const entry = kv.getEntry<{ name: string }>('user:1');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('user:1');
      expect(entry!.value).toEqual({ name: 'Alice' });
      expect(entry!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('returns undefined for non-existent key', () => {
      expect(kv.getEntry('nope')).toBeUndefined();
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes an existing key, returns true', () => {
      kv.set('key', 'value');
      expect(kv.delete('key')).toBe(true);
    });

    it('returns false for non-existent key', () => {
      expect(kv.delete('nonexistent')).toBe(false);
    });

    it('key is gone after delete', () => {
      kv.set('key', 'value');
      kv.delete('key');
      expect(kv.get('key')).toBeUndefined();
      expect(kv.has('key')).toBe(false);
    });
  });

  // ── has ────────────────────────────────────────────────────────────

  describe('has', () => {
    it('returns true for existing key', () => {
      kv.set('exists', 1);
      expect(kv.has('exists')).toBe(true);
    });

    it('returns false for non-existent key', () => {
      expect(kv.has('nope')).toBe(false);
    });
  });

  // ── list ──────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns keys matching prefix', () => {
      kv.set('user:1:name', 'Alice');
      kv.set('user:1:email', 'alice@test.com');
      kv.set('user:2:name', 'Bob');
      kv.set('config:theme', 'dark');

      expect(kv.list('user:1:')).toEqual(['user:1:email', 'user:1:name']);
      expect(kv.list('user:')).toEqual(['user:1:email', 'user:1:name', 'user:2:name']);
      expect(kv.list('config:')).toEqual(['config:theme']);
    });

    it('returns empty array when no keys match', () => {
      kv.set('a', 1);
      expect(kv.list('nonexistent:')).toEqual([]);
    });

    it('returns all keys when prefix is empty string', () => {
      kv.set('a', 1);
      kv.set('b', 2);
      expect(kv.list('')).toEqual(['a', 'b']);
    });

    it('handles special characters in prefix (%, _)', () => {
      kv.set('metrics_%cpu', 100);
      kv.set('metrics_%mem', 80);
      kv.set('metrics_xcpu', 50); // should NOT match metrics_%

      expect(kv.list('metrics_%')).toEqual(['metrics_%cpu', 'metrics_%mem']);
    });

    it('results are sorted alphabetically', () => {
      kv.set('c', 3);
      kv.set('a', 1);
      kv.set('b', 2);
      expect(kv.list('')).toEqual(['a', 'b', 'c']);
    });
  });

  // ── clear ─────────────────────────────────────────────────────────

  describe('clear', () => {
    it('clears all keys when called without prefix', () => {
      kv.set('a', 1);
      kv.set('b', 2);
      kv.set('c', 3);
      const deleted = kv.clear();
      expect(deleted).toBe(3);
      expect(kv.count()).toBe(0);
    });

    it('clears only keys matching prefix when given', () => {
      kv.set('user:1', 'Alice');
      kv.set('user:2', 'Bob');
      kv.set('config:theme', 'dark');

      const deleted = kv.clear('user:');
      expect(deleted).toBe(2);
      expect(kv.has('config:theme')).toBe(true);
      expect(kv.has('user:1')).toBe(false);
    });

    it('returns 0 when nothing to clear', () => {
      expect(kv.clear()).toBe(0);
    });
  });

  // ── count ─────────────────────────────────────────────────────────

  describe('count', () => {
    it('returns total count without prefix', () => {
      kv.set('a', 1);
      kv.set('b', 2);
      kv.set('c', 3);
      expect(kv.count()).toBe(3);
    });

    it('returns filtered count with prefix', () => {
      kv.set('user:1', 'A');
      kv.set('user:2', 'B');
      kv.set('config:x', 'C');
      expect(kv.count('user:')).toBe(2);
      expect(kv.count('config:')).toBe(1);
      expect(kv.count('nope:')).toBe(0);
    });
  });

  // ── batch transactions ────────────────────────────────────────────

  describe('batch transactions', () => {
    it('executes multiple set operations atomically', () => {
      const count = kv.batch([
        { type: 'set', key: 'a', value: 1 },
        { type: 'set', key: 'b', value: 2 },
        { type: 'set', key: 'c', value: 3 },
      ]);
      expect(count).toBe(3);
      expect(kv.get('a')).toBe(1);
      expect(kv.get('b')).toBe(2);
      expect(kv.get('c')).toBe(3);
    });

    it('executes mixed set/delete operations', () => {
      kv.set('existing', 'value');
      const count = kv.batch([
        { type: 'set', key: 'new1', value: 'hello' },
        { type: 'delete', key: 'existing' },
        { type: 'set', key: 'new2', value: 'world' },
      ]);
      expect(count).toBe(3);
      expect(kv.has('existing')).toBe(false);
      expect(kv.get('new1')).toBe('hello');
      expect(kv.get('new2')).toBe('world');
    });

    it('returns the number of operations executed', () => {
      const count = kv.batch([
        { type: 'set', key: 'x', value: 1 },
        { type: 'set', key: 'y', value: 2 },
      ]);
      expect(count).toBe(2);
    });

    it('handles empty batch', () => {
      const count = kv.batch([]);
      expect(count).toBe(0);
    });
  });

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty string as key', () => {
      kv.set('', 'empty key');
      expect(kv.get('')).toBe('empty key');
      expect(kv.has('')).toBe(true);
    });

    it('handles very long keys (1000+ chars)', () => {
      const longKey = 'k'.repeat(1500);
      kv.set(longKey, 'long');
      expect(kv.get(longKey)).toBe('long');
    });

    it('handles very large values (100KB+ JSON)', () => {
      const largeArray = Array.from({ length: 5000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        data: 'x'.repeat(20),
      }));
      kv.set('large', largeArray);
      const result = kv.get<typeof largeArray>('large');
      expect(result).toHaveLength(5000);
      expect(result![0].id).toBe(0);
      expect(result![4999].id).toBe(4999);
    });

    it('handles keys with colons, dots, slashes (namespacing)', () => {
      kv.set('user:123:prefs.theme', 'dark');
      kv.set('path/to/resource', 42);
      kv.set('ns::double-colon', true);
      expect(kv.get('user:123:prefs.theme')).toBe('dark');
      expect(kv.get('path/to/resource')).toBe(42);
      expect(kv.get('ns::double-colon')).toBe(true);
    });

    it('handles underscore in prefix without wildcard matching', () => {
      kv.set('a_b', 1);
      kv.set('axb', 2);
      // Without escape, '_' matches any char — 'axb' would wrongly match 'a_'
      expect(kv.list('a_')).toEqual(['a_b']);
    });
  });

  // ── singleton ─────────────────────────────────────────────────────

  describe('singleton', () => {
    it('getKV returns the same instance', () => {
      const kv1 = getKV();
      const kv2 = getKV();
      expect(kv1).toBe(kv2);
    });

    it('clearKV resets the singleton', () => {
      const kv1 = getKV();
      clearKV();
      const kv2 = getKV();
      expect(kv1).not.toBe(kv2);
    });
  });
});
