import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upSql = readFileSync(
  resolve(__dirname, '../../migrations/307_secretary_routine_profiles.sql'),
  'utf8',
);
const downSql = readFileSync(
  resolve(__dirname, '../../migrations/down/307_secretary_routine_profiles.sql'),
  'utf8',
);

function createBaseDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO users (id) VALUES (1)').run();
  return db;
}

describe('migration 307 Secretary routine profiles', () => {
  it('creates scoped profile and expiring receipt tables without inferring a row', () => {
    const db = createBaseDb();
    try {
      db.exec(upSql);

      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_profiles').get())
        .toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM secretary_routine_idempotency_receipts').get())
        .toEqual({ count: 0 });
      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_secretary_routine_receipts_expiry'
      `).get()).toEqual({ name: 'idx_secretary_routine_receipts_expiry' });

      expect(() => db.prepare(`
        INSERT INTO secretary_routine_profiles (
          user_id, tenant_id, version, working_windows_json,
          preferred_focus_windows_json, protected_routines_json,
          created_at, updated_at
        ) VALUES (1, 2, 1, '[]', '[]', '[]', 'now', 'now')
      `).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`
        INSERT INTO secretary_routine_profiles (
          user_id, tenant_id, version, working_windows_json,
          preferred_focus_windows_json, protected_routines_json,
          created_at, updated_at
        ) VALUES (1, 1, 1, 'not-json', '[]', '[]', 'now', 'now')
      `).run()).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('reverses both additive tables', () => {
    const db = createBaseDb();
    try {
      db.exec(upSql);
      db.exec(downSql);

      expect(db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'secretary_routine_%'
      `).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
