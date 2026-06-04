import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  getContentRadarPreferences,
  setContentRadarPreferences,
} from '../../src/services/content-radar-preferences';

describe('content radar preferences tenant scope', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  it('stores different radar preferences for the same owner in different tenants', () => {
    setContentRadarPreferences(42, ['AI workflows'], 1001);
    setContentRadarPreferences(42, ['Cycling nutrition'], 2002);

    expect(getContentRadarPreferences(42, 1001).topics).toEqual(['AI workflows']);
    expect(getContentRadarPreferences(42, 2002).topics).toEqual(['Cycling nutrition']);

    const rows = testDb.prepare(`
      SELECT tenant_id, owner_user_id, topics_json
      FROM content_radar_preferences
      ORDER BY tenant_id
    `).all() as Array<{ tenant_id: number; owner_user_id: number; topics_json: string }>;

    expect(rows).toEqual([
      { tenant_id: 1001, owner_user_id: 42, topics_json: '["AI workflows"]' },
      { tenant_id: 2002, owner_user_id: 42, topics_json: '["Cycling nutrition"]' },
    ]);
  });

  it('migrates the legacy user_id primary-key table shape before writing', () => {
    testDb.exec(`
      CREATE TABLE content_radar_preferences (
        user_id INTEGER PRIMARY KEY,
        topics_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO content_radar_preferences (user_id, topics_json)
      VALUES (77, '["legacy topic"]');
    `);

    expect(getContentRadarPreferences(77, 77).topics).toEqual(['legacy topic']);

    setContentRadarPreferences(77, ['tenant-local topic'], 7007);
    expect(getContentRadarPreferences(77, 7007).topics).toEqual(['tenant-local topic']);
    expect(getContentRadarPreferences(77, 77).topics).toEqual(['legacy topic']);
  });
});
