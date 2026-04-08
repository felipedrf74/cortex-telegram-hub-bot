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
  assertOAuthEncryptionConfigured, encryptPlaintextOAuthTokens,
  _resetDecryptCacheForTests,
} from '../../src/services/oauth-store';

describe('oauth-store', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    // OAuth encryption is now mandatory at runtime (audit P0-7) — set a
    // deterministic test key so tests exercise the real encrypted path,
    // not the legacy plaintext fallback that no longer exists.
    process.env.OAUTH_ENCRYPTION_KEY = 'test-key-deterministic-for-vitest-32chars';
    delete process.env.FINANCE_ENCRYPTION_KEY;
    // Clear the decrypted-token LRU cache between cases so one test
    // can't pollute another's cache-hit assertions (Phase 0.C).
    _resetDecryptCacheForTests();
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
      // Override the beforeEach test key with a different one for this test
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
    });
  });

  describe('assertOAuthEncryptionConfigured (P0-7)', () => {
    it('throws when no encryption key is set', () => {
      delete process.env.OAUTH_ENCRYPTION_KEY;
      delete process.env.FINANCE_ENCRYPTION_KEY;
      expect(() => assertOAuthEncryptionConfigured()).toThrow(/OAUTH_ENCRYPTION_KEY/);
    });

    it('passes when OAUTH_ENCRYPTION_KEY is set', () => {
      process.env.OAUTH_ENCRYPTION_KEY = 'some-key';
      expect(() => assertOAuthEncryptionConfigured()).not.toThrow();
    });

    it('passes when only FINANCE_ENCRYPTION_KEY is set (legacy fallback)', () => {
      delete process.env.OAUTH_ENCRYPTION_KEY;
      process.env.FINANCE_ENCRYPTION_KEY = 'legacy-finance-key';
      expect(() => assertOAuthEncryptionConfigured()).not.toThrow();
    });
  });

  describe('encryptPlaintextOAuthTokens (P0-7 in-place migration)', () => {
    it('encrypts plaintext rows in place', () => {
      // Insert a plaintext row directly (simulating legacy data)
      testDb.prepare(`
        INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, expires_at, scopes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(999, 'google', '', '1//04plaintext_refresh_token_with_slashes', 'Bearer', null, '[]');

      const result = encryptPlaintextOAuthTokens();
      expect(result.scanned).toBe(1);
      expect(result.encryptedRows).toBe(1);
      expect(result.alreadyEncrypted).toBe(0);

      // Raw row should now be hex (encrypted)
      const row = testDb.prepare(
        'SELECT access_token, refresh_token FROM user_oauth_tokens WHERE user_id = 999'
      ).get() as { access_token: string; refresh_token: string };
      expect(row.refresh_token).not.toContain('//');
      expect(row.refresh_token).toMatch(/^[0-9a-f]+$/i);
      expect(row.refresh_token.length).toBeGreaterThanOrEqual(56);

      // And reading via getTokens decrypts back to plaintext
      const tokens = getTokens(999, 'google');
      expect(tokens!.refreshToken).toBe('1//04plaintext_refresh_token_with_slashes');
    });

    it('is idempotent (already-encrypted rows are skipped)', () => {
      // First insert + encrypt
      storeTokens(888, 'google', {
        accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAt: null, scopes: [],
      });
      const first = encryptPlaintextOAuthTokens();
      expect(first.encryptedRows).toBe(0); // already encrypted via storeTokens
      expect(first.alreadyEncrypted).toBe(1);

      // Run again — still no work
      const second = encryptPlaintextOAuthTokens();
      expect(second.encryptedRows).toBe(0);
      expect(second.alreadyEncrypted).toBe(1);
    });
  });

  // ── Decrypted-token cache (Phase 0.C audit trail bomb fix) ─────────
  //
  // These tests pin the cache behavior so a future refactor can't
  // silently re-introduce the per-request decrypt + audit-row pattern
  // that produced 10,670 oauth.outlook decrypt rows/day pre-fix.
  //
  // Cache-hit detection strategy: spy on testDb.prepare. Cache HITS
  // must NOT hit the 'SELECT * FROM user_oauth_tokens' code path at
  // all, so counting calls to that exact statement tells us whether
  // the cache served the read or the DB did.
  describe('decrypted token cache', () => {
    it('avoids a DB SELECT on repeated getTokens within the TTL', () => {
      storeTokens(555, 'outlook', {
        accessToken: 'at_cache', refreshToken: 'rt_cache', tokenType: 'Bearer',
        expiresAt: null, scopes: ['mail'],
      });

      // Install a spy that counts SELECT * FROM user_oauth_tokens calls
      const originalPrepare = testDb.prepare.bind(testDb);
      let selectCount = 0;
      (testDb as any).prepare = (sql: string) => {
        if (sql.includes('SELECT * FROM user_oauth_tokens')) {
          selectCount++;
        }
        return originalPrepare(sql);
      };

      // First read: cache miss → 1 DB SELECT
      expect(getTokens(555, 'outlook')!.refreshToken).toBe('rt_cache');
      expect(selectCount).toBe(1);

      // 50 more reads in rapid succession: all cache hits → still 1 SELECT
      for (let i = 0; i < 50; i++) {
        expect(getTokens(555, 'outlook')!.refreshToken).toBe('rt_cache');
      }
      expect(selectCount).toBe(1);
    });

    it('storeTokens invalidates the cache so re-auth is immediately visible', () => {
      storeTokens(777, 'google', {
        accessToken: 'at_v1', refreshToken: 'rt_v1', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      // Warm the cache
      expect(getTokens(777, 'google')!.refreshToken).toBe('rt_v1');

      // Simulate re-auth with fresh tokens
      storeTokens(777, 'google', {
        accessToken: 'at_v2', refreshToken: 'rt_v2', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      // Next read must see the NEW tokens (cache was invalidated)
      expect(getTokens(777, 'google')!.refreshToken).toBe('rt_v2');
    });

    it('disconnectProvider invalidates the cache so getTokens immediately returns null', () => {
      storeTokens(333, 'notion', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      expect(getTokens(333, 'notion')).not.toBeNull(); // warm the cache
      disconnectProvider(333, 'notion');
      // Cache was invalidated — next read goes to DB and gets null
      expect(getTokens(333, 'notion')).toBeNull();
    });

    it('keeps cache entries separate per provider for the same user', () => {
      storeTokens(444, 'google', {
        accessToken: 'at_g', refreshToken: 'rt_g', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      storeTokens(444, 'outlook', {
        accessToken: 'at_o', refreshToken: 'rt_o', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      expect(getTokens(444, 'google')!.refreshToken).toBe('rt_g');
      expect(getTokens(444, 'outlook')!.refreshToken).toBe('rt_o');

      // Re-reads still return the correct per-provider cached values
      // (no bleed between providers)
      expect(getTokens(444, 'google')!.refreshToken).toBe('rt_g');
      expect(getTokens(444, 'outlook')!.refreshToken).toBe('rt_o');
    });

    it('keeps cache entries separate per user for the same provider', () => {
      storeTokens(101, 'google', {
        accessToken: 'at_101', refreshToken: 'rt_101', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      storeTokens(102, 'google', {
        accessToken: 'at_102', refreshToken: 'rt_102', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });

      expect(getTokens(101, 'google')!.refreshToken).toBe('rt_101');
      expect(getTokens(102, 'google')!.refreshToken).toBe('rt_102');
      // Reading 101 again should NOT see 102's tokens
      expect(getTokens(101, 'google')!.refreshToken).toBe('rt_101');
    });

    it('returning null for missing provider does not corrupt cache', () => {
      // Cold lookup with no row: must return null and NOT cache a null
      expect(getTokens(999, 'google')).toBeNull();

      // Now a row is stored — the next lookup must return the real tokens
      // (not a stale null from the cache).
      storeTokens(999, 'google', {
        accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
        expiresAt: null, scopes: [],
      });
      expect(getTokens(999, 'google')!.refreshToken).toBe('rt');
    });
  });
});
