/**
 * QA Validation Tests — StorageProvider & SQLiteStorage
 *
 * Validates the StorageProvider interface and SQLiteStorage implementation
 * built by the flex agent.
 * Focuses on:
 *   1. Interface contract — duck typing, method signatures
 *   2. Edge cases — large data, concurrent transactions, re-open
 *   3. Error messages — clear and actionable
 *   4. Singleton lifecycle — set/get/clear ordering
 *   5. Database.ts integration changes (renamed from Cortex)
 *
 * QA agent: agent/qa
 * Validating: src/services/storage-provider.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SQLiteStorage,
  StorageProvider,
  getStorage,
  setStorageProvider,
  clearStorageProvider,
} from '../../src/services/storage-provider';

// ═══════════════════════════════════════════════════════════════════
// 1. INTERFACE COMPLIANCE — StorageProvider contract
// ═══════════════════════════════════════════════════════════════════

describe('QA: StorageProvider — interface compliance', () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage();
    storage.open(':memory:');
  });

  afterEach(() => {
    if (storage.initialized) storage.close();
  });

  it('name is "sqlite" for SQLiteStorage', () => {
    expect(storage.name).toBe('sqlite');
  });

  it('initialized is true after open', () => {
    expect(storage.initialized).toBe(true);
  });

  it('initialized is false before open', () => {
    const fresh = new SQLiteStorage();
    expect(fresh.initialized).toBe(false);
  });

  it('initialized is false after close', () => {
    storage.close();
    expect(storage.initialized).toBe(false);
  });

  it('prepare returns object with run, get, all methods', () => {
    const stmt = storage.prepare('SELECT 1');
    expect(typeof stmt.run).toBe('function');
    expect(typeof stmt.get).toBe('function');
    expect(typeof stmt.all).toBe('function');
  });

  it('exec returns void (no result)', () => {
    const result = storage.exec('SELECT 1');
    expect(result).toBeUndefined();
  });

  it('transaction returns the callback result', () => {
    const result = storage.transaction(() => 'hello');
    expect(result).toBe('hello');
  });

  it('pragma returns pragma value', () => {
    const fk = storage.pragma('foreign_keys');
    expect(fk).toBeDefined();
  });

  it('close returns void', () => {
    const result = storage.close();
    expect(result).toBeUndefined();
  });

  it('raw returns the underlying better-sqlite3 Database', () => {
    const raw = storage.raw();
    expect(raw).toBeDefined();
    expect(typeof raw.prepare).toBe('function');
    expect(typeof raw.exec).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. EDGE CASES — data handling
// ═══════════════════════════════════════════════════════════════════

describe('QA: SQLiteStorage — edge cases', () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage();
    storage.open(':memory:');
    storage.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT, num REAL)');
  });

  afterEach(() => {
    if (storage.initialized) storage.close();
  });

  it('handles NULL values in queries', () => {
    storage.prepare('INSERT INTO test (val, num) VALUES (?, ?)').run(null, null);
    const row = storage.prepare<{ val: string | null; num: number | null }>('SELECT val, num FROM test').get();
    expect(row!.val).toBeNull();
    expect(row!.num).toBeNull();
  });

  it('handles empty string values', () => {
    storage.prepare('INSERT INTO test (val) VALUES (?)').run('');
    const row = storage.prepare<{ val: string }>('SELECT val FROM test').get();
    expect(row!.val).toBe('');
  });

  it('handles very long string values', () => {
    const longStr = 'x'.repeat(100000);
    storage.prepare('INSERT INTO test (val) VALUES (?)').run(longStr);
    const row = storage.prepare<{ val: string }>('SELECT val FROM test').get();
    expect(row!.val.length).toBe(100000);
  });

  it('handles unicode/emoji in values', () => {
    const emoji = '🎉🚀🧪 Nexus Hub テスト';
    storage.prepare('INSERT INTO test (val) VALUES (?)').run(emoji);
    const row = storage.prepare<{ val: string }>('SELECT val FROM test').get();
    expect(row!.val).toBe(emoji);
  });

  it('handles large number of rows', () => {
    const insert = storage.prepare('INSERT INTO test (val) VALUES (?)');
    storage.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insert.run(`row-${i}`);
      }
    });
    const count = storage.prepare<{ c: number }>('SELECT COUNT(*) as c FROM test').get();
    expect(count!.c).toBe(1000);
  });

  it('handles floating point numbers', () => {
    storage.prepare('INSERT INTO test (num) VALUES (?)').run(3.14159);
    const row = storage.prepare<{ num: number }>('SELECT num FROM test').get();
    expect(row!.num).toBeCloseTo(3.14159);
  });

  it('handles negative numbers', () => {
    storage.prepare('INSERT INTO test (num) VALUES (?)').run(-42);
    const row = storage.prepare<{ num: number }>('SELECT num FROM test').get();
    expect(row!.num).toBe(-42);
  });
});

describe('QA: SQLiteStorage — configurable local pragmas', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses safe explicit SQLite pragmas for Docker/local bind-mounted DBs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sqlite-pragmas-'));
    const dbPath = path.join(dir, 'local.db');
    const storage = new SQLiteStorage();

    vi.stubEnv('SQLITE_JOURNAL_MODE', 'DELETE');
    vi.stubEnv('SQLITE_SYNCHRONOUS', 'FULL');
    vi.stubEnv('SQLITE_MMAP_SIZE', '0');

    try {
      storage.open(dbPath);
      expect(JSON.stringify(storage.pragma('journal_mode')).toLowerCase()).toContain('delete');
      expect(JSON.stringify(storage.pragma('synchronous'))).toContain('2');
      expect(JSON.stringify(storage.pragma('mmap_size'))).toContain('0');
    } finally {
      if (storage.initialized) storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to production defaults when unsafe/unknown pragma envs are supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sqlite-default-pragmas-'));
    const dbPath = path.join(dir, 'local.db');
    const storage = new SQLiteStorage();

    vi.stubEnv('SQLITE_JOURNAL_MODE', 'OFF');
    vi.stubEnv('SQLITE_SYNCHRONOUS', 'OFF');
    vi.stubEnv('SQLITE_MMAP_SIZE', '-1');

    try {
      storage.open(dbPath);
      expect(JSON.stringify(storage.pragma('journal_mode')).toLowerCase()).not.toContain('off');
      expect(JSON.stringify(storage.pragma('synchronous'))).not.toContain('0');
      expect(JSON.stringify(storage.pragma('mmap_size'))).toContain('268435456');
    } finally {
      if (storage.initialized) storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. ERROR HANDLING — clear messages
// ═══════════════════════════════════════════════════════════════════

describe('QA: SQLiteStorage — error handling', () => {
  it('throws descriptive error when not initialized', () => {
    const storage = new SQLiteStorage();
    expect(() => storage.prepare('SELECT 1')).toThrow('SQLiteStorage not initialized');
    expect(() => storage.exec('SELECT 1')).toThrow('SQLiteStorage not initialized');
    expect(() => storage.raw()).toThrow('SQLiteStorage not initialized');
    expect(() => storage.transaction(() => {})).toThrow('SQLiteStorage not initialized');
  });

  it('throws on invalid SQL in exec', () => {
    const storage = new SQLiteStorage();
    storage.open(':memory:');
    expect(() => storage.exec('INVALID SQL STATEMENT')).toThrow();
    storage.close();
  });

  it('throws on invalid SQL in prepare', () => {
    const storage = new SQLiteStorage();
    storage.open(':memory:');
    expect(() => storage.prepare('SELECT * FROM nonexistent_table').all()).toThrow();
    storage.close();
  });

  it('close is safe to call multiple times', () => {
    const storage = new SQLiteStorage();
    storage.open(':memory:');
    storage.close();
    expect(() => storage.close()).not.toThrow();
    expect(() => storage.close()).not.toThrow();
  });

  it('close is safe to call when never opened', () => {
    const storage = new SQLiteStorage();
    expect(() => storage.close()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. TRANSACTIONS — atomicity guarantees
// ═══════════════════════════════════════════════════════════════════

describe('QA: SQLiteStorage — transaction atomicity', () => {
  let storage: SQLiteStorage;

  beforeEach(() => {
    storage = new SQLiteStorage();
    storage.open(':memory:');
    storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  });

  afterEach(() => {
    if (storage.initialized) storage.close();
  });

  it('commits all inserts on success', () => {
    storage.transaction(() => {
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('a');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('b');
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('c');
    });
    const rows = storage.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(3);
  });

  it('rolls back all inserts on error', () => {
    try {
      storage.transaction(() => {
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('ok');
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('also ok');
        throw new Error('rollback!');
      });
    } catch {}
    const rows = storage.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(0);
  });

  it('propagates the error from failed transaction', () => {
    expect(() => {
      storage.transaction(() => {
        throw new Error('specific error');
      });
    }).toThrow('specific error');
  });

  it('returns value from successful transaction', () => {
    const result = storage.transaction(() => {
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('x');
      return { inserted: true, count: 1 };
    });
    expect(result).toEqual({ inserted: true, count: 1 });
  });

  it('nested transaction support (savepoints)', () => {
    // better-sqlite3 transactions support nesting via savepoints
    storage.transaction(() => {
      storage.prepare('INSERT INTO t (val) VALUES (?)').run('outer');
      storage.transaction(() => {
        storage.prepare('INSERT INTO t (val) VALUES (?)').run('inner');
      });
    });
    const rows = storage.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SINGLETON LIFECYCLE — ordering edge cases
// ═══════════════════════════════════════════════════════════════════

describe('QA: StorageProvider singleton — lifecycle', () => {
  afterEach(() => {
    clearStorageProvider();
  });

  it('getStorage throws before any provider is set', () => {
    expect(() => getStorage()).toThrow('StorageProvider not initialized');
  });

  it('setStorageProvider then getStorage returns same instance', () => {
    const s = new SQLiteStorage();
    s.open(':memory:');
    setStorageProvider(s);
    expect(getStorage()).toBe(s);
    s.close();
  });

  it('clearStorageProvider resets so getStorage throws', () => {
    const s = new SQLiteStorage();
    s.open(':memory:');
    setStorageProvider(s);
    clearStorageProvider();
    expect(() => getStorage()).toThrow();
    s.close();
  });

  it('can replace provider by calling setStorageProvider again', () => {
    const s1 = new SQLiteStorage();
    s1.open(':memory:');
    setStorageProvider(s1);

    const s2 = new SQLiteStorage();
    s2.open(':memory:');
    setStorageProvider(s2);

    expect(getStorage()).toBe(s2);
    s1.close();
    s2.close();
  });

  it('accepts mock provider (duck typing)', () => {
    const mock: StorageProvider = {
      name: 'test-mock',
      initialized: true,
      prepare: () => ({ run: () => ({} as any), get: () => undefined, all: () => [] }),
      exec: () => {},
      transaction: <T>(fn: () => T) => fn(),
      pragma: () => null,
      close: () => {},
    };
    setStorageProvider(mock);
    expect(getStorage().name).toBe('test-mock');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════════

describe('QA: storage-provider — module exports', () => {
  it('exports SQLiteStorage class', () => {
    expect(SQLiteStorage).toBeDefined();
    expect(typeof SQLiteStorage).toBe('function');
  });

  it('exports getStorage function', () => {
    expect(typeof getStorage).toBe('function');
  });

  it('exports setStorageProvider function', () => {
    expect(typeof setStorageProvider).toBe('function');
  });

  it('exports clearStorageProvider function', () => {
    expect(typeof clearStorageProvider).toBe('function');
  });
});
