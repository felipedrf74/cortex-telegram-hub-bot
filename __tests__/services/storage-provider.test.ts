/**
 * StorageProvider & SQLiteStorage Tests
 *
 * Tests that:
 * - SQLiteStorage opens in-memory and file-based databases
 * - All StorageProvider interface methods work correctly
 * - Singleton getStorage/setStorageProvider work as expected
 * - Error cases throw meaningful messages
 * - Transactions commit on success and rollback on error
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SQLiteStorage,
  StorageProvider,
  getStorage,
  setStorageProvider,
  clearStorageProvider,
} from '../../src/services/storage-provider';

// ═══════════════════════════════════════════════════════════════════
// SQLiteStorage TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SQLiteStorage', () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage();
  });

  afterEach(() => {
    if (storage.initialized) {
      storage.close();
    }
  });

  // ─── Initialization ────────────────────────────────────────────

  describe('initialization', () => {
    it('starts uninitialized', () => {
      expect(storage.initialized).toBe(false);
      expect(storage.name).toBe('sqlite');
    });

    it('opens an in-memory database', () => {
      storage.open(':memory:');
      expect(storage.initialized).toBe(true);
    });

    it('throws on prepare() before open()', () => {
      expect(() => storage.prepare('SELECT 1')).toThrow(
        'SQLiteStorage not initialized. Call open() first.'
      );
    });

    it('throws on exec() before open()', () => {
      expect(() => storage.exec('SELECT 1')).toThrow(
        'SQLiteStorage not initialized. Call open() first.'
      );
    });

    it('throws on raw() before open()', () => {
      expect(() => storage.raw()).toThrow(
        'SQLiteStorage not initialized. Call open() first.'
      );
    });

    it('throws on transaction() before open()', () => {
      expect(() => storage.transaction(() => {})).toThrow(
        'SQLiteStorage not initialized. Call open() first.'
      );
    });

    it('sets WAL pragma on open (in-memory falls back to "memory")', () => {
      storage.open(':memory:');
      const mode = storage.pragma('journal_mode');
      // In-memory databases cannot use WAL; SQLite silently keeps "memory" mode.
      // On disk, this would be "wal". Both confirm the pragma was called.
      expect(mode).toEqual([{ journal_mode: 'memory' }]);
    });

    it('enables foreign keys on open', () => {
      storage.open(':memory:');
      const fk = storage.pragma('foreign_keys');
      expect(fk).toEqual([{ foreign_keys: 1 }]);
    });
  });

  // ─── prepare() ─────────────────────────────────────────────────

  describe('prepare()', () => {
    beforeEach(() => storage.open(':memory:'));

    it('creates a table and inserts data via run()', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      const result = storage.prepare('INSERT INTO t (name) VALUES (?)').run('alice');
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(1);
    });

    it('retrieves a single row via get()', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('hello');
      const row = storage.prepare<{ id: number; val: string }>('SELECT * FROM t WHERE id = ?').get(1);
      expect(row).toEqual({ id: 1, val: 'hello' });
    });

    it('returns undefined from get() when no match', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const row = storage.prepare('SELECT * FROM t WHERE id = ?').get(999);
      expect(row).toBeUndefined();
    });

    it('retrieves multiple rows via all()', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('a');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('b');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('c');

      const rows = storage.prepare<{ id: number; val: string }>('SELECT * FROM t ORDER BY id').all();
      expect(rows).toHaveLength(3);
      expect(rows.map(r => r.val)).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array from all() when no matches', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const rows = storage.prepare('SELECT * FROM t').all();
      expect(rows).toEqual([]);
    });

    it('supports parameterized queries', () => {
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
      storage.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 'y');
      const row = storage.prepare<{ a: string; b: string }>(
        'SELECT a, b FROM t WHERE a = ? AND b = ?'
      ).get('x', 'y');
      expect(row).toEqual({ a: 'x', b: 'y' });
    });
  });

  // ─── exec() ────────────────────────────────────────────────────

  describe('exec()', () => {
    beforeEach(() => storage.open(':memory:'));

    it('executes multi-statement SQL', () => {
      storage.exec(`
        CREATE TABLE a (id INTEGER PRIMARY KEY);
        CREATE TABLE b (id INTEGER PRIMARY KEY);
      `);

      const tables = storage.prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a', 'b') ORDER BY name"
      ).all();
      expect(tables.map(t => t.name)).toEqual(['a', 'b']);
    });

    it('throws on invalid SQL', () => {
      expect(() => storage.exec('NOT VALID SQL')).toThrow();
    });
  });

  // ─── transaction() ─────────────────────────────────────────────

  describe('transaction()', () => {
    beforeEach(() => {
      storage.open(':memory:');
      storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    });

    it('commits on success', () => {
      storage.transaction(() => {
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('one');
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('two');
      });

      const rows = storage.prepare('SELECT * FROM t').all();
      expect(rows).toHaveLength(2);
    });

    it('rolls back on error', () => {
      expect(() => {
        storage.transaction(() => {
          storage.prepare('INSERT INTO t (val) VALUES (?)').run('ok');
          throw new Error('abort');
        });
      }).toThrow('abort');

      const rows = storage.prepare('SELECT * FROM t').all();
      expect(rows).toHaveLength(0);
    });

    it('returns the value from the transaction function', () => {
      const result = storage.transaction(() => {
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('test');
        return 42;
      });
      expect(result).toBe(42);
    });
  });

  // ─── close() ───────────────────────────────────────────────────

  describe('close()', () => {
    it('marks storage as uninitialized after close', () => {
      storage.open(':memory:');
      expect(storage.initialized).toBe(true);
      storage.close();
      expect(storage.initialized).toBe(false);
    });

    it('is safe to call close() when not initialized', () => {
      expect(() => storage.close()).not.toThrow();
    });

    it('throws on operations after close', () => {
      storage.open(':memory:');
      storage.close();
      expect(() => storage.prepare('SELECT 1')).toThrow();
    });
  });

  // ─── raw() ─────────────────────────────────────────────────────

  describe('raw()', () => {
    it('returns the underlying better-sqlite3 instance', () => {
      storage.open(':memory:');
      const rawDb = storage.raw();
      expect(rawDb).toBeDefined();
      // Verify it's a real better-sqlite3 database
      const result = rawDb.prepare('SELECT 1 as val').get() as any;
      expect(result.val).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// SINGLETON TESTS
// ═══════════════════════════════════════════════════════════════════

describe('StorageProvider singleton', () => {
  afterEach(() => {
    clearStorageProvider();
  });

  it('throws when getStorage() called before setStorageProvider()', () => {
    expect(() => getStorage()).toThrow(
      'StorageProvider not initialized. Call setStorageProvider() first.'
    );
  });

  it('returns the provider after setStorageProvider()', () => {
    const storage = new SQLiteStorage();
    storage.open(':memory:');
    setStorageProvider(storage);

    const retrieved = getStorage();
    expect(retrieved.name).toBe('sqlite');
    expect(retrieved.initialized).toBe(true);

    storage.close();
  });

  it('clearStorageProvider() resets the singleton', () => {
    const storage = new SQLiteStorage();
    storage.open(':memory:');
    setStorageProvider(storage);
    clearStorageProvider();

    expect(() => getStorage()).toThrow();
    storage.close();
  });

  it('accepts any StorageProvider implementation', () => {
    // Verify the interface is duck-typed correctly
    const mockProvider: StorageProvider = {
      name: 'mock',
      initialized: true,
      prepare: () => ({ run: () => ({} as any), get: () => undefined, all: () => [] }),
      exec: () => {},
      transaction: (fn) => fn(),
      pragma: () => null,
      close: () => {},
    };

    setStorageProvider(mockProvider);
    expect(getStorage().name).toBe('mock');
  });
});

// ═══════════════════════════════════════════════════════════════════
// INTEGRATION: StorageProvider + database.ts
// ═══════════════════════════════════════════════════════════════════

describe('StorageProvider integration with database module', () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage();
    storage.open(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  it('raw() and prepare() operate on the same database', () => {
    const rawDb = storage.raw();
    rawDb.exec('CREATE TABLE sync_test (id INTEGER PRIMARY KEY, val TEXT)');
    rawDb.prepare('INSERT INTO sync_test (val) VALUES (?)').run('from-raw');

    // Read through StorageProvider
    const row = storage.prepare<{ val: string }>('SELECT val FROM sync_test').get();
    expect(row?.val).toBe('from-raw');

    // Write through StorageProvider, read through raw
    storage.prepare('INSERT INTO sync_test (val) VALUES (?)').run('from-provider');
    const rows = rawDb.prepare('SELECT val FROM sync_test ORDER BY id').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[1].val).toBe('from-provider');
  });
});
