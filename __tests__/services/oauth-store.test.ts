/**
 * OAuth Store Tests
 *
 * Tests encrypted per-user token storage, CRUD operations,
 * provider connection status, and owner token migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    google: { clientId: 'gid', clientSecret: 'gsec', refreshToken: 'grt_test123' },
    outlook: { clientId: 'oid', clientSecret: 'osec', tenantId: 'common', refreshToken: 'ort_test456' },
    financeEncryption: { masterKey: '' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  storeTokens, getTokens, isConnected, disconnectProvider,
  getUserConnections, migrateOwnerTokens, ProviderNotConnectedError,
} from '../../src/services/oauth-store';

describe('oauth-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    // Clear env so encryption is disabled (plaintext mode for testing)
    delete process.env.OAUTH_ENCRYPTION_KEY;
    delete process.env.FINANCE_ENCRYPTION_KEY;
  });

  afterEach(() => {
    testDb?.close();
  });

  describe('storeTokens / getTokens', () => {
    it('stores and retrieves tokens', () => {
      storeTokens(123, 'google', {
        accessToken: 'at_123',
        refreshToken: 'rt_123',
        tokenType: 'Bearer',
        expiresAt: '2026-12-31T00:00:00Z',
        scopes: ['calendar', 'drive'],
      });

      const tokens = getTokens(123, 'google');
      expect(tokens).not.toBeNull();
      expect(tokens!.accessToken).toBe('at_123');
      expect(tokens!.refreshToken).toBe('rt_123');
      expect(tokens!.scopes).toEqual(['calendar', 'drive']);
    });

    it('returns null for non-connected provider', () => {
      expect(getTokens(123, 'google')).toBeNull();
    });

    it('upserts on repeated store', () => {
      storeTokens(123, 'google', {
        accessToken: 'v1', refreshToken: 'rt1', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      storeTokens(123, 'google', {
        accessToken: 'v2', refreshToken: 'rt2', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      const tokens = getTokens(123, 'google');
      expect(tokens!.accessToken).toBe('v2');
      expect(tokens!.refreshToken).toBe('rt2');
    });

    it('isolates tokens per user', () => {
      storeTokens(111, 'google', {
        accessToken: 'at_111', refreshToken: 'rt_111', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      storeTokens(222, 'google', {
        accessToken: 'at_222', refreshToken: 'rt_222', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      expect(getTokens(111, 'google')!.accessToken).toBe('at_111');
      expect(getTokens(222, 'google')!.accessToken).toBe('at_222');
    });

    it('isolates tokens per provider', () => {
      storeTokens(123, 'google', {
        accessToken: 'g_at', refreshToken: 'g_rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      storeTokens(123, 'outlook', {
        accessToken: 'o_at', refreshToken: 'o_rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      expect(getTokens(123, 'google')!.accessToken).toBe('g_at');
      expect(getTokens(123, 'outlook')!.accessToken).toBe('o_at');
    });
  });

  describe('isConnected', () => {
    it('returns false when not connected', () => {
      expect(isConnected(123, 'google')).toBe(false);
    });

    it('returns true when connected', () => {
      storeTokens(123, 'google', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      expect(isConnected(123, 'google')).toBe(true);
    });
  });

  describe('disconnectProvider', () => {
    it('removes tokens', () => {
      storeTokens(123, 'google', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      disconnectProvider(123, 'google');
      expect(isConnected(123, 'google')).toBe(false);
      expect(getTokens(123, 'google')).toBeNull();
    });
  });

  describe('getUserConnections', () => {
    it('returns all connected providers', () => {
      storeTokens(123, 'google', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: ['calendar'],
      });
      storeTokens(123, 'outlook', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: ['mail'],
      });

      const connections = getUserConnections(123);
      expect(connections).toHaveLength(2);
      expect(connections.map(c => c.provider)).toContain('google');
      expect(connections.map(c => c.provider)).toContain('outlook');
    });

    it('returns empty for unconnected user', () => {
      expect(getUserConnections(999)).toEqual([]);
    });
  });

  describe('migrateOwnerTokens', () => {
    it('migrates Google tokens from config', () => {
      // Seed owner user first
      testDb.prepare(`
        INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
        VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
      `).run();

      migrateOwnerTokens();
      expect(isConnected(111111, 'google')).toBe(true);
      const tokens = getTokens(111111, 'google');
      expect(tokens!.refreshToken).toBe('grt_test123');
    });

    it('migrates Outlook tokens from config', () => {
      testDb.prepare(`
        INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
        VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
      `).run();

      migrateOwnerTokens();
      expect(isConnected(111111, 'outlook')).toBe(true);
    });

    it('is idempotent — skips if already migrated', () => {
      testDb.prepare(`
        INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
        VALUES (111111, 'Owner', 'owner', 'active', 0, 0, 0)
      `).run();

      migrateOwnerTokens();
      migrateOwnerTokens(); // Second call should not throw
      expect(getUserConnections(111111)).toHaveLength(2);
    });
  });

  describe('ProviderNotConnectedError', () => {
    it('has correct name and message', () => {
      const err = new ProviderNotConnectedError('google');
      expect(err.name).toBe('ProviderNotConnectedError');
      expect(err.provider).toBe('google');
      expect(err.message).toContain('google');
      expect(err.message).toContain('/connect');
    });
  });

  describe('encryption', () => {
    it('encrypts tokens when OAUTH_ENCRYPTION_KEY is set', () => {
      process.env.OAUTH_ENCRYPTION_KEY = 'test-master-key-for-oauth-encrypt';
      storeTokens(123, 'google', {
        accessToken: 'secret_access_token',
        refreshToken: 'secret_refresh_token',
        tokenType: 'Bearer',
        expiresAt: null,
        scopes: [],
      });

      // Raw DB value should NOT be plaintext
      const row = testDb.prepare(
        'SELECT access_token, refresh_token FROM user_oauth_tokens WHERE user_id = 123'
      ).get() as any;
      expect(row.access_token).not.toBe('secret_access_token');
      expect(row.refresh_token).not.toBe('secret_refresh_token');

      // But getTokens should decrypt correctly
      const tokens = getTokens(123, 'google');
      expect(tokens!.accessToken).toBe('secret_access_token');
      expect(tokens!.refreshToken).toBe('secret_refresh_token');

      delete process.env.OAUTH_ENCRYPTION_KEY;
    });
  });
});
