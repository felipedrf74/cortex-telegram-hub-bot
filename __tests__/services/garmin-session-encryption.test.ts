import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-store', () => ({
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  createAndPushNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserById: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getOwnerBootstrapUser: vi.fn(),
}));

vi.mock('../../src/utils/request-context', () => ({
  getCurrentContext: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      enabled: true,
      masterKey: 'test-garmin-encryption-key-at-least-32chars',
    },
    telegram: {
      allowedUserIds: [],
    },
  },
}));

import {
  encryptPlaintextGarminTokens,
  getGarminConnectionRecord,
  getGarminSession,
  markGarminConnectionActive,
  upsertGarminSession,
} from '../../src/services/garmin-session-store';

function createGarminTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE garmin_sessions (
      user_id INTEGER PRIMARY KEY,
      oauth1_token_json TEXT,
      oauth2_token_json TEXT,
      last_refreshed_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE garmin_user_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      garmin_email TEXT,
      tokens_json TEXT NOT NULL,
      last_refresh TEXT DEFAULT (datetime('now')),
      last_used TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

describe('garmin session encryption', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createGarminTables(testDb);
  });

  it('encrypts stored Garmin session token JSON while returning decrypted values to callers', () => {
    upsertGarminSession(86, {
      oauth1: { token: 'oauth1-secret' },
      oauth2: { access_token: 'oauth2-secret' },
    }, '2026-05-02T00:00:00Z');

    const raw = testDb.prepare(`
      SELECT oauth1_token_json, oauth2_token_json
      FROM garmin_sessions
      WHERE user_id = 86
    `).get() as { oauth1_token_json: string; oauth2_token_json: string };

    expect(raw.oauth1_token_json).toMatch(/^[0-9a-f]{56,}$/i);
    expect(raw.oauth2_token_json).toMatch(/^[0-9a-f]{56,}$/i);
    expect(raw.oauth1_token_json).not.toContain('oauth1-secret');
    expect(raw.oauth2_token_json).not.toContain('oauth2-secret');

    const session = getGarminSession(86);
    expect(JSON.parse(session!.oauth1TokenJson!)).toEqual({ token: 'oauth1-secret' });
    expect(JSON.parse(session!.oauth2TokenJson!)).toEqual({ access_token: 'oauth2-secret' });
  });

  it('encrypts Garmin account email metadata while returning decrypted records', () => {
    markGarminConnectionActive(86, 'athlete@example.com');

    const raw = testDb.prepare(`
      SELECT garmin_email, tokens_json
      FROM garmin_user_tokens
      WHERE user_id = 86
    `).get() as { garmin_email: string; tokens_json: string };

    expect(raw.garmin_email).toMatch(/^[0-9a-f]{56,}$/i);
    expect(raw.garmin_email).not.toContain('athlete@example.com');
    expect(raw.tokens_json).toMatch(/^[0-9a-f]{56,}$/i);

    expect(getGarminConnectionRecord(86)).toMatchObject({
      garminEmail: 'athlete@example.com',
      status: 'active',
    });
  });

  it('backfills legacy plaintext Garmin token and email rows in place', () => {
    testDb.prepare(`
      INSERT INTO garmin_sessions (user_id, oauth1_token_json, oauth2_token_json)
      VALUES (?, ?, ?)
    `).run(
      86,
      JSON.stringify({ token: 'legacy-oauth1' }),
      JSON.stringify({ access_token: 'legacy-oauth2' }),
    );
    testDb.prepare(`
      INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
      VALUES (?, ?, ?, 'active')
    `).run(
      86,
      'athlete@example.com',
      JSON.stringify({ oauth1: { token: 'legacy-oauth1' }, oauth2: { access_token: 'legacy-oauth2' } }),
    );

    const result = encryptPlaintextGarminTokens();

    expect(result).toEqual({
      scannedSessions: 1,
      encryptedSessions: 1,
      scannedUserTokens: 1,
      encryptedUserTokens: 1,
    });

    const rawSession = testDb.prepare(`
      SELECT oauth1_token_json, oauth2_token_json
      FROM garmin_sessions
      WHERE user_id = 86
    `).get() as { oauth1_token_json: string; oauth2_token_json: string };
    const rawUserToken = testDb.prepare(`
      SELECT garmin_email, tokens_json
      FROM garmin_user_tokens
      WHERE user_id = 86
    `).get() as { garmin_email: string; tokens_json: string };

    expect(rawSession.oauth1_token_json).toMatch(/^[0-9a-f]{56,}$/i);
    expect(rawSession.oauth2_token_json).toMatch(/^[0-9a-f]{56,}$/i);
    expect(rawUserToken.garmin_email).toMatch(/^[0-9a-f]{56,}$/i);
    expect(rawUserToken.tokens_json).toMatch(/^[0-9a-f]{56,}$/i);
    expect(JSON.stringify(rawSession)).not.toContain('legacy-oauth');
    expect(JSON.stringify(rawUserToken)).not.toContain('athlete@example.com');

    expect(JSON.parse(getGarminSession(86)!.oauth1TokenJson!)).toEqual({ token: 'legacy-oauth1' });
    expect(getGarminConnectionRecord(86)?.garminEmail).toBe('athlete@example.com');
  });
});
