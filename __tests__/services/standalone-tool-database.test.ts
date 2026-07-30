import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  getDb,
  withDatabaseForTestAsync,
} from '../../src/services/database';
import { withStandaloneToolDatabaseAsync } from '../../src/services/standalone-tool-database';

describe('standalone operational-tool database binding', () => {
  it('binds work to an explicit process database and restores it', async () => {
    const db = new Database(':memory:');
    try {
      expect(() => getDb()).toThrow('Database not initialized');

      await expect(withStandaloneToolDatabaseAsync(db, async () => {
        expect(getDb()).toBe(db);
        await Promise.resolve();
        expect(getDb()).toBe(db);
        return 'bound';
      })).resolves.toBe('bound');

      expect(() => getDb()).toThrow('Database not initialized');
    } finally {
      db.close();
    }
  });

  it('refuses to replace an initialized process database', async () => {
    const db = new Database(':memory:');
    try {
      await withDatabaseForTestAsync(db, async () => {
        await expect(withStandaloneToolDatabaseAsync(db, async () => undefined))
          .rejects.toThrow(/requires an uninitialized process database/i);
        expect(getDb()).toBe(db);
      });
    } finally {
      db.close();
    }
  });

  it('restores the uninitialized database state when work rejects', async () => {
    const db = new Database(':memory:');
    const failure = new Error('standalone tool failed');
    try {
      await expect(withStandaloneToolDatabaseAsync(db, async () => {
        expect(getDb()).toBe(db);
        throw failure;
      })).rejects.toBe(failure);

      expect(() => getDb()).toThrow('Database not initialized');
    } finally {
      db.close();
    }
  });

  it('rejects an overlapping binding without disturbing the active scope', async () => {
    const activeDb = new Database(':memory:');
    const otherDb = new Database(':memory:');
    let releaseActiveScope!: () => void;
    const activeScopeGate = new Promise<void>((resolve) => {
      releaseActiveScope = resolve;
    });

    try {
      const active = withStandaloneToolDatabaseAsync(activeDb, async () => {
        expect(getDb()).toBe(activeDb);
        await activeScopeGate;
        expect(getDb()).toBe(activeDb);
      });

      await expect(withStandaloneToolDatabaseAsync(otherDb, async () => undefined))
        .rejects.toThrow(/requires an uninitialized process database/i);
      expect(getDb()).toBe(activeDb);

      releaseActiveScope();
      await active;
      expect(() => getDb()).toThrow('Database not initialized');
    } finally {
      releaseActiveScope?.();
      activeDb.close();
      otherDb.close();
    }
  });
});
